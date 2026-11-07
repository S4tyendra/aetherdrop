// File transfer over the room's peer connection: one ordered control channel
// plus N unreliable worker channels carrying Reed-Solomon coded shards.
//
// Resume: every 512 KB block has a SHA-256, and a file's ID is the SHA-256 of
// those block hashes, so the same bytes always get the same ID whatever their
// name, room or session. The receiver keeps verified blocks on disk (stash.ts)
// and, when a file arrives, answers with the blocks it already holds; only the
// rest is sent.
//
//   sender                                receiver
//   hashes (1024 blocks per message) ───►
//   transfer-init {fileId, ...}       ───► checks hashes against fileId, looks up stored blocks
//                                     ◄─── transfer-ready {have: bitmap}
//   shards of missing blocks          ───► rebuild, verify SHA-256, store
//   sent-all                          ───►
//                                     ◄─── request-missing | transfer-complete
//   transfer-cancel                   ◄──► either side gives up (stored blocks stay)

import { BLOCK_SIZE, K, M, N, SHARD_SIZE, encodeBlock, reconstructBlock } from "./fec";
import { askPersist, getMeta, heldBlocks, putBlock, putMeta, readFile, saveFile } from "./stash";
import { Store } from "./store";
import { toast } from "./toast";

export const N_WORKERS = 3;
export const CELL = { EMPTY: 0, GOT: 1, REBUILT: 2, HELD: 3 } as const;
const HASH = 32;
const HASHES_PER_MSG = 1024;
const MAX_BLOCKS = 1 << 22; // 2 TB

export type Phase = "preparing" | "waiting" | "sending" | "paused" | "done";

export type XferView = {
  kind: "tx" | "rx";
  phase: Phase;
  /** Who the transfer is with, remembered so it still reads right after they leave. */
  peer: string;
  /** Hashing progress while preparing, 0 to 1. */
  prep: number;
  fileName: string;
  fileSize: number;
  bytesDone: number;
  /** Bytes the receiver already had when this session started. */
  heldBytes: number;
  pct: number;
  speed: number | null;
  eta: number | null;
  lostPkts: number;
  lossPct: number;
  rebuilt: number;
  totalBlocks: number;
  cells: Uint8Array;
  rev: number;
  done: boolean;
};

export type HistoryEntry = {
  id: string;
  fileName: string;
  fileSize: number;
  dir: "sent" | "received";
  ok: boolean;
  speed: number;
  duration: number;
};

export type FilesState = {
  ready: boolean;
  tx: XferView | null;
  rx: XferView | null;
  /** Content ID of the file being received, so the stash list can protect it. */
  rxFileId: string | null;
  txStreams: (string | null)[];
  rxStreams: (string | null)[];
  history: HistoryEntry[];
};

type TxSession = {
  sessionId: string;
  peer: string;
  file: File;
  fileId: string;
  fileName: string;
  fileSize: number;
  totalBlocks: number;
  hashes: Uint8Array;
  phase: Phase;
  prep: number;
  held: Set<number>;
  heldBytes: number;
  queue: { blockIdx: number; shardIdx: number }[];
  workerFree: boolean[];
  /** Encoded shards of blocks in flight, read from the file on demand. */
  encoded: Map<number, Promise<Uint8Array[]>>;
  /** Shards still queued per block; the encoding is dropped when it hits 0. */
  owed: Map<number, number>;
  dataSent: Set<number>[];
  dataSentCount: number;
  cells: Uint8Array;
  t0: number;
  complete: boolean;
};

/** 0 waiting for shards, 1 verifying and writing, 2 stored on disk */
type RxBlock = { received: Map<number, Uint8Array>; state: 0 | 1 | 2 };

type RxSession = {
  sessionId: string;
  peer: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  totalBlocks: number;
  hashes: Uint8Array;
  phase: Phase;
  blocks: RxBlock[];
  stored: number;
  heldBytes: number;
  writes: Set<Promise<void>>;
  cells: Uint8Array;
  rebuilt: number;
  pktsReceived: number;
  pktsLost: number;
  t0: number;
  complete: boolean;
};

const idle = () => Array<string | null>(N_WORKERS).fill(null);

export const files = new Store<FilesState>({
  ready: false,
  tx: null,
  rx: null,
  rxFileId: null,
  txStreams: idle(),
  rxStreams: idle(),
  history: [],
});

