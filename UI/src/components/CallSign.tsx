import { useRef, useState } from "react";
import { CODE_LEN as KEY_LEN, normalizeCode as normalizeKey } from "../lib/signal";
import { cx } from "./ui";

// The signature: a connection key set as a call sign, one character per cell.

const cell =
  "flex items-center justify-center rounded-lg border font-mono tabular transition-[border-color,background-color,color] duration-150 ease-out";

export function CallSign({ value, size = "lg", label }: { value: string; size?: "lg" | "sm"; label?: string }) {
  const chars = Array.from({ length: KEY_LEN }, (_, i) => value[i] ?? "");
  return (
    <div className="flex gap-1.5" aria-label={label ?? (value ? `Key ${value.split("").join(" ")}` : "Key pending")}>
      {chars.map((c, i) => (
        <span
          key={i}
          className={cx(
            cell,
            "border-line bg-raised",
            size === "lg" ? "h-14 flex-1 text-2xl" : "h-6 w-5 rounded-[4px] text-xs",
            c ? "text-fg" : "text-fg-3",
          )}
        >
          {c || "·"}
        </span>
      ))}
    </div>
  );
}

export function CallSignInput({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, KEY_LEN - 1);

  return (
    <div className={cx("relative flex gap-1.5", disabled && "opacity-60")} onClick={() => ref.current?.focus()}>
      {Array.from({ length: KEY_LEN }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={cx(
            cell,
            "h-14 flex-1 bg-deep text-2xl",
            focused && i === active ? "border-lamp" : "border-line-2",
            value[i] ? "text-fg" : "text-fg-3",
          )}
        >
          {value[i] ?? ""}
        </span>
      ))}
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(normalizeKey(e.target.value))}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={KEY_LEN}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        aria-label="Peer key"
        className="absolute inset-0 w-full cursor-text bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent disabled:cursor-not-allowed"
      />
    </div>
  );
}
