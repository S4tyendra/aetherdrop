// A room: one RTCPeerConnection to the other member carrying everything.
//
//   transceivers  0 mic · 1 camera · 2 screen · 3 screen audio
//                 (tracks swapped with replaceTrack, so toggling media never renegotiates)
//   data channels 0 ctrl · 1 chat · 2 game · 3 files · 4–6 file workers (unreliable)
//
// All data and media flow peer to peer. ICE uses STUN only, no TURN relay, so
// nothing but signaling ever reaches our server.

import { attachFiles, detachFiles, N_WORKERS } from "./files";
import { attachGame, detachGame } from "./games";
import { profile } from "./profile";
import { ICE, JOIN_ERRORS, createHub, handoff, type HubMsg, type PeerInfo, type RoomInfo, type Status } from "./signal";
import { Store } from "./store";
import { toast } from "./toast";

// ─── Quality presets ────────────────────────────────────────────────────────

export const CAM_QUALITY = {
  low: { label: "Low", detail: "360p · 0.4 Mbps", width: 640, height: 360, fps: 24, bitrate: 400_000 },
  standard: { label: "Standard", detail: "720p · 1.5 Mbps", width: 1280, height: 720, fps: 30, bitrate: 1_500_000 },
  high: { label: "High", detail: "1080p · 3 Mbps", width: 1920, height: 1080, fps: 30, bitrate: 3_000_000 },
} as const;
export type CamQuality = keyof typeof CAM_QUALITY;

export const SCREEN_MODE = {
  text: { label: "Sharp text", detail: "Full resolution · 15 fps · 3 Mbps", fps: 15, bitrate: 3_000_000, hint: "detail", pref: "maintain-resolution" },
  motion: { label: "Smooth motion", detail: "Up to 1080p · 30 fps · 4 Mbps", fps: 30, bitrate: 4_000_000, hint: "motion", pref: "maintain-framerate" },
} as const;
export type ScreenMode = keyof typeof SCREEN_MODE;

// ─── State ──────────────────────────────────────────────────────────────────

export type Phase = "connecting" | "gate" | "joining" | "in" | "gone" | "left";
export type Link = "none" | "connecting" | "direct" | "unstable" | "failed";
export type MediaFlags = { mic: boolean; cam: boolean; screen: boolean; screenAudio: boolean };
export type Section = "stage" | "files" | "chat" | "game";
export const SECTION_LABEL: Record<Section, string> = { stage: "the video", files: "files", chat: "the chat", game: "the game" };
export type ChatLine = { id: number; text: string; mine: boolean; at: number };
export type Stats = { camOut: string | null; screenOut: string | null; camIn: string | null; screenIn: string | null };

export type RoomState = {
  phase: Phase;
  roomId: string;
  info: RoomInfo | null;
  joinError: string | null;
  needPin: boolean;
  status: Status;
  selfId: string;
  peer: PeerInfo | null;
  peerAway: boolean;
  link: Link;
  local: MediaFlags;
  remote: MediaFlags;
  camQuality: CamQuality;
  screenMode: ScreenMode;
  localCam: MediaStream | null;
  localScreen: MediaStream | null;
  remoteCam: MediaStream | null;
  remoteScreen: MediaStream | null;
  remoteAudio: MediaStream | null;
  remoteScreenAudio: MediaStream | null;
  /** Section this visitor expanded; local only, the peer just gets told. */
  focus: Section | null;
  stats: Stats;
  /** Selected ICE path, e.g. "IPv6 · direct" */
  route: string | null;
  chat: ChatLine[];
  chatOpen: boolean;
};

const noMedia: MediaFlags = { mic: false, cam: false, screen: false, screenAudio: false };
const noStats: Stats = { camOut: null, screenOut: null, camIn: null, screenIn: null };

export const room = new Store<RoomState>({
  phase: "connecting",
  roomId: "",
  info: null,
  joinError: null,
  needPin: false,
  status: { tone: "muted", label: "Connecting" },
  selfId: "",
  peer: null,
  peerAway: false,
  link: "none",
  local: noMedia,
  remote: noMedia,
  camQuality: "standard",
  screenMode: "text",
  localCam: null,
  localScreen: null,
  remoteCam: null,
  remoteScreen: null,
  remoteAudio: null,
  remoteScreenAudio: null,
  focus: null,
  stats: noStats,
  route: null,
  chat: [],
  chatOpen: false,
});

