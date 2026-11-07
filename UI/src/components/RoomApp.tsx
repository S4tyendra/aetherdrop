import {
  ArrowLeft,
  Check,
  Link as LinkIcon,
  Lock,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  SendHorizontal,
  SlidersHorizontal,
  UserRound,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CAM_QUALITY,
  SCREEN_MODE,
  SECTION_LABEL,
  join,
  leave,
  peerName,
  room,
  sendChat,
  setFocus,
  setCamQuality,
  setScreenMode,
  startRoom,
  toggleCam,
  toggleMic,
  toggleScreen,
  type CamQuality,
  type ScreenMode,
  type Section,
} from "../lib/room";
import { profile } from "../lib/profile";
import { normalizeCode, normalizePin } from "../lib/signal";
import { useStore } from "../lib/store";
import { CallSign } from "./CallSign";
import { FilesPanel } from "./FilesPanel";
import { GamePanel } from "./GamePanel";
import { Shell } from "./Shell";
import { Button, Card, Dot, ICON, cx } from "./ui";

export default function RoomApp() {
  const s = useStore(room);
  const { nick } = useStore(profile);

  // Join once we know what to call this visitor (Shell asks on the first visit).
  useEffect(() => {
    const id = normalizeCode(
      new URLSearchParams(location.search).get("r") ?? "",
    );
    if (!id) location.replace("/");
    else if (nick) startRoom(id);
  }, [nick]);

  return (
    <Shell tagline={s.info?.name ?? "Room"} status={s.status}>
      {s.phase === "in" ? <InRoom /> : <Gate />}
    </Shell>
  );
}

// ─── Before joining ─────────────────────────────────────────────────────────

function Gate() {
  const s = useStore(room);
  const [pin, setPin] = useState("");
  const full = !!s.info && s.info.members >= s.info.max;

  if (s.phase === "gone")
    return (
      <Card className="mx-auto mt-12 max-w-sm animate-enter text-center">
        <p className="text-base text-fg">This room doesn't exist anymore</p>
        <p className="mt-2 text-sm text-fg-3">
          Rooms close after 10 minutes with nobody in them
        </p>
        <a href="/" className="mt-6 inline-flex">
          <Button variant="primary">Back to rooms</Button>
        </a>
      </Card>
    );

  return (
    <Card className="mx-auto mt-12 max-w-sm animate-enter">
      <div className="flex items-center gap-2 text-sm text-fg-2">
        {s.info?.locked && (
          <Lock size={14} strokeWidth={1.5} className="text-fg-3" />
        )}
        {s.info
          ? `${s.info.members} of ${s.info.max} here`
          : "Finding the room"}
      </div>
      <h1 className="mt-2 truncate text-2xl font-medium text-fg">
        {s.info?.name ?? "Room"}
      </h1>
      <div className="mt-4">
        <CallSign value={s.roomId} label={`Room code ${s.roomId}`} />
      </div>

      <form
        className="mt-6 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          join(pin);
        }}
      >
        {s.needPin && (
          <input
            autoFocus
            value={pin}
            onChange={(e) => setPin(normalizePin(e.target.value))}
            inputMode="numeric"
            type="password"
            placeholder="PIN"
            aria-label="Room PIN"
            className="h-10 w-full rounded-[10px] border border-line-2 bg-deep px-3 font-mono text-sm tracking-[0.2em] text-fg outline-none placeholder:text-fg-3 focus:border-fg-3"
          />
        )}
        {s.joinError && <p className="text-sm text-bad">{s.joinError}</p>}
        <Button
          type="submit"
          variant="primary"
          disabled={
            !s.info ||
            full ||
            s.phase === "joining" ||
            s.phase === "connecting" ||
            (s.needPin && pin.length < 4)
          }
        >
          {full
            ? "Room is full"
            : s.phase === "joining"
              ? "Joining"
              : "Join room"}
        </Button>
      </form>
    </Card>
  );
}

// ─── In the room ────────────────────────────────────────────────────────────

