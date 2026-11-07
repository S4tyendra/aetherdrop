import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Tone } from "../lib/signal";

export const ICON = { size: 16, strokeWidth: 1.5 } as const;

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-line bg-card p-5", className)}>
      {(title || aside) && (
        <header className="mb-4 flex h-6 items-center justify-between gap-4">
          <h2 className="text-[15px] font-medium text-fg">{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** Height lives here, not in className: a second h-* class would lose to h-10 in the stylesheet. */
  size?: "md" | "sm";
};

export function Button({ variant = "secondary", size = "md", className, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 text-sm font-medium",
        variant === "ghost" ? "size-8 rounded-lg" : size === "sm" ? "h-8 rounded-lg px-3" : "h-10 rounded-[10px] px-4",
        "transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-40",
        variant === "primary" &&
          "bg-fg text-page shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] hover:bg-white disabled:bg-raised disabled:text-fg-3 disabled:opacity-100 disabled:shadow-none",
        variant === "secondary" &&
          "border border-line bg-raised text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:bg-hover",
        variant === "danger" && "border border-line bg-raised text-bad hover:bg-hover",
        variant === "ghost" && "text-fg-3 hover:bg-raised hover:text-fg",
        className,
      )}
    />
  );
}

const toneColor: Record<Tone, string> = {
  muted: "bg-fg-3",
  ok: "bg-ok",
  lamp: "bg-lamp",
  bad: "bg-bad",
};

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-1.5 shrink-0 rounded-full", toneColor[tone], className)} />;
}

/** A labelled figure in a row of stats. */
export function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-fg-3">{label}</div>
      <div className={cx("mt-1 truncate font-mono text-sm tabular", accent ? "text-lamp" : "text-fg")}>{value}</div>
    </div>
  );
}

/** Two-column definition row: label left, mono value right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between gap-4 border-t border-line first:border-t-0">
      <dt className="text-sm text-fg-2">{label}</dt>
      <dd className="truncate font-mono text-sm text-fg tabular">{children}</dd>
    </div>
  );
}
