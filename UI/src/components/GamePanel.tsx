import {
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from "react";
import {
  GAMES,
  PIECES,
  Q_SIZE,
  game,
  inTray,
  movePawn,
  newGame,
  pawnMoves,
  placeWall,
  play,
  wallOk,
  type GameKind,
  type GameState,
  type Wall,
} from "../lib/games";
import { createPortal } from "react-dom";
import { peerName, room } from "../lib/room";
import { useStore } from "../lib/store";
import { Button, Card, cx } from "./ui";

function Mark({
  x,
  win,
  className,
}: {
  x: boolean;
  win?: boolean;
  className?: string;
}) {
  const stroke = win ? "var(--color-lamp)" : "currentColor";
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx("size-[45%]", className)}
      fill="none"
      aria-hidden
    >
      {x ? (
        <path
          d="M6 6l12 12M18 6L6 18"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <circle cx="12" cy="12" r="6.5" stroke={stroke} strokeWidth="2" />
      )}
    </svg>
  );
}

export function GamePanel({
  wide,
  expand,
}: {
  wide?: boolean;
  expand?: ReactNode;
}) {
  const s = useStore(game);
  const name = peerName(useStore(room).peer);

  const statusText = !s.ready
    ? "Games open once someone joins"
    : s.result === "win"
      ? "You won"
      : s.result === "loss"
        ? `${name} won`
        : s.result === "draw"
          ? "Draw"
          : !s.playing
            ? "Start a round"
            : s.myTurn
              ? "Your turn"
              : `${name}'s turn`;

  return (
    <Card title="Games" aside={expand}>
      {/* Two by two in the narrow column, one row once the card is wide enough; never scrolls. */}
      <div className="@container">
        <div
          className="grid grid-cols-2 gap-1 rounded-[10px] bg-deep p-1 @md:grid-cols-4"
          role="tablist"
          aria-label="Game"
        >
          {(Object.keys(GAMES) as GameKind[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={s.kind === k}
              disabled={!s.ready}
              onClick={() => s.kind !== k && newGame(k)}
              className={cx(
                "h-7 truncate rounded-md px-2 text-xs transition-colors duration-150 disabled:opacity-50",
                s.kind === k
                  ? "bg-raised text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  : "text-fg-3 hover:text-fg",
              )}
            >
              {GAMES[k].name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span
          className={cx(
            "text-sm",
            s.result === "win"
              ? "text-lamp"
              : s.myTurn && s.playing
                ? "text-fg"
                : "text-fg-2",
          )}
        >
          {statusText}
        </span>
        <span className="font-mono text-xs text-fg-3 tabular">
          {s.score.me}–{s.score.peer}
          {s.score.draw ? ` · ${s.score.draw} drawn` : ""}
        </span>
      </div>

      {s.kind === "slide" ? (
        <SlideBoard s={s} wide={!!wide} name={name} />
      ) : s.kind === "quor" ? (
        <QuorBoard s={s} wide={!!wide} name={name} />
      ) : (
        <GridBoard s={s} wide={!!wide} />
      )}

      <div className="mt-4 flex items-center justify-between gap-4">
        <span className="text-xs text-fg-3">
          {s.kind === "ttt"
            ? `You play ${s.playing || s.result ? (s.iStarted ? "X" : "O") : "X when you start"}`
            : s.kind === "slide"
              ? `Place all ${PIECES}, then move one per turn`
              : s.kind === "c4"
                ? "Your discs are solid"
                : "Reach the far side first"}
        </span>
        <Button size="sm" disabled={!s.ready} onClick={() => newGame(s.kind)}>
          New round
        </Button>
      </div>
    </Card>
  );
}

// ─── Tic-tac-toe and connect four ───────────────────────────────────────────

function GridBoard({ s, wide }: { s: GameState; wide: boolean }) {
  const g = GAMES[s.kind];
  const mineX = s.iStarted; // whoever starts plays X
  const winSet = new Set(s.line);
  return (
    <div
      className={cx(
        "mx-auto mt-4 grid w-full gap-1",
        s.kind === "ttt"
          ? wide
            ? "max-w-96"
            : "max-w-60"
          : wide
            ? "max-w-[560px]"
            : "max-w-80",
      )}
      style={{ gridTemplateColumns: `repeat(${g.cols}, minmax(0, 1fr))` }}
    >
      {s.board.map((cell, i) => {
        const col = i % g.cols;
        const canPlay =
          s.ready && s.playing && s.myTurn && (s.kind === "c4" || cell === 0);
        return (
          <button
            key={i}
            disabled={!canPlay}
            onClick={() => play(s.kind === "c4" ? col : i)}
            aria-label={`${s.kind === "c4" ? `Column ${col + 1}` : `Cell ${i + 1}`}${cell ? (cell === 1 ? ", yours" : ", theirs") : ""}`}
            className={cx(
              "flex aspect-square items-center justify-center bg-deep transition-colors duration-150",
              s.kind === "ttt" ? "rounded-lg" : "rounded-md",
              canPlay && "hover:bg-raised",
              cell === 1 ? "text-fg" : "text-fg-2",
            )}
          >
            {s.kind === "ttt" && cell !== 0 && (
              <Mark x={cell === 1 ? mineX : !mineX} win={winSet.has(i)} />
            )}
            {s.kind === "c4" && cell !== 0 && (
              <span
                className={cx(
                  "size-[72%] rounded-full",
                  cell === 1 ? "bg-fg" : "border-2 border-fg-2",
                  winSet.has(i) &&
                    "ring-2 ring-lamp ring-offset-2 ring-offset-deep",
                )}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Three pieces: physical blocks you drag onto the board ──────────────────

type Drag = {
  from: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  size: number;
};

function SlideBoard({
  s,
  wide,
  name,
}: {
  s: GameState;
  wide: boolean;
  name: string;
}) {
  const mineX = s.iStarted;
  const winSet = new Set(s.line);
  const myTray = inTray(s.board, 1);
  const peerTray = inTray(s.board, 2);
  const placing = myTray > 0;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sel, setSel] = useState<number | null>(null); // -1 tray, else a cell
  const myTurn = s.ready && s.playing && s.myTurn;

  const canGrab = (from: number) =>
    myTurn && (from === -1 ? placing : !placing && s.board[from] === 1);
  const drop = (from: number, to: number) => {
    if (s.board[to] === 0) play(to, from);
    setSel(null);
  };

  const grab = (from: number) => (e: RPointerEvent<HTMLElement>) => {
    if (!canGrab(from)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = e.currentTarget.getBoundingClientRect();
    setDrag({
      from,
      x: e.clientX,
      y: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      size: box.width,
    });
  };
  const moveDrag = (e: RPointerEvent) =>
    drag && setDrag({ ...drag, x: e.clientX, y: e.clientY });
  const release = (e: RPointerEvent) => {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6;
    if (moved) {
      // Look through anything floating on top, like a toast.
      const el = document
        .elementsFromPoint(e.clientX, e.clientY)
        .map((n) => n.closest<HTMLElement>("[data-cell]"))
        .find(Boolean);
      if (el) drop(drag.from, Number(el.dataset.cell));
    } else {
      setSel(sel === drag.from ? null : drag.from); // tap to pick up, tap a cell to put down
    }
    setDrag(null);
  };
  const handlers = (from: number) => ({
    onPointerDown: grab(from),
    onPointerMove: moveDrag,
    onPointerUp: release,
    onPointerCancel: () => setDrag(null),
  });

  const tray = (mine: boolean) => {
    const count = mine ? myTray : peerTray;
    const x = mine ? mineX : !mineX;
    return (
      <div
        className="flex flex-col gap-1"
        aria-label={
          mine
            ? `Your pieces, ${count} left`
            : `${name}'s pieces, ${count} left`
        }
      >
        {Array.from({ length: PIECES }, (_, k) => {
          const has = k < count;
          const live = mine && has && canGrab(-1);
          return (
            <div
              key={k}
              {...(live ? handlers(-1) : {})}
              className={cx(
                "flex aspect-square touch-none items-center justify-center rounded-lg border transition-colors duration-150",
                has
                  ? "border-line-2 bg-raised"
                  : "border-dashed border-line bg-transparent",
                mine ? "text-fg" : "text-fg-2",
                live && "cursor-grab hover:bg-hover active:cursor-grabbing",
                live && sel === -1 && "border-lamp",
                drag?.from === -1 && k === count - 1 && "opacity-30",
              )}
            >
              {has && <Mark x={x} className="size-[55%]" />}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      className={cx(
        "mx-auto mt-4 grid w-full items-center gap-3",
        wide ? "max-w-[520px]" : "max-w-80",
      )}
      style={{ gridTemplateColumns: "1fr 3.6fr 1fr" }}
    >
      {mineX ? tray(true) : tray(false)}
      <div className="grid grid-cols-3 gap-1">
        {s.board.map((cell, i) => {
          const live = cell === 1 && canGrab(i);
          const target =
            myTurn && cell === 0 && (sel !== null || drag !== null);
          return (
            <div
              key={i}
              data-cell={i}
              role="button"
              tabIndex={cell === 0 && sel !== null ? 0 : -1}
              aria-label={`Cell ${i + 1}${cell ? (cell === 1 ? ", yours" : ", theirs") : ""}`}
              onClick={() => cell === 0 && sel !== null && drop(sel, i)}
              onKeyDown={(e) =>
                e.key === "Enter" && cell === 0 && sel !== null && drop(sel, i)
              }
              className={cx(
                "flex aspect-square items-center justify-center rounded-lg bg-deep transition-colors duration-150",
                target && "hover:bg-raised",
                s.lastFrom === i && "ring-1 ring-line-2 ring-inset",
              )}
            >
              {cell !== 0 && (
                <div
                  {...(live ? handlers(i) : {})}
                  className={cx(
                    "flex size-[86%] touch-none items-center justify-center rounded-md border border-line-2 bg-raised",
                    cell === 1 ? "text-fg" : "text-fg-2",
                    live && "cursor-grab hover:bg-hover active:cursor-grabbing",
                    sel === i && "border-lamp",
                    drag?.from === i && "opacity-30",
                  )}
                >
                  <Mark
                    x={cell === 1 ? mineX : !mineX}
                    win={winSet.has(i)}
                    className="size-[60%]"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {mineX ? tray(false) : tray(true)}
      {/* Portalled to <body>: a transformed ancestor (the enter animation) would
          otherwise become the containing block for position: fixed and offset it. */}
      {drag &&
        Math.hypot(drag.x - drag.sx, drag.y - drag.sy) > 6 &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 flex items-center justify-center rounded-md border border-line-2 bg-raised text-fg shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
            style={{
              width: drag.size,
              height: drag.size,
              left: drag.x - drag.size / 2,
              top: drag.y - drag.size / 2,
            }}
          >
            <Mark x={mineX} className="size-[60%]" />
          </div>,
          document.body,
        )}
    </div>
  );
}

// ─── Quoridor ───────────────────────────────────────────────────────────────

// Board geometry in cell units: a cell is 1, a groove is G wide.
const G = 0.25;
const PITCH = 1 + G;
const SPAN = Q_SIZE + (Q_SIZE - 1) * G;
const pct = (u: number) => `${(u / SPAN) * 100}%`;

function wallBox(w: Wall) {
  const long = 2 + G;
  return w.o === "h"
    ? {
        left: pct(w.c * PITCH),
        top: pct(w.r * PITCH + 1),
        width: pct(long),
        height: pct(G),
      }
    : {
        left: pct(w.c * PITCH + 1),
        top: pct(w.r * PITCH),
        width: pct(G),
        height: pct(long),
      };
}

const sameWall = (a: Wall | null, b: Wall | null) =>
  !!a && !!b && a.r === b.r && a.c === b.c && a.o === b.o;

function QuorBoard({
  s,
  wide,
  name,
}: {
  s: GameState;
  wide: boolean;
  name: string;
}) {
  const q = s.quor;
  const [mode, setMode] = useState<"move" | "wall">("move");
  const [hover, setHover] = useState<Wall | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const myTurn = s.ready && s.playing && s.myTurn;
  const moves = myTurn && mode === "move" ? pawnMoves(q, 1) : [];
  const canWall = myTurn && q.left.me > 0;

  /** The groove crossing nearest the pointer; orientation follows whichever groove is closer. */
  const wallAt = (e: RPointerEvent): Wall | null => {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return null;
    const ux = ((e.clientX - box.left) / box.width) * SPAN;
    const uy = ((e.clientY - box.top) / box.height) * SPAN;
    const cross = (u: number) =>
      Math.min(Q_SIZE - 2, Math.max(0, Math.round((u - 1 - G / 2) / PITCH)));
    const c = cross(ux);
    const r = cross(uy);
    const lineX = c * PITCH + 1 + G / 2;
    const lineY = r * PITCH + 1 + G / 2;
    return { r, c, o: Math.abs(uy - lineY) < Math.abs(ux - lineX) ? "h" : "v" };
  };

  const onMove = (e: RPointerEvent) => {
    if (mode !== "wall" || !canWall || e.pointerType !== "mouse") return;
    const w = wallAt(e);
    if (!sameWall(w, hover)) setHover(w);
  };
  const onTap = (e: RPointerEvent) => {
    if (mode !== "wall" || !canWall) return;
    const w = wallAt(e);
    if (!w) return;
    // Mouse places on click; touch previews first, a second tap on the same spot places.
    if (e.pointerType === "mouse" || sameWall(w, hover)) {
      if (wallOk(q, w)) {
        placeWall(w);
        setHover(null);
        setMode("move");
      }
    } else setHover(w);
  };

  const hoverOk = hover && canWall ? wallOk(q, hover) : false;
  const cellStyle = (r: number, c: number) => ({
    left: pct(c * PITCH),
    top: pct(r * PITCH),
    width: pct(1),
    height: pct(1),
  });

  return (
    <div
      className={cx("mx-auto mt-4 w-full", wide ? "max-w-[560px]" : "max-w-80")}
    >
      <div className="mb-2 flex items-center justify-between text-xs text-fg-3">
        <span>
          {name}: <span className="font-mono tabular">{q.left.peer}</span> walls
        </span>
        <span>Your goal is the top row</span>
      </div>
      <div
        ref={boardRef}
        className={cx(
          "relative aspect-square w-full touch-none select-none",
          mode === "wall" && canWall && "cursor-crosshair",
        )}
        onPointerMove={onMove}
        onPointerLeave={() => mode === "wall" && setHover(null)}
        onPointerUp={onTap}
        aria-label="Quoridor board"
      >
        {Array.from({ length: Q_SIZE * Q_SIZE }, (_, k) => {
          const r = Math.floor(k / Q_SIZE);
          const c = k % Q_SIZE;
          const legal = moves.some((m) => m.r === r && m.c === c);
          return (
            <button
              key={k}
              disabled={!legal}
              onClick={() => movePawn({ r, c })}
              aria-label={
                legal ? `Move to row ${r + 1}, column ${c + 1}` : undefined
              }
              tabIndex={legal ? 0 : -1}
              className={cx(
                "absolute rounded-[3px] transition-colors duration-150",
                r === 0 ? "bg-raised" : "bg-deep",
                legal && "bg-hover ring-1 ring-fg-3 ring-inset hover:bg-line-2",
                mode === "wall" && "pointer-events-none",
              )}
              style={cellStyle(r, c)}
            />
          );
        })}

        {q.walls.map((w, i) => (
          <span
            key={i}
            className={cx(
              "absolute rounded-full",
              w.by === 1 ? "bg-fg" : "bg-fg-2",
            )}
            style={wallBox(w)}
          />
        ))}
        {mode === "wall" && hover && canWall && (
          <span
            className={cx(
              "pointer-events-none absolute rounded-full",
              hoverOk ? "bg-lamp/70" : "bg-bad/50",
            )}
            style={wallBox(hover)}
          />
        )}

        {pawn(q.peer, false, s.result === "loss")}
        {pawn(q.me, true, s.result === "win")}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-fg-3">
          You: <span className="font-mono tabular">{q.left.me}</span> walls
        </span>
        <div
          className="flex gap-1 rounded-lg bg-deep p-0.5"
          role="radiogroup"
          aria-label="Action"
        >
          {(["move", "wall"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              disabled={m === "wall" && q.left.me === 0}
              onClick={() => {
                setMode(m);
                setHover(null);
              }}
              className={cx(
                "h-7 rounded-md px-3 text-xs transition-colors duration-150 disabled:opacity-40",
                mode === m ? "bg-raised text-fg" : "text-fg-3 hover:text-fg",
              )}
            >
              {m === "move" ? "Move" : "Wall"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // A render helper, not a component, so the pawn element persists and slides between cells.
  function pawn(at: { r: number; c: number }, mine: boolean, win: boolean) {
    return (
      <span
        key={mine ? "me" : "peer"}
        aria-label={mine ? "Your pawn" : `${name}'s pawn`}
        className="pointer-events-none absolute flex items-center justify-center transition-[left,top] duration-200 ease-out"
        style={cellStyle(at.r, at.c)}
      >
        <span
          className={cx(
            "size-[64%] rounded-full",
            mine ? "bg-fg" : "border-2 border-fg-2",
            win && "ring-2 ring-lamp ring-offset-2 ring-offset-deep",
          )}
        />
      </span>
    );
  }
}