let ctrl: RTCDataChannel | null = null;
let workers: (RTCDataChannel | null)[] = Array(N_WORKERS).fill(null);
let peerLabel: () => string = () => "your peer";
let TX: TxSession | null = null;
let RX: RxSession | null = null;
let rev = 0;

// ─── Bytes, hashes, bitmaps ─────────────────────────────────────────────────

const blockLen = (i: number, size: number) => Math.max(0, Math.min(BLOCK_SIZE, size - i * BLOCK_SIZE));
const blockCount = (size: number) => Math.max(1, Math.ceil(size / BLOCK_SIZE));
const sha256 = async (data: BufferSource) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sameHash(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function bitmap(n: number, has: (i: number) => boolean) {
  const bits = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (has(i)) bits[i >> 3] |= 1 << (i & 7);
  return b64(bits);
}
const bit = (bits: Uint8Array, i: number) => ((bits[i >> 3] ?? 0) >> (i & 7)) & 1;

// ─── Views (throttled) ──────────────────────────────────────────────────────

function view(kind: "tx" | "rx", s: TxSession | RxSession, progress: number, prep = 1, lostPkts = 0, lossPct = 0, rebuilt = 0): XferView {
  const bytesDone = Math.min(Math.round(progress * s.fileSize), s.fileSize);
  const live = s.phase === "sending" || s.phase === "done";
  const elapsed = (Date.now() - s.t0) / 1000;
  const fresh = bytesDone - s.heldBytes;
  const rate = live && (s.complete || elapsed > 0.5) && fresh > 0 && elapsed > 0 ? fresh / elapsed : null;
  return {
    kind,
    phase: s.phase,
    peer: s.peer,
    prep,
    fileName: s.fileName,
    fileSize: s.fileSize,
    bytesDone,
    heldBytes: s.heldBytes,
    pct: Math.round(progress * 100),
    speed: rate,
    eta: s.complete ? 0 : rate ? (s.fileSize - bytesDone) / rate : null,
    lostPkts,
    lossPct,
    rebuilt,
    totalBlocks: s.totalBlocks,
    cells: s.cells,
    rev: rev++,
    done: s.complete,
  };
}

function txView() {
  if (!TX) return null;
  const total = TX.totalBlocks * K;
  const done = TX.held.size * K + TX.dataSentCount;
  return view("tx", TX, TX.complete ? 1 : total ? Math.min(done / total, 1) : 0, TX.prep);
}

function rxView() {
  if (!RX) return null;
  const useful = RX.blocks.reduce((s, b) => s + (b.state ? K : Math.min(b.received.size, K)), 0);
  const total = RX.totalBlocks * K;
  const pkts = RX.pktsReceived + RX.pktsLost;
  return view("rx", RX, RX.complete ? 1 : total ? useful / total : 0, 1, RX.pktsLost, pkts ? (RX.pktsLost / pkts) * 100 : 0, RX.rebuilt);
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function emit(now = false) {
  const run = () => {
    flushTimer = null;
    files.set({ tx: txView(), rx: rxView(), rxFileId: RX && !RX.complete ? RX.fileId : null });
  };
  if (now) {
    if (flushTimer) clearTimeout(flushTimer);
    return run();
  }
  if (!flushTimer) flushTimer = setTimeout(run, 100);
}

const pending = { tx: idle(), rx: idle() };
let streamTimer: ReturnType<typeof setTimeout> | null = null;
function setStream(kind: "tx" | "rx", i: number, text: string | null) {
  pending[kind][i] = text;
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    files.set({ txStreams: [...pending.tx], rxStreams: [...pending.rx] });
  }, 100);
}
function clearStreams(kind: "tx" | "rx") {
  for (let i = 0; i < N_WORKERS; i++) setStream(kind, i, null);
}

function addHistory(s: TxSession | RxSession, dir: HistoryEntry["dir"], ok: boolean) {
  const duration = (Date.now() - s.t0) / 1000;
  const moved = s.fileSize - s.heldBytes;
  const entry: HistoryEntry = { id: s.sessionId, fileName: s.fileName, fileSize: s.fileSize, dir, ok, speed: duration > 0 ? moved / duration : 0, duration };
  files.set((st) => ({ history: [entry, ...st.history.filter((h) => h.id !== entry.id)] }));
}

