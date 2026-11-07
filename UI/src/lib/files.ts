// File transfer over the room's peer connection: one ordered control channel
// plus N unreliable worker channels carrying Reed-Solomon coded shards.

import { BLOCK_SIZE, K, M, N, SHARD_SIZE, encodeBlock, reconstructBlock } from "./fec";
import { Store } from "./store";
import { toast } from "./toast";

export const N_WORKERS = 3;
export const CELL = { EMPTY: 0, GOT: 1, REBUILT: 2 } as const;

export type XferView = {
  kind: "tx" | "rx";
  fileName: string;
  fileSize: number;
  bytesDone: number;
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
  txStreams: (string | null)[];
  rxStreams: (string | null)[];
  history: HistoryEntry[];
};

type TxSession = {
  sessionId: string;
  fileName: string;
  fileSize: number;
  ab: ArrayBuffer;
  totalBlocks: number;
  blockShards: (Uint8Array[] | null)[];
  queue: { blockIdx: number; shardIdx: number }[];
  workerFree: boolean[];
  shardsSentSet: Set<number>[];
  cells: Uint8Array;
  t0: number;
  complete: boolean;
};

type RxBlock = { received: Map<number, Uint8Array>; reconstructed: boolean; dataShards: Uint8Array[] | null };

type RxSession = {
  sessionId: string;
  fileName: string;
  fileSize: number;
  totalBlocks: number;
  blocks: RxBlock[];
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
  txStreams: idle(),
  rxStreams: idle(),
  history: [],
});

let ctrl: RTCDataChannel | null = null;
let workers: (RTCDataChannel | null)[] = Array(N_WORKERS).fill(null);
let TX: TxSession | null = null;
let RX: RxSession | null = null;
let rev = 0;

// ─── Views (throttled) ──────────────────────────────────────────────────────