const CLIENT = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

let pin = "";
let pc: RTCPeerConnection | null = null;
let offerer = false;
let iceBuf: RTCIceCandidateInit[] = [];
let tx: { audio: RTCRtpTransceiver; cam: RTCRtpTransceiver; screen: RTCRtpTransceiver; screenAudio: RTCRtpTransceiver | null } | null = null;
let ctrlDC: RTCDataChannel | null = null;
let chatDC: RTCDataChannel | null = null;
let micStream: MediaStream | null = null;
let iceTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let chatSeq = 0;

const set = (p: Partial<RoomState>) => room.set(p);

/** What to call the other person. */
export const peerName = (p: PeerInfo | null = room.get().peer) => p?.name?.trim() || "Your peer";

function refreshStatus() {
  const s = room.get();
  let status: Status;
  if (s.phase !== "in") status = s.status.tone === "lamp" ? s.status : { tone: "ok", label: "Signal online" };
  else if (!s.peer) status = { tone: "muted", label: "Waiting for someone to join" };
  else if (s.link === "direct")
    status = { tone: "ok", label: s.peerAway ? `Direct link, ${peerName()}'s signal dropped` : `Direct link to ${peerName()}${s.route ? ` over ${s.route}` : ""}` };
  else if (s.link === "unstable") status = { tone: "lamp", label: "Link unstable, recovering" };
  else if (s.link === "failed") status = { tone: "bad", label: "No direct route to peer" };
  else status = { tone: "lamp", label: `Linking to ${peerName()}` };
  set({ status });
}

// ─── Hub ────────────────────────────────────────────────────────────────────

const hub = createHub({
  onLost: (ms) => set({ status: { tone: "lamp", label: `Signal lost, retrying in ${Math.round(ms / 1000)}s` } }),
  onMessage: (m) => void onHub(m),
});

function sendJoin() {
  set({ phase: "joining", joinError: null });
  hub.send({ type: "join", room: room.get().roomId, pin, client: CLIENT, nick: profile.get().nick });
}

async function onHub(m: HubMsg) {
  const s = room.get();
  switch (m.type) {
    case "welcome": {
      set({ selfId: m.id });
      const info = m.rooms.find((r) => r.id === s.roomId) ?? null;
      if (s.phase === "in" || s.phase === "joining") {
        sendJoin(); // reconnected: take our seat back
      } else if (s.phase === "connecting") {
        if (!info) {
          set({ phase: "gone", info: null });
          break;
        }
        set({ info, phase: "gate", needPin: info.locked });
        const handed = handoff.take(s.roomId);
        if (handed !== null) {
          pin = handed;
          sendJoin();
        }
      }
      refreshStatus();
      break;
    }
    case "rooms": {
      if (s.phase === "gate" || s.phase === "joining") {
        const info = m.rooms.find((r) => r.id === s.roomId) ?? null;
        if (!info) set({ phase: "gone", info: null });
        else set({ info });
      }
      break;
    }
    case "joined": {
      set({ phase: "in", info: m.room, selfId: m.self, joinError: null, needPin: false });
      const p = m.peers[0] ?? null;
      if (p && pc && live() && room.get().peer?.client === p.client) {
        set({ peer: p, peerAway: false }); // our link survived the signaling blip
      } else {
        teardownPeer();
        set({ peer: p, peerAway: false });
        if (p) await startPeer(true); // newcomer offers
      }
      refreshStatus();
      break;
    }
    case "join-error": {
      if (m.reason === "not_found") set({ phase: "gone" });
      else
        set({
          phase: "gate",
          joinError: JOIN_ERRORS[m.reason] ?? m.reason,
          needPin: m.reason === "bad_pin" || m.reason === "pin_required" || room.get().needPin,
        });
      break;
    }
    case "peer-joined": {
      const prev = room.get().peer;
      if (pc && live() && prev?.client === m.peer.client) {
        set({ peer: m.peer, peerAway: false });
      } else {
        teardownPeer();
        set({ peer: m.peer, peerAway: false });
        toast(`${peerName(m.peer)} joined the room`);
      }
      refreshStatus();
      break;
    }
    case "peer-left": {
      if (pc && live()) {
        set({ peerAway: true }); // keep the direct link; their websocket may just be reconnecting
      } else {
        const name = peerName();
        teardownPeer();
        set({ peer: null });
        toast(`${name} left`);
      }
      refreshStatus();
      break;
    }
    case "signal":
      await onSignal(m.data);
      break;
  }
}

