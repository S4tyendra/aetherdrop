// Two-player turn games over the room's "game" data channel.
// Both sides run the same rules and validate every move; nothing touches the server.

import { Store } from "./store";

export type GameKind = "ttt" | "slide" | "c4" | "quor";

export const GAMES: Record<GameKind, { name: string; cols: number; rows: number; win: number }> = {
  ttt: { name: "Tic-tac-toe", cols: 3, rows: 3, win: 3 },
  slide: { name: "Three pieces", cols: 3, rows: 3, win: 3 },
  c4: { name: "Connect four", cols: 7, rows: 6, win: 4 },
  quor: { name: "Quoridor", cols: 9, rows: 9, win: 0 },
};

/** Pieces per player in "Three pieces": place all three, then move one per turn. */
export const PIECES = 3;
/** Quoridor: 9×9 board, 10 walls each, walls are two cells long. */
export const Q_SIZE = 9;
export const Q_WALLS = 10;

/** 0 empty, 1 me, 2 peer */
export type Cell = 0 | 1 | 2;
export type Pos = { r: number; c: number };
/** A wall sits on the groove crossing below-right of cell (r, c); r and c run 0..7.
 *  "h" blocks between rows r and r+1 across columns c and c+1, "v" between columns c and c+1 across rows r and r+1. */
export type Wall = Pos & { o: "h" | "v" };
/** Quoridor in this player's own view: I start at the bottom and race to row 0. */
export type Quor = { me: Pos; peer: Pos; walls: (Wall & { by: 1 | 2 })[]; left: { me: number; peer: number } };

export type Move = { i: number; from?: number } | { to: Pos } | { wall: Wall };

export type GameState = {
  ready: boolean;
  kind: GameKind;
  board: Cell[];
  quor: Quor;
  myTurn: boolean;
  iStarted: boolean;
  playing: boolean;
  result: "win" | "loss" | "draw" | null;
  line: number[];
  last: number | null;
  lastFrom: number | null;
  score: { me: number; peer: number; draw: number };
};

const freshQuor = (): Quor => ({
  me: { r: Q_SIZE - 1, c: 4 },
  peer: { r: 0, c: 4 },
  walls: [],
  left: { me: Q_WALLS, peer: Q_WALLS },
});

export const game = new Store<GameState>({
  ready: false,
  kind: "ttt",
  board: Array(9).fill(0),
  quor: freshQuor(),
  myTurn: false,
  iStarted: false,
  playing: false,
  result: null,
  line: [],
  last: null,
  lastFrom: null,
  score: { me: 0, peer: 0, draw: 0 },
});

let ch: RTCDataChannel | null = null;

function send(obj: unknown) {
  if (ch && ch.readyState === "open") ch.send(JSON.stringify(obj));
}

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Peer moves arrive in the peer's view of Quoridor; turn the board around. */
function fromPeer(m: any): Move | null {
  if (m?.to && isInt(m.to.r, 0, 8) && isInt(m.to.c, 0, 8)) return { to: { r: 8 - m.to.r, c: 8 - m.to.c } };
  if (m?.wall && isInt(m.wall.r, 0, 7) && isInt(m.wall.c, 0, 7) && (m.wall.o === "h" || m.wall.o === "v"))
    return { wall: { r: 7 - m.wall.r, c: 7 - m.wall.c, o: m.wall.o } };
  if (isInt(m?.i, 0, 99)) return { i: m.i, from: isInt(m.from, -1, 99) ? m.from : undefined };
  return null;
}

export function attachGame(channel: RTCDataChannel) {
  ch = channel;
  channel.onopen = () => game.set({ ready: true });
  channel.onclose = () => game.set({ ready: false, playing: false });
  channel.onmessage = (e) => {
    let m: any;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.t === "new" && m.kind in GAMES) begin(m.kind, !m.senderStarts);
    if (m.t === "move") {
      const mv = fromPeer(m.m);
      if (mv) apply(mv, 2);
    }
  };
  if (channel.readyState === "open") game.set({ ready: true });
}

export function detachGame() {
  ch = null;
  game.set({ ready: false, playing: false });
}