function view(kind: "tx" | "rx", s: TxSession | RxSession, progress: number, lostPkts = 0, lossPct = 0, rebuilt = 0): XferView {
  const bytesDone = Math.min(Math.round(progress * s.fileSize), s.fileSize);
  const elapsed = (Date.now() - s.t0) / 1000;
  const rate = (s.complete || elapsed > 0.5) && bytesDone > 0 && elapsed > 0 ? bytesDone / elapsed : null;
  return {
    kind,
    fileName: s.fileName,
    fileSize: s.fileSize,
    bytesDone,
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
  let sent = 0;
  for (const set of TX.shardsSentSet) for (const i of set) if (i < K) sent++;
  const total = TX.totalBlocks * K;
  return view("tx", TX, TX.complete ? 1 : total ? Math.min(sent / total, 1) : 0);
}

function rxView() {
  if (!RX) return null;
  const useful = RX.blocks.reduce((s, b) => s + (b.reconstructed ? K : Math.min(b.received.size, K)), 0);
  const total = RX.totalBlocks * K;
  const pkts = RX.pktsReceived + RX.pktsLost;
  return view("rx", RX, RX.complete ? 1 : total ? useful / total : 0, RX.pktsLost, pkts ? (RX.pktsLost / pkts) * 100 : 0, RX.rebuilt);
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function emit(now = false) {
  const run = () => {
    flushTimer = null;
    files.set({ tx: txView(), rx: rxView() });
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

function addHistory(s: TxSession | RxSession, dir: HistoryEntry["dir"], ok: boolean) {
  const duration = (Date.now() - s.t0) / 1000;
  const entry: HistoryEntry = { id: s.sessionId, fileName: s.fileName, fileSize: s.fileSize, dir, ok, speed: duration > 0 ? s.fileSize / duration : 0, duration };
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
  if (ready && TX && !TX.complete && TX.workerFree.every(Boolean) && TX.queue.length) startSending();
}

/** Bind the engine to the room's channels (negotiated, so both sides call this). */
export function attachFiles(control: RTCDataChannel, wrk: RTCDataChannel[]) {
  ctrl = control;
  workers = wrk;
  control.onopen = refreshReady;
  control.onclose = refreshReady;
  control.onmessage = (e) => handleCtrl(JSON.parse(e.data));
  wrk.forEach((ch, i) => {
    ch.binaryType = "arraybuffer";
    ch.onopen = refreshReady;
    ch.onclose = refreshReady;
    ch.onmessage = (ev) => onShard(ev.data, i);
  });
  refreshReady();
}

/** The peer is gone: unfinished transfers fail. */
export function detachFiles() {
  ctrl = null;
  workers = Array(N_WORKERS).fill(null);
  if (TX && !TX.complete) {
    addHistory(TX, "sent", false);
    TX = null;
  }
  if (RX && !RX.complete) {
    addHistory(RX, "received", false);
    RX = null;
  }
  for (let i = 0; i < N_WORKERS; i++) {
    setStream("tx", i, null);
    setStream("rx", i, null);
  }
  files.set({ ready: false });
  emit(true);
}

function ctrlSend(obj: unknown) {
  if (ctrl && ctrl.readyState === "open") ctrl.send(JSON.stringify(obj));
}

// ─── Control protocol ───────────────────────────────────────────────────────

function handleCtrl(msg: any) {
  switch (msg.type) {
    case "transfer-init": {
      RX = {
        sessionId: msg.sessionId,
        fileName: String(msg.fileName).slice(0, 255),
        fileSize: msg.fileSize,
        totalBlocks: msg.totalBlocks,
        blocks: Array.from({ length: msg.totalBlocks }, () => ({ received: new Map(), reconstructed: false, dataShards: null })),
        cells: new Uint8Array(msg.totalBlocks * N),
        rebuilt: 0,
        pktsReceived: 0,
        pktsLost: 0,
        t0: Date.now(),
        complete: false,
      };
      emit(true);
      toast(`Receiving ${RX.fileName}`);
      ctrlSend({ type: "transfer-ready", sessionId: msg.sessionId });
      break;
    }
    case "transfer-ready": {
      if (!TX) return;
      TX.t0 = Date.now();
      emit(true);
      startSending();
      break;
    }
    case "sent-all": {
      if (!RX) return;
      const missing: { blockIdx: number; need: number; have: number[] }[] = [];
      RX.blocks.forEach((b, i) => {
        if (!b.reconstructed) missing.push({ blockIdx: i, need: K - b.received.size, have: [...b.received.keys()] });
      });
      if (!missing.length) {
        assembleAndDownload();
        ctrlSend({ type: "transfer-complete", sessionId: RX.sessionId });
      } else {
        RX.pktsLost += missing.reduce((s, m) => s + m.need, 0);
        ctrlSend({ type: "request-missing", sessionId: RX.sessionId, missing });
        emit();
      }
      break;
    }
    case "request-missing": {
      if (!TX) return;
      for (const { blockIdx, need, have } of msg.missing) {
        const candidates = Array.from({ length: N }, (_, i) => i).filter((i) => !have.includes(i));
        for (let i = 0; i < Math.min(need, candidates.length); i++) TX.queue.push({ blockIdx, shardIdx: candidates[i] });
      }
      startSending();
      break;
    }
    case "transfer-complete": {
      if (!TX) return;
      TX.complete = true;
      addHistory(TX, "sent", true);
      toast(`Sent ${TX.fileName}`, "ok");
      emit(true);
      finishStreams("tx", () => !TX || TX.complete);
      break;
    }
  }
}

// ─── Sender ─────────────────────────────────────────────────────────────────

function startSending() {
  if (!TX) return;
  for (let i = 0; i < N_WORKERS; i++) if (TX.workerFree[i]) dispatchWorker(i);
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

  while (tx.queue.length > 0 && TX === tx) {
    if (dc.bufferedAmount > 1024 * 1024) {
      dc.bufferedAmountLowThreshold = 256 * 1024;
      dc.onbufferedamountlow = () => {
        dc.onbufferedamountlow = null;
        dispatchWorker(wi);
      };
      return;
    }
    const { blockIdx, shardIdx } = tx.queue.shift()!;
    setStream("tx", wi, `Block ${blockIdx}, shard ${shardIdx + 1} of ${N}`);

    if (!tx.blockShards[blockIdx]) {
      const offset = blockIdx * BLOCK_SIZE;
      const block = tx.ab.slice(offset, offset + BLOCK_SIZE);
      const data: Uint8Array[] = [];
      for (let s = 0; s < K; s++) {
        const so = s * SHARD_SIZE;
        const buf = new Uint8Array(SHARD_SIZE);
        if (so < block.byteLength) buf.set(new Uint8Array(block, so, Math.min(SHARD_SIZE, block.byteLength - so)));
        data.push(buf);
      }
      tx.blockShards[blockIdx] = data.concat(encodeBlock(data));
    }

    const packet = new Uint8Array(5 + SHARD_SIZE);
    new DataView(packet.buffer).setUint32(0, blockIdx, false);
    packet[4] = shardIdx;
    packet.set(tx.blockShards[blockIdx]![shardIdx], 5);
    try {
      dc.send(packet.buffer);
    } catch {
      tx.queue.unshift({ blockIdx, shardIdx });
      break;
    }
    tx.shardsSentSet[blockIdx].add(shardIdx);
    tx.cells[blockIdx * N + shardIdx] = CELL.GOT;
    emit();
    await new Promise((r) => setTimeout(r, 0));
  }

  tx.workerFree[wi] = true;
  setStream("tx", wi, null);
  if (tx.workerFree.every(Boolean) && tx.queue.length === 0) {
    setTimeout(() => {
      if (TX === tx && tx.queue.length === 0) ctrlSend({ type: "sent-all", sessionId: tx.sessionId });
    }, 100);
  }
}

export async function sendFile(file: File | undefined) {
  if (!file) return;
  if (!allOpen()) {
    toast("File channels aren't open yet", "bad");
    return;
  }
  if (TX && !TX.complete) {
    toast("Wait for the current file to finish", "bad");
    return;
  }
  const ab = await file.arrayBuffer();
  const totalBlocks = Math.max(1, Math.ceil(file.size / BLOCK_SIZE));
  const sessionId = crypto.randomUUID();
  const queue: TxSession["queue"] = [];
  for (let b = 0; b < totalBlocks; b++) for (let s = 0; s < N; s++) queue.push({ blockIdx: b, shardIdx: s });

  TX = {
    sessionId,
    fileName: file.name,
    fileSize: file.size,
    ab,
    totalBlocks,
    blockShards: Array(totalBlocks).fill(null),
    queue,
    workerFree: Array(N_WORKERS).fill(true),
    shardsSentSet: Array.from({ length: totalBlocks }, () => new Set<number>()),
    cells: new Uint8Array(totalBlocks * N),
    t0: Date.now(),
    complete: false,
  };
  emit(true);
  ctrlSend({ type: "transfer-init", sessionId, fileName: file.name, fileSize: file.size, totalBlocks });
}

// ─── Receiver ───────────────────────────────────────────────────────────────

function onShard(buf: ArrayBuffer, wi: number) {
  if (!RX || buf.byteLength < 5) return;
  const dv = new DataView(buf);
  const blockIdx = dv.getUint32(0, false);
  const shardIdx = dv.getUint8(4);
  if (blockIdx >= RX.totalBlocks || shardIdx >= N) return;

  const block = RX.blocks[blockIdx];
  if (block.reconstructed) return;
  RX.pktsReceived++;

  if (!block.received.has(shardIdx)) {
    block.received.set(shardIdx, new Uint8Array(buf, 5));
    RX.cells[blockIdx * N + shardIdx] = CELL.GOT;
    setStream("rx", wi, `Block ${blockIdx}, shard ${shardIdx + 1} of ${N}`);
    emit();
  }

  if (block.received.size >= K) {
    try {
      block.dataShards = reconstructBlock([...block.received.entries()].map(([idx, data]) => ({ idx, data })));
      block.reconstructed = true;
      for (let s = 0; s < K; s++) {
        if (!block.received.has(s)) {
          RX.cells[blockIdx * N + s] = CELL.REBUILT;
          RX.rebuilt++;
        }
      }
      block.received.clear();
      emit();
    } catch (e) {
      console.error("Reconstruction failed for block", blockIdx, e);
    }
  }
}

function assembleAndDownload() {
  if (!RX) return;
  const merged = new Uint8Array(RX.totalBlocks * BLOCK_SIZE);
  let cursor = 0;
  for (const b of RX.blocks) {
    for (let s = 0; s < K; s++) {
      merged.set(b.dataShards![s], cursor);
      cursor += SHARD_SIZE;
    }
  }
  const url = URL.createObjectURL(new Blob([merged.subarray(0, RX.fileSize)]));
  const a = Object.assign(document.createElement("a"), { href: url, download: RX.fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);

  toast(`Saved ${RX.fileName}`, "ok");
  RX.complete = true;
  addHistory(RX, "received", true);
  emit(true);
  finishStreams("rx", () => !RX || RX.complete);
}

export { K, M, N, SHARD_SIZE, BLOCK_SIZE };