// ─── Peer connection ────────────────────────────────────────────────────────

const live = () => !!pc && (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed");

function signal(data: unknown) {
  hub.send({ type: "signal", data });
}

async function startPeer(asOfferer: boolean) {
  offerer = asOfferer;
  const conn = new RTCPeerConnection({ iceServers: ICE });
  pc = conn;
  iceBuf = [];
  set({ link: "connecting" });

  const mk = (label: string, id: number, opts: RTCDataChannelInit = {}) =>
    conn.createDataChannel(label, { negotiated: true, id, ordered: true, ...opts });
  ctrlDC = mk("ctrl", 0);
  chatDC = mk("chat", 1);
  const gameDC = mk("game", 2);
  const filesDC = mk("files", 3);
  const wrk = Array.from({ length: N_WORKERS }, (_, i) => mk(`wrk-${i}`, 4 + i, { ordered: false, maxRetransmits: 0 }));
  setupCtrl(ctrlDC);
  setupChat(chatDC);
  attachGame(gameDC);
  attachFiles(filesDC, wrk, () => peerName());

  conn.onicecandidate = (e) => e.candidate && signal({ candidate: e.candidate });
  conn.oniceconnectionstatechange = () => onIce(conn);

  if (asOfferer) {
    const t = {
      audio: conn.addTransceiver("audio", { direction: "sendrecv" }),
      cam: conn.addTransceiver("video", { direction: "sendrecv" }),
      screen: conn.addTransceiver("video", { direction: "sendrecv" }),
      screenAudio: conn.addTransceiver("audio", { direction: "sendrecv" }),
    };
    bindTransceivers(t);
    const offer = await conn.createOffer();
    await conn.setLocalDescription({ type: offer.type, sdp: stereo(offer.sdp) });
    signal({ sdp: conn.localDescription });
  }
  startStats();
}

function bindTransceivers(t: NonNullable<typeof tx>) {
  tx = t;
  set({
    remoteAudio: new MediaStream([t.audio.receiver.track]),
    remoteCam: new MediaStream([t.cam.receiver.track]),
    remoteScreen: new MediaStream([t.screen.receiver.track]),
    remoteScreenAudio: t.screenAudio ? new MediaStream([t.screenAudio.receiver.track]) : null,
  });
  void syncSenders();
}

async function onSignal(data: any) {
  if (data?.sdp) {
    const desc: RTCSessionDescriptionInit = data.sdp;
    if (desc.type === "offer") {
      if (!pc) await startPeer(false);
      const conn = pc!;
      await conn.setRemoteDescription(desc);
      if (!tx) {
        const ts = conn.getTransceivers();
        if (ts.length >= 3) {
          ts.forEach((t) => (t.direction = "sendrecv"));
          bindTransceivers({ audio: ts[0], cam: ts[1], screen: ts[2], screenAudio: ts[3] ?? null });
        }
      }
      await drainIce();
      const answer = await conn.createAnswer();
      await conn.setLocalDescription({ type: answer.type, sdp: stereo(answer.sdp) });
      signal({ sdp: conn.localDescription });
    } else if (desc.type === "answer" && pc) {
      await pc.setRemoteDescription(desc);
      await drainIce();
    }
  } else if (data?.candidate) {
    if (pc?.remoteDescription) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (e) {
        console.warn("ICE add", e);
      }
    } else iceBuf.push(data.candidate);
  }
}

/** Ask for stereo Opus so shared tab or system audio keeps both channels. */
function stereo(sdp = "") {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`(a=fmtp:${pt} [^\r\n]*)`, "g"), (line) => (line.includes("stereo=1") ? line : `${line};stereo=1;sprop-stereo=1`));
}

async function drainIce() {
  for (const c of iceBuf) {
    try {
      await pc!.addIceCandidate(c);
    } catch {}
  }
  iceBuf = [];
}