function begin(kind: GameKind, iStart: boolean) {
  const g = GAMES[kind];
  game.set({
    kind,
    board: Array(g.cols * g.rows).fill(0),
    quor: freshQuor(),
    myTurn: iStart,
    iStarted: iStart,
    playing: true,
    result: null,
    line: [],
    last: null,
    lastFrom: null,
  });
}

/** Start a new round. Whoever didn't start the last round goes first. */
export function newGame(kind: GameKind) {
  const s = game.get();
  const started = s.kind === kind && (s.board.some(Boolean) || s.quor.walls.length > 0 || s.quor.me.r !== Q_SIZE - 1);
  const iStart = started ? !s.iStarted : true;
  begin(kind, iStart);
  send({ t: "new", kind, senderStarts: iStart });
}

// ─── Grid games ─────────────────────────────────────────────────────────────

/** For connect four, `i` is a column; it resolves to the lowest free cell. */
function target(kind: GameKind, board: Cell[], i: number): number {
  const g = GAMES[kind];
  if (kind !== "c4") return i >= 0 && i < board.length && board[i] === 0 ? i : -1;
  if (i < 0 || i >= g.cols) return -1;
  for (let r = g.rows - 1; r >= 0; r--) if (board[r * g.cols + i] === 0) return r * g.cols + i;
  return -1;
}

function findLine(kind: GameKind, board: Cell[], at: number): number[] {
  const { cols, rows, win } = GAMES[kind];
  const who = board[at];
  const r0 = Math.floor(at / cols);
  const c0 = at % cols;
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ]) {
    const line = [at];
    for (const sign of [1, -1]) {
      let r = r0 + dr * sign;
      let c = c0 + dc * sign;
      while (r >= 0 && r < rows && c >= 0 && c < cols && board[r * cols + c] === who) {
        line.push(r * cols + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= win) return line;
  }
  return [];
}

export const inTray = (board: Cell[], who: 1 | 2) => PIECES - board.filter((x) => x === who).length;

// ─── Quoridor ───────────────────────────────────────────────────────────────

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const inBoard = (r: number, c: number) => r >= 0 && r < Q_SIZE && c >= 0 && c < Q_SIZE;
const hasWall = (walls: Wall[], o: "h" | "v", r: number, c: number) => walls.some((w) => w.o === o && w.r === r && w.c === c);

/** Is the step from (r, c) by (dr, dc) cut by a wall? */
function cut(walls: Wall[], r: number, c: number, dr: number, dc: number) {
  if (dr === 1) return hasWall(walls, "h", r, c) || hasWall(walls, "h", r, c - 1);
  if (dr === -1) return hasWall(walls, "h", r - 1, c) || hasWall(walls, "h", r - 1, c - 1);
  if (dc === 1) return hasWall(walls, "v", r, c) || hasWall(walls, "v", r - 1, c);
  return hasWall(walls, "v", r, c - 1) || hasWall(walls, "v", r - 1, c - 1);
}

/** Legal pawn targets: one step, a straight jump over the other pawn, or a side step when a wall stops the jump. */
export function pawnMoves(q: Quor, who: 1 | 2): Pos[] {
  const a = who === 1 ? q.me : q.peer;
  const b = who === 1 ? q.peer : q.me;
  const out: Pos[] = [];
  for (const [dr, dc] of DIRS) {
    const r = a.r + dr;
    const c = a.c + dc;
    if (!inBoard(r, c) || cut(q.walls, a.r, a.c, dr, dc)) continue;
    if (r !== b.r || c !== b.c) {
      out.push({ r, c });
      continue;
    }
    if (inBoard(r + dr, c + dc) && !cut(q.walls, r, c, dr, dc)) {
      out.push({ r: r + dr, c: c + dc });
      continue;
    }
    for (const [sr, sc] of dr ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]) {
      if (inBoard(r + sr, c + sc) && !cut(q.walls, r, c, sr, sc)) out.push({ r: r + sr, c: c + sc });
    }
  }
  return out;
}