function finishStreams(kind: "tx" | "rx", stillDone: () => boolean) {
  for (let i = 0; i < N_WORKERS; i++) {
    setStream(kind, i, "Done");
    setTimeout(() => stillDone() && setStream(kind, i, null), 3000);
  }
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

const allOpen = () => !!ctrl && ctrl.readyState === "open" && workers.every((w) => w && w.readyState === "open");

function refreshReady() {
  const ready = allOpen();
  if (files.get().ready !== ready) files.set({ ready });
  if (!ready || !TX || TX.complete) return;
  if (TX.phase === "paused") offer(TX); // the link is back: pick up where we stopped
  else if (TX.phase === "sending" && TX.workerFree.every(Boolean) && TX.queue.length) startSending();
}

/** Bind the engine to the room's channels (negotiated, so both sides call this). */
export function attachFiles(control: RTCDataChannel, wrk: RTCDataChannel[], peerName?: () => string) {
  ctrl = control;
  workers = wrk;
  if (peerName) peerLabel = peerName;
  control.onopen = refreshReady;
  control.onclose = refreshReady;
  control.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    void handleCtrl(msg);
  };
  wrk.forEach((ch, i) => {
    ch.binaryType = "arraybuffer";
    ch.onopen = refreshReady;
    ch.onclose = refreshReady;
    ch.onmessage = (ev) => onShard(ev.data, i);
  });
  refreshReady();
}

/** The link is gone. Unfinished transfers pause: blocks already stored stay on disk,
 *  and a send resumes on its own when the peer is back. */
export function detachFiles() {
  ctrl = null;
  workers = Array(N_WORKERS).fill(null);
  if (TX && !TX.complete && TX.phase !== "preparing") pauseTx(TX);
  if (RX && !RX.complete) pauseRx(RX);
  clearStreams("tx");
  clearStreams("rx");
  files.set({ ready: false });
  emit(true);
}

function pauseTx(tx: TxSession) {
  tx.phase = "paused";
  tx.queue = [];
  tx.encoded.clear();
  tx.owed.clear();
}

function pauseRx(rx: RxSession) {
  rx.phase = "paused";
  rx.blocks.forEach((b, i) => {
    if (b.state === 0 && b.received.size) {
      b.received.clear();
      rx.cells.fill(CELL.EMPTY, i * N, (i + 1) * N);
    }
  });
}

function ctrlSend(obj: unknown) {
  if (ctrl && ctrl.readyState === "open") ctrl.send(JSON.stringify(obj));
}

// ─── Control protocol ───────────────────────────────────────────────────────

/** Hash list parts that arrive ahead of transfer-init. */
let inbox: { sessionId: string; parts: { from: number; data: Uint8Array }[] } = { sessionId: "", parts: [] };

async function handleCtrl(msg: any) {
  switch (msg?.type) {
    case "hashes": {
      if (typeof msg.sessionId !== "string" || !Number.isInteger(msg.from) || typeof msg.data !== "string") return;
      if (inbox.sessionId !== msg.sessionId) inbox = { sessionId: msg.sessionId, parts: [] };
      inbox.parts.push({ from: msg.from, data: unb64(msg.data) });
      break;
    }
    case "transfer-init":
      await onInit(msg);
      break;
    case "transfer-ready":
      onReady(msg);
      break;
    case "sent-all": {
      const rx = RX;
      if (!rx || msg.sessionId !== rx.sessionId) return;
      await Promise.all(rx.writes);
      if (RX !== rx) return;
      const missing: { blockIdx: number; need: number; have: number[] }[] = [];
      rx.blocks.forEach((b, i) => {
        if (b.state === 0) missing.push({ blockIdx: i, need: K - b.received.size, have: [...b.received.keys()] });
      });
      if (!missing.length) await finishRx(rx);
      else {
        rx.pktsLost += missing.reduce((s, m) => s + m.need, 0);
        ctrlSend({ type: "request-missing", sessionId: rx.sessionId, missing });
        emit();
      }
      break;
    }
    case "request-missing": {
      const tx = TX;
      if (!tx || msg.sessionId !== tx.sessionId || !Array.isArray(msg.missing)) return;
      for (const { blockIdx, need, have } of msg.missing) {
        if (!Number.isInteger(blockIdx) || blockIdx < 0 || blockIdx >= tx.totalBlocks) continue;
        const skip = new Set<number>(Array.isArray(have) ? have : []);
        const candidates = Array.from({ length: N }, (_, i) => i).filter((i) => !skip.has(i));
        const n = Math.min(Math.max(0, need | 0), candidates.length);
        for (let i = 0; i < n; i++) tx.queue.push({ blockIdx, shardIdx: candidates[i] });
        tx.owed.set(blockIdx, (tx.owed.get(blockIdx) ?? 0) + n);
      }
      startSending();
      break;
    }
    case "transfer-complete": {
      const tx = TX;
      if (!tx || msg.sessionId !== tx.sessionId) return;
      tx.complete = true;
      tx.phase = "done";
      tx.encoded.clear();
      addHistory(tx, "sent", true);
      toast(`Sent ${tx.fileName}`, "ok");
      emit(true);
      finishStreams("tx", () => !TX || TX.complete);
      break;
    }
    case "transfer-cancel": {
      if (TX && msg.sessionId === TX.sessionId && !TX.complete) {
        addHistory(TX, "sent", false);
        toast(msg.reason === "storage" ? `${TX.peer} ran out of storage` : `${TX.peer} stopped ${TX.fileName}`, "bad");
        TX = null;
        clearStreams("tx");
      }
      if (RX && msg.sessionId === RX.sessionId && !RX.complete) {
        pauseRx(RX);
        toast(`${RX.peer} stopped sending ${RX.fileName}. What arrived is kept`);
        clearStreams("rx");
      }
      emit(true);
      break;
    }
  }
}