function clearIceTimer() {
  if (iceTimer) clearTimeout(iceTimer);
  iceTimer = null;
}

async function iceRestart() {
  if (!pc || !offerer) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription({ type: offer.type, sdp: stereo(offer.sdp) });
    signal({ sdp: pc.localDescription });
  } catch (e) {
    console.error("ICE restart failed", e);
  }
}

function onIce(conn: RTCPeerConnection) {
  if (conn !== pc) return;
  const st = conn.iceConnectionState;
  if (st === "connected" || st === "completed") {
    clearIceTimer();
    set({ link: "direct" });
    void syncSenders();
  } else if (st === "disconnected") {
    set({ link: "unstable" });
    clearIceTimer();
    iceTimer = setTimeout(() => {
      if (pc === conn && !live()) void iceRestart();
    }, 6000);
  } else if (st === "failed") {
    set({ link: "failed" });
    clearIceTimer();
    void iceRestart();
    iceTimer = setTimeout(() => {
      if (pc === conn && !live()) {
        const away = room.get().peerAway;
        teardownPeer();
        if (away) set({ peer: null, peerAway: false });
        else set({ link: "failed" });
        refreshStatus();
      }
    }, 15000);
  }
  refreshStatus();
}

function teardownPeer() {
  clearIceTimer();
  stopStats();
  if (pc) {
    pc.onicecandidate = pc.oniceconnectionstatechange = null;
    pc.close();
  }
  pc = null;
  tx = null;
  ctrlDC = chatDC = null;
  iceBuf = [];
  detachFiles();
  detachGame();
  set({ link: "none", route: null, remote: noMedia, remoteAudio: null, remoteScreenAudio: null, remoteCam: null, remoteScreen: null, stats: noStats, chatOpen: false });
}

// ─── Control + chat channels ────────────────────────────────────────────────

function ctrlSend(obj: unknown) {
  if (ctrlDC?.readyState === "open") ctrlDC.send(JSON.stringify(obj));
}

function announceMedia() {
  ctrlSend({ type: "media", ...room.get().local });
}

function setupCtrl(ch: RTCDataChannel) {
  ch.onopen = () => {
    announceMedia();
    toast(`Direct link to ${peerName()}`, "ok");
  };
  ch.onmessage = (e) => {
    let m: any;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === "media") set({ remote: { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen, screenAudio: !!m.screenAudio } });
    if (m.type === "nick" && typeof m.name === "string") {
      const peer = room.get().peer;
      if (peer) set({ peer: { ...peer, name: m.name.slice(0, 24) } });
      refreshStatus();
    }
    if (m.type === "focus" && m.section in SECTION_LABEL) {
      const sec = m.section as Section;
      toast(`${peerName()} expanded ${SECTION_LABEL[sec]}`, "info", room.get().focus === sec ? undefined : { label: "Expand too", run: () => setFocus(sec) });
    }
    if (m.type === "bye") {
      const name = peerName();
      teardownPeer();
      set({ peer: null, peerAway: false });
      toast(`${name} left`);
      refreshStatus();
    }
  };
}

function setupChat(ch: RTCDataChannel) {
  ch.onopen = () => set({ chatOpen: true });
  ch.onclose = () => set({ chatOpen: false });
  ch.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === "chat" && typeof m.text === "string") pushChat(m.text.slice(0, 4000), false);
    } catch {}
  };
}

function pushChat(text: string, mine: boolean) {
  set({ chat: [...room.get().chat, { id: ++chatSeq, text, mine, at: Date.now() }] });
}

export function sendChat(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (chatDC?.readyState !== "open") {
    toast("Chat opens once someone joins", "bad");
    return false;
  }
  chatDC.send(JSON.stringify({ type: "chat", text: t }));
  pushChat(t, true);
  return true;
}

// ─── Local media ────────────────────────────────────────────────────────────

const trackOf = (s: MediaStream | null) => s?.getTracks()[0] ?? null;
const videoOf = (s: MediaStream | null) => s?.getVideoTracks()[0] ?? null;
const audioOf = (s: MediaStream | null) => s?.getAudioTracks()[0] ?? null;
const SCREEN_AUDIO_BITRATE = 128_000;

