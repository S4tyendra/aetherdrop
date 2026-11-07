import { UserRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NICK_MAX, editNick, loadProfile, profile, saveNick } from "../lib/profile";
import type { Status } from "../lib/signal";
import { useStore } from "../lib/store";
import { Logo, SiteFooter } from "./Brand";
import { Toasts } from "./Toasts";
import { Button, Dot, ICON } from "./ui";

export function Shell({ tagline, status, children }: { tagline: string; status: Status; children: ReactNode }) {
  const p = useStore(profile);
  useEffect(loadProfile, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-deep">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-6 px-4 md:px-8">
          <Logo />
          <span className="hidden text-sm text-fg-3 lg:inline">{tagline}</span>
          <div className="ml-auto flex min-w-0 items-center gap-2" role="status" aria-live="polite">
            <Dot tone={status.tone} />
            <span className="truncate text-sm text-fg-2">{status.label}</span>
          </div>
          {p.nick && (
            <button
              onClick={() => editNick(true)}
              className="flex h-8 max-w-40 shrink-0 items-center gap-2 rounded-lg border border-line px-2 text-sm text-fg-2 transition-colors duration-150 hover:bg-raised hover:text-fg"
              aria-label={`Your name, ${p.nick}. Change it`}
            >
              <UserRound {...ICON} className="shrink-0 text-fg-3" />
              <span className="truncate">{p.nick}</span>
            </button>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      <SiteFooter />
      {p.loaded && (!p.nick || p.editing) && <NamePrompt current={p.nick} />}
      <Toasts />
    </div>
  );
}

function NamePrompt({ current }: { current: string }) {
  const [name, setName] = useState(current);
  const first = !current;

  useEffect(() => {
    if (first) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && editNick(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [first]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-deep/80 px-4 backdrop-blur-sm" onMouseDown={(e) => !first && e.target === e.currentTarget && editNick(false)}>
      <form
        role="dialog"
        aria-modal
        aria-labelledby="nick-title"
        className="w-full max-w-sm animate-enter rounded-2xl border border-line-2 bg-card p-6 shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
        onSubmit={(e) => {
          e.preventDefault();
          saveNick(name);
        }}
      >
        <h2 id="nick-title" className="text-lg font-medium text-fg">
          {first ? "What should people call you" : "Change your name"}
        </h2>
        <p className="mt-1 text-sm text-fg-3">The other person in a room sees this name</p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, NICK_MAX))}
          placeholder="Your name"
          aria-label="Your name"
          className="mt-5 h-10 w-full rounded-[10px] border border-line-2 bg-deep px-3 text-sm text-fg outline-none transition-[border-color] duration-150 placeholder:text-fg-3 focus:border-fg-3"
        />
        <div className="mt-4 flex justify-end gap-2">
          {!first && (
            <Button type="button" onClick={() => editNick(false)}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {first ? "Continue" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