/** Can a pawn at `from` still reach `goalRow`? Pawns don't block paths. */
function reaches(walls: Wall[], from: Pos, goalRow: number) {
  const seen = new Set([from.r * Q_SIZE + from.c]);
  const queue = [from];
  while (queue.length) {
    const p = queue.shift()!;
    if (p.r === goalRow) return true;
    for (const [dr, dc] of DIRS) {
      const r = p.r + dr;
      const c = p.c + dc;
      const k = r * Q_SIZE + c;
      if (inBoard(r, c) && !seen.has(k) && !cut(walls, p.r, p.c, dr, dc)) {
        seen.add(k);
        queue.push({ r, c });
      }
    }
  }
  return false;
}

/** A wall may not overlap or cross another, and must leave both players a way to their goal. */
export function wallOk(q: Quor, w: Wall): boolean {
  if (!isInt(w.r, 0, Q_SIZE - 2) || !isInt(w.c, 0, Q_SIZE - 2)) return false;
  for (const x of q.walls) {
    if (x.r === w.r && x.c === w.c) return false;
    if (x.o === w.o && w.o === "h" && x.r === w.r && Math.abs(x.c - w.c) === 1) return false;
    if (x.o === w.o && w.o === "v" && x.c === w.c && Math.abs(x.r - w.r) === 1) return false;
  }
  const walls = [...q.walls, w];
  return reaches(walls, q.me, 0) && reaches(walls, q.peer, Q_SIZE - 1);
}

// ─── Moves ──────────────────────────────────────────────────────────────────

function finish(patch: Partial<GameState>, result: GameState["result"], who: 1 | 2) {
  const s = game.get();
  const score = { ...s.score };
  if (result === "win") score.me++;
  if (result === "loss") score.peer++;
  if (result === "draw") score.draw++;
  game.set({ ...patch, result, playing: !result, myTurn: !result && who === 2, score });
}

function apply(mv: Move, who: 1 | 2): boolean {
  const s = game.get();
  if (!s.playing || s.myTurn !== (who === 1)) return false;
  const won = who === 1 ? "win" : "loss";

  if (s.kind === "quor") {
    const q = s.quor;
    if ("to" in mv) {
      if (!pawnMoves(q, who).some((p) => p.r === mv.to.r && p.c === mv.to.c)) return false;
      const next = { ...q, [who === 1 ? "me" : "peer"]: mv.to };
      const goal = who === 1 ? mv.to.r === 0 : mv.to.r === Q_SIZE - 1;
      finish({ quor: next }, goal ? won : null, who);
      return true;
    }
    if ("wall" in mv) {
      const key = who === 1 ? "me" : "peer";
      if (q.left[key] <= 0 || !wallOk(q, mv.wall)) return false;
      finish({ quor: { ...q, walls: [...q.walls, { ...mv.wall, by: who }], left: { ...q.left, [key]: q.left[key] - 1 } } }, null, who);
      return true;
    }
    return false;
  }

  if (!("i" in mv)) return false;
  const board = s.board.slice() as Cell[];

  if (s.kind === "slide") {
    const placing = inTray(board, who) > 0;
    const from = mv.from ?? -1;
    if (!isInt(mv.i, 0, 8) || board[mv.i] !== 0) return false;
    if (placing ? from !== -1 : !isInt(from, 0, 8) || board[from] !== who) return false;
    if (from >= 0) board[from] = 0;
    board[mv.i] = who;
    const line = findLine("slide", board, mv.i);
    finish({ board, last: mv.i, lastFrom: from >= 0 ? from : null, line }, line.length ? won : null, who);
    return true;
  }

  const at = target(s.kind, board, mv.i);
  if (at < 0) return false;
  board[at] = who;
  const line = findLine(s.kind, board, at);
  const result = line.length ? won : board.every(Boolean) ? "draw" : null;
  finish({ board, last: at, lastFrom: null, line }, result, who);
  return true;
}

/** ttt / c4: `i` is a cell or column. Three pieces: `from` is -1 for the tray or the cell the piece leaves. */
export function play(i: number, from?: number) {
  const mv: Move = from === undefined ? { i } : { i, from };
  if (apply(mv, 1)) send({ t: "move", m: mv });
}

export function movePawn(to: Pos) {
  if (apply({ to }, 1)) send({ t: "move", m: { to } });
}

export function placeWall(wall: Wall) {
  if (apply({ wall }, 1)) send({ t: "move", m: { wall } });
}