async function setEncoding(sender: RTCRtpSender, bitrate: number, fps: number, pref?: RTCDegradationPreference) {
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) return; // not negotiated yet; syncSenders runs again on connect
    p.encodings[0].maxBitrate = bitrate;
    p.encodings[0].maxFramerate = fps;
    if (pref) (p as any).degradationPreference = pref;
    await sender.setParameters(p);
  } catch (e) {
    console.warn("setParameters", e);
  }
}

async function syncSenders() {
  if (!tx) return;
  const s = room.get();
  await tx.audio.sender.replaceTrack(trackOf(micStream));
  await tx.cam.sender.replaceTrack(trackOf(s.localCam));
  await tx.screen.sender.replaceTrack(videoOf(s.localScreen));
  if (tx.screenAudio) {
    await tx.screenAudio.sender.replaceTrack(audioOf(s.localScreen));
    try {
      const p = tx.screenAudio.sender.getParameters();
      if (p.encodings?.length) {
        p.encodings[0].maxBitrate = SCREEN_AUDIO_BITRATE;
        await tx.screenAudio.sender.setParameters(p);
      }
    } catch {}
  }
  const q = CAM_QUALITY[s.camQuality];
  const m = SCREEN_MODE[s.screenMode];
  await setEncoding(tx.cam.sender, q.bitrate, q.fps, "balanced");
  await setEncoding(tx.screen.sender, m.bitrate, m.fps, m.pref);
}

function setLocal(p: Partial<MediaFlags>) {
  set({ local: { ...room.get().local, ...p } });
  announceMedia();
}

export async function toggleMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    await tx?.audio.sender.replaceTrack(null);
    return setLocal({ mic: false });
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    await tx?.audio.sender.replaceTrack(trackOf(micStream));
    setLocal({ mic: true });
  } catch {
    toast("Microphone access was blocked", "bad");
  }
}

function camConstraints(q: CamQuality): MediaTrackConstraints {
  const p = CAM_QUALITY[q];
  return { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps } };
}

export async function toggleCam() {
  const s = room.get();
  if (s.localCam) {
    s.localCam.getTracks().forEach((t) => t.stop());
    set({ localCam: null });
    await tx?.cam.sender.replaceTrack(null);
    return setLocal({ cam: false });
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: camConstraints(s.camQuality) });
    set({ localCam: stream });
    setLocal({ cam: true });
    await syncSenders();
  } catch {
    toast("Camera access was blocked", "bad");
  }
}

export async function toggleScreen() {
  const s = room.get();
  if (s.localScreen) return stopScreen();
  try {
    const m = SCREEN_MODE[s.screenMode];
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: s.screenMode === "motion" ? { frameRate: { ideal: m.fps }, height: { max: 1080 } } : { frameRate: { ideal: m.fps } },
      // Tab audio (any OS) or system audio (Windows, ChromeOS) when the picker allows it.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
    } as DisplayMediaStreamOptions);
    const track = stream.getVideoTracks()[0];
    track.contentHint = m.hint;
    track.onended = () => void stopScreen();
    const sound = audioOf(stream);
    if (sound) sound.contentHint = "music";
    set({ localScreen: stream });
    setLocal({ screen: true, screenAudio: !!sound });
    if (!sound) toast("Sharing without sound. To include it, share a tab and keep Share tab audio on");
    await syncSenders();
  } catch {
    // user cancelled the picker
  }
}

async function stopScreen() {
  const s = room.get();
  s.localScreen?.getTracks().forEach((t) => t.stop());
  set({ localScreen: null });
  await tx?.screen.sender.replaceTrack(null);
  await tx?.screenAudio?.sender.replaceTrack(null);
  setLocal({ screen: false, screenAudio: false });
}

export async function setCamQuality(q: CamQuality) {
  set({ camQuality: q });
  const track = trackOf(room.get().localCam);
  if (track) await track.applyConstraints(camConstraints(q)).catch(() => {});
  await syncSenders();
}

export async function setScreenMode(mode: ScreenMode) {
  set({ screenMode: mode });
  const track = videoOf(room.get().localScreen);
  if (track) {
    const m = SCREEN_MODE[mode];
    track.contentHint = m.hint;
    await track
      .applyConstraints(mode === "motion" ? { frameRate: { ideal: m.fps }, height: { max: 1080 } } : { frameRate: { ideal: m.fps } })
      .catch(() => {});
  }
  await syncSenders();
}