// ─── Sender ─────────────────────────────────────────────────────────────────

/** Block hashes per picked file, so a re-send after a drop skips the hashing pass. */
const hashCache = new Map<string, { hashes: Uint8Array; fileId: string }>();

export async function sendFile(file: File | undefined) {
  if (!file) return;
  if (!allOpen()) {
    toast("File channels aren't open yet", "bad");
    return;
  }
  if (TX && !TX.complete && TX.phase !== "paused") {
    toast("Wait for the current file to finish", "bad");
    return;
  }
  const totalBlocks = blockCount(file.size);
  if (totalBlocks > MAX_BLOCKS) {
    toast("Files up to 2 TB can be sent", "bad");
    return;
  }

  const tx: TxSession = {
    sessionId: crypto.randomUUID(),
    peer: peerLabel(),
    file,
    fileId: "",
    fileName: file.name,
    fileSize: file.size,
    totalBlocks,
    hashes: new Uint8Array(0),
    phase: "preparing",
    prep: 0,
    held: new Set(),
    heldBytes: 0,
    queue: [],
    workerFree: Array(N_WORKERS).fill(true),
    encoded: new Map(),
    owed: new Map(),
    dataSent: [],
    dataSentCount: 0,
    cells: new Uint8Array(totalBlocks * N),
    t0: Date.now(),
    complete: false,
  };
  TX = tx;
  emit(true);

  const key = `${file.name}|${file.size}|${file.lastModified}`;
  let known = hashCache.get(key);
  if (!known) {
    const hashes = new Uint8Array(totalBlocks * HASH);
    try {
      for (let i = 0; i < totalBlocks; i++) {
        if (TX !== tx) return; // cancelled
        const buf = await file.slice(i * BLOCK_SIZE, i * BLOCK_SIZE + BLOCK_SIZE).arrayBuffer();
        hashes.set(await sha256(buf), i * HASH);
        tx.prep = (i + 1) / totalBlocks;
        emit();
      }
    } catch {
      if (TX === tx) TX = null;
      toast(`Couldn't read ${file.name}`, "bad");
      emit(true);
      return;
    }
    known = { hashes, fileId: hex(await sha256(hashes)) };
    hashCache.set(key, known);
  }
  if (TX !== tx) return;
  tx.hashes = known.hashes;
  tx.fileId = known.fileId;
  tx.prep = 1;
  if (allOpen()) offer(tx);
  else pauseTx(tx);
  emit(true);
}