function InRoom() {
  const s = useStore(room);
  const [copied, setCopied] = useState(false);

  const copyLink = () =>
    navigator.clipboard.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  return (
    <div className="animate-enter">
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <a
          href="/"
          className="flex h-8 items-center gap-2 text-sm text-fg-2 hover:text-fg"
          aria-label="Back to rooms"
        >
          <ArrowLeft {...ICON} />
          <span className="hidden sm:inline">Rooms</span>
        </a>
        <h1 className="min-w-0 truncate text-xl font-medium text-fg">
          {s.info?.name}
        </h1>
        <CallSign value={s.roomId} size="sm" label={`Room code ${s.roomId}`} />
        {s.info?.locked && (
          <Lock
            size={14}
            strokeWidth={1.5}
            className="text-fg-3"
            aria-label="PIN protected"
          />
        )}
        {s.peer && (
          <span className="truncate text-sm text-fg-3">
            with {peerName(s.peer)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={copyLink}>
            {copied ? (
              <Check {...ICON} className="text-ok" />
            ) : (
              <LinkIcon {...ICON} />
            )}
            Copy link
          </Button>
          <Button size="sm" variant="danger" onClick={leave}>
            Leave
          </Button>
        </div>
      </div>

      {s.focus ? (
        <div className="flex flex-col gap-6">
          <div
            key={s.focus}
            className="flex min-w-0 animate-enter flex-col gap-6"
          >
            {section(s.focus, true)}
          </div>
          <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
            {SECTIONS.filter((x) => x !== s.focus).map((x) => (
              <div key={x} className="flex min-w-0 flex-col gap-6">
                {section(x, false)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-6">
            {section("stage", false)}
            {section("files", false)}
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            {section("chat", false)}
            {section("game", false)}
          </div>
        </div>
      )}
    </div>
  );
}

const SECTIONS: Section[] = ["stage", "files", "chat", "game"];

function section(sec: Section, wide: boolean) {
  const expand = <ExpandButton section={sec} />;
  switch (sec) {
    case "stage":
      return <Stage wide={wide} expand={expand} />;
    case "files":
      return <FilesPanel expand={expand} />;
    case "chat":
      return <Chat wide={wide} expand={expand} />;
    case "game":
      return <GamePanel wide={wide} expand={expand} />;
  }
}

/** Expands a section for this visitor only; the other person gets a heads-up. */
function ExpandButton({ section }: { section: Section }) {
  const { focus } = useStore(room);
  const on = focus === section;
  const Icon = on ? Minimize2 : Maximize2;
  const label = on
    ? "Back to the full room"
    : `Expand ${SECTION_LABEL[section]}`;
  return (
    <button
      onClick={() => setFocus(on ? null : section)}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors duration-150 hover:bg-raised hover:text-fg"
    >
      <Icon {...ICON} />
    </button>
  );
}

function VideoEl({
  stream,
  muted,
  mirror,
  className,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream)
      ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={cx("size-full", mirror && "-scale-x-100", className)}
    />
  );
}

/** Mic and shared screen audio play through separate elements so both are heard. */
function RemoteAudio({
  mic,
  screen,
}: {
  mic: MediaStream | null;
  screen: MediaStream | null;
}) {
  const micRef = useRef<HTMLAudioElement>(null);
  const screenRef = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    for (const [el, stream] of [
      [micRef.current, mic],
      [screenRef.current, screen],
    ] as const) {
      if (!el || el.srcObject === stream) continue;
      el.srcObject = stream;
      if (stream) el.play().catch(() => setBlocked(true));
    }
  }, [mic, screen]);
  const resume = () =>
    Promise.all(
      [micRef.current, screenRef.current].map(
        (el) => el?.srcObject && el.play(),
      ),
    )
      .then(() => setBlocked(false))
      .catch(() => {});
  return (
    <>
      <audio ref={micRef} autoPlay />
      <audio ref={screenRef} autoPlay />
      {blocked && (
        <Button
          variant="primary"
          size="sm"
          className="absolute top-3 left-1/2 z-10 -translate-x-1/2"
          onClick={resume}
        >
          <Volume2 {...ICON} />
          Turn on sound
        </Button>
      )}
    </>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-deep/85 px-2 py-0.5 text-xs leading-5 text-fg-2">
      {children}
    </span>
  );
}

function Stage({ wide, expand }: { wide: boolean; expand: ReactNode }) {
  const s = useStore(room);
  const name = peerName(s.peer);
  const main: "screen" | "cam" | null = s.remote.screen
    ? "screen"
    : s.remote.cam
      ? "cam"
      : null;
  const peerStats =
    main === "screen"
      ? s.stats.screenIn
      : main === "cam"
        ? s.stats.camIn
        : null;

  const thumbs: {
    key: string;
    label: string;
    stream: MediaStream | null;
    mirror?: boolean;
    contain?: boolean;
  }[] = [];
  if (main === "screen" && s.remote.cam)
    thumbs.push({ key: "pc", label: `${name}'s camera`, stream: s.remoteCam });
  if (s.localCam)
    thumbs.push({ key: "lc", label: "You", stream: s.localCam, mirror: true });
  if (s.localScreen)
    thumbs.push({
      key: "ls",
      label: s.local.screenAudio ? "Your screen, with sound" : "Your screen",
      stream: s.localScreen,
      contain: true,
    });

  const empty = !s.peer
    ? "Waiting for someone to join"
    : s.link !== "direct"
      ? s.link === "failed"
        ? "No direct route between your networks"
        : `Linking to ${name}`
      : `${name}'s camera is off`;

  return (
    <Card>
      <div
        className="relative mx-auto aspect-video w-full overflow-hidden rounded-xl bg-deep"
        style={
          wide ? { maxWidth: "calc((100dvh - 240px) * 16 / 9)" } : undefined
        }
      >
        <RemoteAudio mic={s.remoteAudio} screen={s.remoteScreenAudio} />
        <div className="absolute top-2 right-2 z-10 rounded-lg bg-deep/85">
          {expand}
        </div>
        {/* Both remote videos stay mounted so switching views is instant. */}
        <VideoEl
          stream={s.remoteScreen}
          muted
          className={cx("object-contain", main !== "screen" && "hidden")}
        />
        <VideoEl
          stream={s.remoteCam}
          muted
          className={cx("object-cover", main !== "cam" && "hidden")}
        />
        {!main && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <UserRound size={18} strokeWidth={1.5} className="text-fg-3" />
            <p className="text-sm text-fg-3">{empty}</p>
          </div>
        )}
        {main && (
          <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2">
            <Tag>{main === "screen" ? `${name}'s screen` : name}</Tag>
            {main === "screen" && s.remote.screenAudio && (
              <Tag>
                <span className="flex items-center gap-1">
                  <Volume2 size={12} strokeWidth={1.5} />
                  Sound
                </span>
              </Tag>
            )}
            {!s.remote.mic && <Tag>Muted</Tag>}
            {peerStats && (
              <Tag>
                <span className="font-mono tabular">{peerStats}</span>
              </Tag>
            )}
          </div>
        )}
      </div>

      {thumbs.length > 0 && (
        <div className="mt-3 flex gap-3">
          {thumbs.map((t) => (
            <div
              key={t.key}
              className="relative aspect-video w-40 overflow-hidden rounded-lg border border-line bg-deep sm:w-48"
            >
              <VideoEl
                stream={t.stream}
                muted
                mirror={t.mirror}
                className={t.contain ? "object-contain" : "object-cover"}
              />
              <span className="absolute bottom-1.5 left-1.5">
                <Tag>{t.label}</Tag>
              </span>
            </div>
          ))}
        </div>
      )}

      <Controls />
    </Card>
  );
}

function Toggle({
  on,
  onClick,
  icon,
  children,
  danger,
}: {
  on: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <Button
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        on && !danger && "border-line-2 bg-hover",
        danger && "text-bad",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{children}</span>
    </Button>
  );
}

function Controls() {
  const s = useStore(room);
  const [open, setOpen] = useState(false);
  const out = [
    s.stats.camOut && `Camera ${s.stats.camOut}`,
    s.stats.screenOut && `Screen ${s.stats.screenOut}`,
  ].filter(Boolean);

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Toggle
        on={s.local.mic}
        onClick={toggleMic}
        danger={!s.local.mic}
        icon={s.local.mic ? <Mic {...ICON} /> : <MicOff {...ICON} />}
      >
        {s.local.mic ? "Mic on" : "Mic off"}
      </Toggle>
      <Toggle
        on={s.local.cam}
        onClick={toggleCam}
        icon={s.local.cam ? <Video {...ICON} /> : <VideoOff {...ICON} />}
      >
        {s.local.cam ? "Camera on" : "Camera off"}
      </Toggle>
      <Toggle
        on={s.local.screen}
        onClick={toggleScreen}
        icon={<MonitorUp {...ICON} />}
      >
        {s.local.screen ? "Stop sharing" : "Share screen"}
      </Toggle>
      <div className="relative">
        <Button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <SlidersHorizontal {...ICON} />
          <span className="hidden sm:inline">Quality</span>
        </Button>
        {open && <QualityMenu onClose={() => setOpen(false)} />}
      </div>
      {out.length > 0 && (
        <span className="ml-auto hidden font-mono text-xs text-fg-3 tabular md:inline">
          {out.join(" · ")}
        </span>
      )}
    </div>
  );
}

function QualityMenu({ onClose }: { onClose: () => void }) {
  const s = useStore(room);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) =>
      !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Video quality"
      className="absolute bottom-full left-0 z-20 mb-2 w-72 animate-enter rounded-xl border border-line-2 bg-raised p-2 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
    >
      <Group label="Camera">
        {(Object.keys(CAM_QUALITY) as CamQuality[]).map((k) => (
          <Option
            key={k}
            selected={s.camQuality === k}
            onClick={() => setCamQuality(k)}
            label={CAM_QUALITY[k].label}
            detail={CAM_QUALITY[k].detail}
          />
        ))}
      </Group>
      <div className="my-2 border-t border-line" />
      <Group label="Screen sharing">
        {(Object.keys(SCREEN_MODE) as ScreenMode[]).map((k) => (
          <Option
            key={k}
            selected={s.screenMode === k}
            onClick={() => setScreenMode(k)}
            label={SCREEN_MODE[k].label}
            detail={SCREEN_MODE[k].detail}
          />
        ))}
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label}>
      <div className="px-2 pt-1 pb-2 text-xs text-fg-3">{label}</div>
      {children}
    </div>
  );
}

