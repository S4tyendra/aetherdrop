import { ArrowDown, ArrowUp, Link2Off, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { N_WORKERS, files, sendFile, type HistoryEntry, type XferView } from "../lib/files";
import { fmtBytes, fmtEta, fmtPair } from "../lib/format";
import { useStore } from "../lib/store";
import { ShardMap } from "./ShardMap";
import { Card, Dot, ICON, Stat, cx } from "./ui";

export function FilesPanel({ expand }: { expand?: ReactNode }) {
  const s = useStore(files);
  return (
    <>
      <Dropzone enabled={s.ready} expand={expand} />
      {s.tx && <Transfer v={s.tx} streams={s.txStreams} />}
      {s.rx && <Transfer v={s.rx} streams={s.rxStreams} />}
      {s.history.length > 0 && <History items={s.history} />}
    </>
  );
}

function Dropzone({ enabled, expand }: { enabled: boolean; expand?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <Card title="Send a file" aside={expand}>
      <div
        role="button"
        tabIndex={enabled ? 0 : -1}
        aria-disabled={!enabled}
        onClick={() => enabled && input.current?.click()}
        onKeyDown={(e) => enabled && (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (enabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (enabled) void sendFile(e.dataTransfer.files[0]);
        }}
        className={cx(
          "flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center",
          "transition-[background-color,border-color] duration-150 ease-out",
          enabled
            ? cx("cursor-pointer hover:border-fg-3 hover:bg-raised/40", over ? "border-lamp bg-raised/60" : "border-line-2")
            : "border-line",
        )}
      >
        <input
          ref={input}
          type="file"
          className="hidden"
          onChange={(e) => {
            void sendFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {enabled ? (
          <>
            <Upload size={18} strokeWidth={1.5} className="text-fg-2" />
            <p className="mt-3 text-sm text-fg">
              Drop a file here or <span className="underline decoration-fg-3 underline-offset-4">browse</span>
            </p>
            <p className="mt-1 text-xs text-fg-3">Sent straight to the peer, never through the server</p>
          </>
        ) : (
          <>
            <Link2Off size={18} strokeWidth={1.5} className="text-fg-3" />
            <p className="mt-3 text-sm text-fg-2">Files open once someone joins</p>
            <p className="mt-1 text-xs text-fg-3">They travel browser to browser, the server only introduces you</p>
          </>
        )}
      </div>
    </Card>
  );
}

function Transfer({ v, streams }: { v: XferView; streams: (string | null)[] }) {
  const tx = v.kind === "tx";
  const Dir = tx ? ArrowUp : ArrowDown;
  return (
    <Card className="animate-enter">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-fg-2">
            <Dir {...ICON} className="text-fg-3" />
            {v.done ? (tx ? "Sent" : "Received") : tx ? "Sending" : "Receiving"}
          </div>
          <h3 className="mt-1 truncate text-base font-medium text-fg" title={v.fileName}>
            {v.fileName}
          </h3>
        </div>
        <span className="font-mono text-3xl leading-none text-fg tabular">{v.pct}%</span>
      </div>

      <div className="mt-4 h-1 overflow-hidden rounded-full bg-raised">
        <div
          className="h-full origin-left rounded-full bg-fg transition-transform duration-150 ease-out"
          style={{ transform: `scaleX(${v.pct / 100})` }}
        />
      </div>

      <div
        className={cx(
          "mt-5 grid grid-cols-2 gap-x-6 gap-y-4",
          tx ? "sm:grid-cols-3" : "sm:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))]",
        )}
      >
        <Stat label="Transferred" value={fmtPair(v.bytesDone, v.fileSize)} />
        <Stat label="Speed" value={v.speed ? `${fmtBytes(v.speed)}/s` : "–"} />
        <Stat label="Remaining" value={v.eta === null ? "–" : fmtEta(v.eta)} />
        {!tx && <Stat label="Lost packets" value={`${v.lossPct.toFixed(1)}% · ${v.lostPkts}`} />}
        {!tx && <Stat label="Rebuilt shards" value={v.rebuilt} accent={v.rebuilt > 0} />}
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <ShardMap cells={v.cells} blocks={v.totalBlocks} rev={v.rev} kind={v.kind} />
      </div>

      <ul className="mt-5 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-line pt-4 sm:grid-cols-3">
        {Array.from({ length: N_WORKERS }, (_, i) => {
          const text = streams[i];
          return (
            <li key={i} className="flex h-7 min-w-0 items-center gap-2 text-xs">
              <Dot tone={text ? "ok" : "muted"} />
              <span className="shrink-0 text-fg-2">Stream {i + 1}</span>
              <span className="truncate font-mono text-fg-3 tabular">{text ?? "idle"}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function History({ items }: { items: HistoryEntry[] }) {
  return (
    <Card
      title="Files this session"
      aside={
        <span className="font-mono text-xs text-fg-3 tabular">
          {items.length} {items.length === 1 ? "file" : "files"}
        </span>
      }
    >
      {/* Columns drop out as the card narrows instead of scrolling sideways. */}
      <div className="@container">
        <table className="w-full table-fixed text-left text-sm">
          <thead>
            <tr className="h-9 border-t border-b border-line text-xs text-fg-3">
              <th className="font-normal">File</th>
              <th className="w-20 text-right font-normal">Size</th>
              <th className="w-28 pl-6 font-normal">Direction</th>
              <th className="hidden w-24 text-right font-normal @xl:table-cell">Speed</th>
              <th className="hidden w-16 text-right font-normal @xl:table-cell">Time</th>
              <th className="hidden w-24 pl-6 font-normal @lg:table-cell">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((h) => (
              <tr key={h.id} className="h-11 border-b border-line last:border-b-0">
                <td className="truncate pr-4 text-fg" title={h.fileName}>
                  {h.fileName}
                </td>
                <td className="text-right font-mono text-fg-2 tabular">{fmtBytes(h.fileSize)}</td>
                <td className={cx("pl-6", h.ok ? "text-fg-2" : "text-bad @lg:text-fg-2")}>
                  <span className="inline-flex items-center gap-2">
                    {h.dir === "sent" ? <ArrowUp {...ICON} className="text-fg-3" /> : <ArrowDown {...ICON} className="text-fg-3" />}
                    {h.dir === "sent" ? "Sent" : "Received"}
                  </span>
                </td>
                <td className="hidden text-right font-mono text-fg-2 tabular @xl:table-cell">{h.ok ? `${fmtBytes(h.speed)}/s` : "–"}</td>
                <td className="hidden text-right font-mono text-fg-2 tabular @xl:table-cell">{h.ok ? `${h.duration.toFixed(1)}s` : "–"}</td>
                <td className="hidden pl-6 @lg:table-cell">
                  <span className="inline-flex items-center gap-2 text-fg-2">
                    <Dot tone={h.ok ? "ok" : "bad"} />
                    {h.ok ? "Done" : "Failed"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