/** Announce the file (again, after a drop) and wait for the receiver's inventory. */
function offer(tx: TxSession) {
  tx.sessionId = crypto.randomUUID();
  tx.peer = peerLabel();
  tx.phase = "waiting";
  tx.queue = [];
  tx.encoded.clear();
  tx.owed.clear();
  tx.held.clear();
  tx.heldBytes = 0;
  tx.dataSent = Array.from({ length: tx.totalBlocks }, () => new Set<number>());
  tx.dataSentCount = 0;
  tx.cells.fill(CELL.EMPTY);
  tx.workerFree.fill(true);
  for (let i = 0; i < tx.totalBlocks; i += HASHES_PER_MSG) {
    const end = Math.min(tx.totalBlocks, i + HASHES_PER_MSG);
    ctrlSend({ type: "hashes", sessionId: tx.sessionId, from: i, data: b64(tx.hashes.subarray(i * HASH, end * HASH)) });
  }
  ctrlSend({ type: "transfer-init", sessionId: tx.sessionId, fileId: tx.fileId, fileName: tx.fileName, fileSize: tx.fileSize, totalBlocks: tx.totalBlocks });
  emit(true);
}

function onReady(msg: any) {
  const tx = TX;
  if (!tx || msg.sessionId !== tx.sessionId || tx.phase !== "waiting") return;
  const have = typeof msg.have === "string" ? unb64(msg.have) : new Uint8Array(0);
  for (let b = 0; b < tx.totalBlocks; b++) {
    if (bit(have, b)) {
      tx.held.add(b);
      tx.heldBytes += blockLen(b, tx.fileSize);
      tx.cells.fill(CELL.HELD, b * N, (b + 1) * N);
    } else {
      for (let s = 0; s < N; s++) tx.queue.push({ blockIdx: b, shardIdx: s });
      tx.owed.set(b, N);
    }
  }
  if (tx.held.size) {
    const pct = Math.round((tx.heldBytes / Math.max(1, tx.fileSize)) * 100);
    toast(tx.held.size === tx.totalBlocks ? `${peerLabel()} already has ${tx.fileName}` : `Resuming ${tx.fileName} from ${pct}%`);
  }
  tx.phase = "sending";
  tx.t0 = Date.now();
  emit(true);
  if (tx.queue.length) startSending();
  else ctrlSend({ type: "sent-all", sessionId: tx.sessionId });
}

/** Stop sending. The receiver keeps what it has, so sending the file again resumes. */
export function cancelSend() {
  const tx = TX;
  if (!tx) return;
  if (!tx.complete) {
    ctrlSend({ type: "transfer-cancel", sessionId: tx.sessionId });
    addHistory(tx, "sent", false);
  }
  TX = null;
  clearStreams("tx");
  emit(true);
}

function startSending() {
  if (!TX || TX.phase !== "sending") return;
  for (let i = 0; i < N_WORKERS; i++) if (TX.workerFree[i]) void dispatchWorker(i);
}

function shardsOf(tx: TxSession, b: number): Promise<Uint8Array[]> {
  let p = tx.encoded.get(b);
  if (!p) {
    p = tx.file
      .slice(b * BLOCK_SIZE, b * BLOCK_SIZE + BLOCK_SIZE)
      .arrayBuffer()
      .then((block) => {
        const data: Uint8Array[] = [];
        for (let s = 0; s < K; s++) {
          const so = s * SHARD_SIZE;
          const buf = new Uint8Array(SHARD_SIZE);
          if (so < block.byteLength) buf.set(new Uint8Array(block, so, Math.min(SHARD_SIZE, block.byteLength - so)));
          data.push(buf);
        }
        return data.concat(encodeBlock(data));
      });
    tx.encoded.set(b, p);
  }
  return p;
}