// ─── Live stats ─────────────────────────────────────────────────────────────

const prevBytes = new Map<string, { bytes: number; t: number }>();

async function rtpStats(key: string, target: RTCRtpSender | RTCRtpReceiver, kind: "outbound-rtp" | "inbound-rtp") {
  if (!target.track || target.track.readyState !== "live") return null;
  const report = await target.getStats();
  let line: string | null = null;
  report.forEach((r: any) => {
    if (r.type !== kind || r.kind !== "video") return;
    const bytes = kind === "outbound-rtp" ? r.bytesSent : r.bytesReceived;
    const prev = prevBytes.get(key);
    prevBytes.set(key, { bytes, t: r.timestamp });
    if (!prev || !r.frameWidth) return;
    const kbps = ((bytes - prev.bytes) * 8) / (r.timestamp - prev.t);
    const rate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
    line = `${r.frameWidth}×${r.frameHeight} · ${Math.round(r.framesPerSecond ?? 0)} fps · ${rate}`;
  });
  return line;
}

/** Which address family the nominated candidate pair uses. Browsers gather
 *  IPv4 and IPv6 candidates and rank IPv6 higher, so v6 wins when both ends have it. */
async function selectedRoute(conn: RTCPeerConnection): Promise<string | null> {
  const report = await conn.getStats();
  let pairId: string | undefined;
  report.forEach((r: any) => {
    if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
  });
  if (!pairId) report.forEach((r: any) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded" && (pairId = r.id));
  const pair: any = pairId && report.get(pairId);
  const local: any = pair && report.get(pair.localCandidateId);
  const remote: any = pair && report.get(pair.remoteCandidateId);
  if (!local) return null;
  const addr: string = local.address ?? local.ip ?? remote?.address ?? remote?.ip ?? "";
  const fam = addr.includes(":") ? "IPv6" : addr ? "IPv4" : null;
  if (!fam) return null;
  return local.candidateType === "host" && remote?.candidateType === "host" ? `${fam}, same network` : fam;
}

function startStats() {
  stopStats();
  statsTimer = setInterval(async () => {
    if (!tx || !live() || !pc) return;
    const route = await selectedRoute(pc);
    if (route !== room.get().route) {
      set({ route });
      refreshStatus();
    }
    const s = room.get();
    set({
      stats: {
        camOut: s.localCam ? await rtpStats("co", tx.cam.sender, "outbound-rtp") : null,
        screenOut: s.localScreen ? await rtpStats("so", tx.screen.sender, "outbound-rtp") : null,
        camIn: s.remote.cam ? await rtpStats("ci", tx.cam.receiver, "inbound-rtp") : null,
        screenIn: s.remote.screen ? await rtpStats("si", tx.screen.receiver, "inbound-rtp") : null,
      },
    });
  }, 2000);
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  prevBytes.clear();
}

// ─── Public ─────────────────────────────────────────────────────────────────

/** Expand one section for this visitor and let the other person know. */
export function setFocus(section: Section | null) {
  set({ focus: section });
  if (section) ctrlSend({ type: "focus", section });
}

export function join(withPin: string) {
  pin = withPin;
  sendJoin();
}

export function leave() {
  ctrlSend({ type: "bye" });
  hub.send({ type: "leave" });
  teardownPeer();
  const s = room.get();
  micStream?.getTracks().forEach((t) => t.stop());
  s.localCam?.getTracks().forEach((t) => t.stop());
  s.localScreen?.getTracks().forEach((t) => t.stop());
  set({ phase: "left" });
  location.href = "/";
}

let started = false;
export function startRoom(id: string) {
  if (started) return;
  started = true;
  set({ roomId: id });
  window.addEventListener("pagehide", () => ctrlSend({ type: "bye" }));
  let nick = profile.get().nick;
  profile.subscribe(() => {
    const next = profile.get().nick;
    if (next === nick) return;
    nick = next;
    ctrlSend({ type: "nick", name: nick });
    // Same-room join is a no-op on the hub apart from refreshing our name for later joiners.
    if (room.get().phase === "in") hub.send({ type: "join", room: room.get().roomId, pin, client: CLIENT, nick });
  });
  hub.connect();
}