function Option({
  selected,
  onClick,
  label,
  detail,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  detail: string;
}) {
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-hover",
        selected && "bg-hover",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {selected && (
          <Check size={14} strokeWidth={1.5} className="text-lamp" />
        )}
      </span>
      <span className="flex-1 text-sm text-fg">{label}</span>
      <span className="font-mono text-xs text-fg-3">{detail}</span>
    </button>
  );
}

// Survives the remount when sections are expanded or collapsed.
let chatDraft = "";

function Chat({ wide, expand }: { wide: boolean; expand: ReactNode }) {
  const { chat: lines, chatOpen: open, peer } = useStore(room);
  const [text, setTextState] = useState(() => chatDraft);
  const setText = (v: string) => setTextState((chatDraft = v));
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines.length]);

  const submit = () => {
    if (sendChat(text)) setText("");
  };

  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {peer ? `Chat with ${peerName(peer)}` : "Chat"}
          </span>
          <Dot tone={open ? "ok" : "muted"} />
        </span>
      }
      aside={expand}
    >
      <div
        ref={box}
        className={cx(
          "flex flex-col gap-2 overflow-y-auto rounded-xl bg-deep p-4",
          wide ? "h-[max(20rem,calc(100dvh-340px))]" : "h-80",
        )}
      >
        {lines.length === 0 ? (
          <p className="m-auto text-sm text-fg-3">
            {open ? "No messages yet" : "Chat opens once someone joins"}
          </p>
        ) : (
          lines.map((l) => (
            <div
              key={l.id}
              className={cx(
                "flex animate-enter",
                l.mine ? "justify-end" : "justify-start",
              )}
            >
              <p
                className={cx(
                  "max-w-[85%] rounded-xl px-3 py-2 text-sm leading-5 break-words whitespace-pre-wrap",
                  l.mine ? "bg-raised text-fg" : "border border-line text-fg",
                )}
              >
                {l.text}
              </p>
            </div>
          ))
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={!open}
          placeholder="Message"
          aria-label="Message"
          maxLength={4000}
          className="h-10 min-w-0 flex-1 rounded-[10px] border border-line-2 bg-deep px-3 text-sm text-fg outline-none transition-[border-color] duration-150 placeholder:text-fg-3 focus:border-fg-3 disabled:opacity-50"
        />
        <Button
          variant="primary"
          onClick={submit}
          disabled={!open}
          aria-label="Send"
          className="w-10 px-0"
        >
          <SendHorizontal {...ICON} />
        </Button>
      </div>
    </Card>
  );
}