async function dispatchWorker(wi: number) {
  const tx = TX;
  if (!tx) return;
  tx.workerFree[wi] = false;
  const dc = workers[wi];
  if (!dc || dc.readyState !== "open") {
    tx.workerFree[wi] = true;
    return;
  }

  while (tx.queue.length > 0 && TX === tx && tx.phase === "sending") {
    if (dc.bufferedAmount > 1024 * 1024) {
      dc.bufferedAmountLowThreshold = 256 * 1024;
      dc.onbufferedamountlow = () => {
        dc.onbufferedamountlow = null;
        void dispatchWorker(wi);
      };
      return;
    }
    const { blockIdx, shardIdx } = tx.queue.shift()!;
    setStream("tx", wi, `Block ${blockIdx}, shard ${shardIdx + 1} of ${N}`);

    let shards: Uint8Array[];
    try {
      shards = await shardsOf(tx, blockIdx);
    } catch {
      toast(`Couldn't read ${tx.fileName}`, "bad");
      cancelSend();
      return;
    }
    if (TX !== tx || tx.phase !== "sending" || dc.readyState !== "open") break;

    const packet = new Uint8Array(5 + SHARD_SIZE);
    new DataView(packet.buffer).setUint32(0, blockIdx, false);
    packet[4] = shardIdx;
    packet.set(shards[shardIdx], 5);
    try {
      dc.send(packet.buffer);
    } catch {
      tx.queue.unshift({ blockIdx, shardIdx });
      break;
    }
    if (shardIdx < K && !tx.dataSent[blockIdx].has(shardIdx)) {
      tx.dataSent[blockIdx].add(shardIdx);
      tx.dataSentCount++;
    }
    const owed = (tx.owed.get(blockIdx) ?? 1) - 1;
    if (owed <= 0) {
      tx.owed.delete(blockIdx);
      tx.encoded.delete(blockIdx); // read it again if the receiver asks for more
    } else tx.owed.set(blockIdx, owed);
    tx.cells[blockIdx * N + shardIdx] = CELL.GOT;
    emit();
    await new Promise((r) => setTimeout(r, 0));
  }

  tx.workerFree[wi] = true;
  setStream("tx", wi, null);
  if (tx.phase === "sending" && tx.workerFree.every(Boolean) && tx.queue.length === 0) {
    setTimeout(() => {
      if (TX === tx && tx.phase === "sending" && tx.queue.length === 0) ctrlSend({ type: "sent-all", sessionId: tx.sessionId });
    }, 100);
  }
}

// ─── Receiver ───────────────────────────────────────────────────────────────

async function onInit(msg: any) {
  const { sessionId, fileId, fileSize, totalBlocks } = msg;
  if (
    typeof sessionId !== "string" ||
    typeof fileId !== "string" ||
    !/^[0-9a-f]{64}$/.test(fileId) ||
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0 ||
    totalBlocks !== blockCount(fileSize) ||
    totalBlocks > MAX_BLOCKS
  )
    return;
  const fileName = String(msg.fileName ?? "file").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 255) || "file";

  // The hash list must add up to the announced ID, or nothing can be trusted.
  const hashes = new Uint8Array(totalBlocks * HASH);
  let covered = 0;
  if (inbox.sessionId === sessionId)
    for (const p of inbox.parts) {
      if (p.from < 0 || p.from * HASH + p.data.length > hashes.length || p.data.length % HASH) continue;
      hashes.set(p.data, p.from * HASH);
      covered += p.data.length / HASH;
    }
  inbox = { sessionId: "", parts: [] };
  if (covered !== totalBlocks || hex(await sha256(hashes)) !== fileId) {
    ctrlSend({ type: "transfer-cancel", sessionId, reason: "bad_hashes" });
    return;
  }

  if (RX && !RX.complete) pauseRx(RX);
  const held = await heldBlocks(fileId);
  const known = await getMeta(fileId).catch(() => undefined);
  const storable = await putMeta({
    fileId,
    fileName,
    fileSize,
    totalBlocks,
    stored: held.size,
    from: peerLabel(),
    updatedAt: Date.now(),
    complete: known?.complete ?? false,
  })
    .then(() => true)
    .catch(() => false);
  if (!storable) toast("This browser can't keep files, so an interrupted transfer will start over", "bad");

  let heldBytes = 0;
  const cells = new Uint8Array(totalBlocks * N);
  const blocks: RxBlock[] = Array.from({ length: totalBlocks }, (_, i) => {
    if (!held.has(i)) return { received: new Map(), state: 0 };
    heldBytes += blockLen(i, fileSize);
    cells.fill(CELL.HELD, i * N, (i + 1) * N);
    return { received: new Map(), state: 2 };
  });

  RX = {
    sessionId,
    peer: peerLabel(),
    fileId,
    fileName,
    fileSize,
    totalBlocks,
    hashes,
    phase: "sending",
    blocks,
    stored: held.size,
    heldBytes,
    writes: new Set(),
    cells,
    rebuilt: 0,
    pktsReceived: 0,
    pktsLost: 0,
    t0: Date.now(),
    complete: false,
  };
  emit(true);
  if (held.size === totalBlocks) toast(`${fileName} is already on this device`);
  else if (held.size) toast(`Resuming ${fileName} from ${Math.round((heldBytes / Math.max(1, fileSize)) * 100)}%`);
  else toast(`Receiving ${fileName}`);
  void askPersist();
  ctrlSend({ type: "transfer-ready", sessionId, have: bitmap(totalBlocks, (i) => held.has(i)) });
}

