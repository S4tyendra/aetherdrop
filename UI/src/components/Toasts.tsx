import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useStore } from "../lib/store";
import { dismiss, toasts } from "../lib/toast";
import { ICON, cx } from "./ui";

export function Toasts() {
  const { items } = useStore(toasts);
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 md:inset-x-auto md:right-8 md:bottom-8">
      {items.map((t) => {
        const Icon = t.tone === "ok" ? CircleCheck : t.tone === "bad" ? CircleAlert : Info;
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex max-w-sm animate-enter items-center gap-2 rounded-xl border border-line bg-raised py-3 pr-4 pl-3 text-sm text-fg shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
          >
            <Icon {...ICON} className={cx("shrink-0", t.tone === "ok" ? "text-ok" : t.tone === "bad" ? "text-bad" : "text-fg-3")} />
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
                className="-my-1 ml-2 h-7 shrink-0 rounded-md bg-hover px-2 text-xs font-medium text-fg transition-colors duration-150 hover:bg-line-2"
              >
                {t.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
