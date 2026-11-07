export function fmtBytes(n: number) {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1 << 30) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** "30.8 / 48.0 MB" when both share a unit, else "278.0 KB / 1.2 MB". */
export function fmtPair(done: number, total: number) {
  const a = fmtBytes(done);
  const b = fmtBytes(total);
  const ua = a.split(" ")[1];
  return ua === b.split(" ")[1] ? `${a.split(" ")[0]} / ${b}` : `${a} / ${b}`;
}

export function fmtEta(s: number) {
  if (!isFinite(s)) return "–";
  if (s < 60) return `${Math.ceil(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
}

export function fmtClock(sec: number) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}