function onShard(buf: ArrayBuffer, wi: number) {
  const rx = RX;
  if (!rx || rx.phase !== "sending" || buf.byteLength < 5) return;
  const dv = new DataView(buf);
  const blockIdx = dv.getUint32(0, false);
  const shardIdx = dv.getUint8(4);
  if (blockIdx >= rx.totalBlocks || shardIdx >= N) return;

  const block = rx.blocks[blockIdx];
  if (block.state !== 0) return;
  rx.pktsReceived++;

  if (!block.received.has(shardIdx)) {
    block.received.set(shardIdx, new Uint8Array(buf, 5));
    rx.cells[blockIdx * N + shardIdx] = CELL.GOT;
    setStream("rx", wi, `Block ${blockIdx}, shard ${shardIdx + 1} of ${N}`);
    emit();
  }
  if (block.received.size < K) return;

  let data: Uint8Array[];
  try {
    data = reconstructBlock([...block.received.entries()].map(([idx, d]) => ({ idx, data: d })));
  } catch (e) {
    console.error("Reconstruction failed for block", blockIdx, e);
    return;
  }
  for (let s = 0; s < K; s++) {
    if (!block.received.has(s)) {
      rx.cells[blockIdx * N + s] = CELL.REBUILT;
      rx.rebuilt++;
    }
  }
  block.received.clear();
  block.state = 1;

  const len = blockLen(blockIdx, rx.fileSize);
  const bytes = new Uint8Array(len);
  for (let s = 0, o = 0; s < K && o < len; s++, o += SHARD_SIZE) bytes.set(data[s].subarray(0, Math.min(SHARD_SIZE, len - o)), o);

  const w = store(rx, blockIdx, bytes);
  rx.writes.add(w);
  void w.finally(() => rx.writes.delete(w));
  emit();
}

/** Check a rebuilt block against its hash, then keep it on disk. */
async function store(rx: RxSession, b: number, bytes: Uint8Array<ArrayBuffer>) {
  const block = rx.blocks[b];
  if (!sameHash(await sha256(bytes), rx.hashes.subarray(b * HASH, (b + 1) * HASH))) {
    block.state = 0; // corrupt: ask for it again
    rx.cells.fill(CELL.EMPTY, b * N, (b + 1) * N);
    emit();
    return;
  }
  try {
    await putBlock(rx.fileId, b, new Blob([bytes]));
  } catch {
    block.state = 0;
    if (RX === rx && rx.phase === "sending") {
      ctrlSend({ type: "transfer-cancel", sessionId: rx.sessionId, reason: "storage" });
      pauseRx(rx);
      toast("Out of storage space. Free some up and ask for the file again", "bad");
      emit(true);
    }
    return;
  }
  block.state = 2;
  rx.stored++;
  emit();
}

async function finishRx(rx: RxSession) {
  let blob: Blob;
  try {
    blob = await readFile(rx.fileId);
  } catch {
    toast(`Couldn't read ${rx.fileName} back from storage`, "bad");
    return;
  }
  if (blob.size !== rx.fileSize) {
    toast(`${rx.fileName} came out the wrong size, ask for it again`, "bad");
    return;
  }
  const meta = await getMeta(rx.fileId).catch(() => undefined);
  if (meta) await putMeta({ ...meta, stored: rx.totalBlocks, complete: true, updatedAt: Date.now() }).catch(() => {});
  await saveFile({ fileId: rx.fileId, fileName: rx.fileName });

  rx.complete = true;
  rx.phase = "done";
  ctrlSend({ type: "transfer-complete", sessionId: rx.sessionId });
  toast(`Saved ${rx.fileName}`, "ok");
  addHistory(rx, "received", true);
  emit(true);
  finishStreams("rx", () => !RX || RX.complete);
}

/** Hide a paused or finished incoming transfer. Its stored blocks stay until deleted. */
export function dismissReceive() {
  if (RX && RX.phase === "sending") return;
  RX = null;
  clearStreams("rx");
  emit(true);
}

export { K, M, N, SHARD_SIZE, BLOCK_SIZE };
