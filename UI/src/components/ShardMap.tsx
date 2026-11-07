import { useEffect, useRef, useState } from "react";
import { CELL, K, N } from "../lib/files";

// Each 512 KB block is a column: 16 data shards on top, a gap, 4 parity
// shards below. Cells fill as packets land; data shards rebuilt from parity
// light up in the lamp color.

const COLOR = {
  empty: "#232325",
  data: "#84848a",
  parity: "#4c4c52",
  rebuilt: "#e8a33d",
};

const ROW_GAP = 1;
const GROUP_GAP = 4; // between data and parity rows
const COL_GAP = 2;
const BAND_GAP = 12;
const MAX_H = 320;

type Layout = { c: number; cols: number; bands: number; colH: number; height: number };

function layout(width: number, blocks: number): Layout {
  for (let c = 8; c >= 2; c--) {
    const pitch = c + COL_GAP;
    const cols = Math.max(1, Math.floor((width + COL_GAP) / pitch));
    const bands = Math.ceil(blocks / cols);
    const colH = N * c + (N - 2) * ROW_GAP + GROUP_GAP;
    const height = bands * colH + (bands - 1) * BAND_GAP;
    if (height <= MAX_H || c === 2) return { c, cols, bands, colH, height };
  }
  throw new Error("unreachable");
}

function cellY(row: number, c: number) {
  return row < K ? row * (c + ROW_GAP) : K * (c + ROW_GAP) - ROW_GAP + GROUP_GAP + (row - K) * (c + ROW_GAP);
}

export function ShardMap({ cells, blocks, rev, kind }: { cells: Uint8Array; blocks: number; rev: number; kind: "tx" | "rx" }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const geo = width ? layout(width, blocks) : null;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !geo) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = geo.height * dpr;
    cv.style.height = `${geo.height}px`;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, geo.height);

    const { c, cols, colH } = geo;
    for (let b = 0; b < blocks; b++) {
      const x = (b % cols) * (c + COL_GAP);
      const y0 = Math.floor(b / cols) * (colH + BAND_GAP);
      for (let s = 0; s < N; s++) {
        const v = cells[b * N + s];
        ctx.fillStyle =
          v === CELL.REBUILT ? COLOR.rebuilt : v === CELL.GOT ? (s < K ? COLOR.data : COLOR.parity) : COLOR.empty;
        ctx.fillRect(x, y0 + cellY(s, c), c, c);
      }
      if (hover === b) {
        ctx.strokeStyle = "rgba(237,237,237,0.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 1.5, y0 - 1.5, c + 3, colH + 3);
      }
    }
  }, [rev, width, blocks, hover, cells]);

  const onMove = (e: React.MouseEvent) => {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left) / (geo.c + COL_GAP));
    const band = Math.floor((e.clientY - r.top) / (geo.colH + BAND_GAP));
    const b = band * geo.cols + col;
    setHover(col < geo.cols && b < blocks ? b : null);
  };

  let readout = `${blocks} ${blocks === 1 ? "block" : "blocks"} of ${N} shards`;
  if (hover !== null) {
    let got = 0;
    let rebuilt = 0;
    for (let s = 0; s < N; s++) {
      const v = cells[hover * N + s];
      if (v === CELL.GOT) got++;
      if (v === CELL.REBUILT) rebuilt++;
    }
    readout = `Block ${hover} · ${got} of ${N} ${kind === "tx" ? "sent" : "received"}${rebuilt ? ` · ${rebuilt} rebuilt` : ""}`;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="font-mono text-xs text-fg-3 tabular">{readout}</span>
        <ul className="flex items-center gap-4 text-xs text-fg-3">
          <Legend color={COLOR.data} label="Data" />
          <Legend color={COLOR.parity} label="Parity" />
          {kind === "rx" && <Legend color={COLOR.rebuilt} label="Rebuilt" />}
          <Legend color={COLOR.empty} label="Pending" />
        </ul>
      </div>
      <div ref={wrap} className="max-h-80 overflow-y-auto">
        <canvas
          ref={canvas}
          className="block w-full"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={readout}
        />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className="size-2 rounded-[2px]" style={{ background: color }} />
      {label}
    </li>
  );
}
