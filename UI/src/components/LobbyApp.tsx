import { Dices, Lock } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BLOCK_SIZE, K, M, N, SHARD_SIZE } from "../lib/files";
import { createRoom, joinRoom, lobby, startLobby } from "../lib/lobby";
import { randomRoomName } from "../lib/profile";
import { normalizePin, type RoomInfo } from "../lib/signal";
import { useStore } from "../lib/store";
import { CallSign } from "./CallSign";
import { Shell } from "./Shell";
import { Button, Card, ICON, Row, cx } from "./ui";

const pinField =
  "h-8 min-w-0 flex-1 rounded-lg border border-line-2 bg-deep px-3 font-mono text-sm tracking-[0.2em] text-fg outline-none transition-[border-color] duration-150 placeholder:tracking-normal placeholder:text-fg-3 focus:border-fg-3";

const field =
  "h-10 w-full rounded-[10px] border border-line-2 bg-deep px-3 text-sm text-fg outline-none transition-[border-color] duration-150 placeholder:text-fg-3 focus:border-fg-3";

/** `children` is static, server-rendered page content (see pages/index.astro). */
export default function LobbyApp({ children }: { children?: ReactNode }) {
  const s = useStore(lobby);
  useEffect(startLobby, []);

  return (
    <Shell tagline="" status={s.status}>
      <section className="mb-8 max-w-3xl">
        <h1 className="text-3xl leading-tight font-medium tracking-tight text-fg md:text-4xl">A direct line for two</h1>
        <p className="mt-3 text-base leading-6 text-fg-2">
          Private video calls, screen sharing, chat, file transfer and games between two browsers. No account, no install, and
          nothing you send passes through our server
        </p>
      </section>
      <div className="grid animate-enter grid-cols-1 items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)] lg:grid-rows-[auto_1fr]">
        <CreateCard creating={s.creating} online={s.loaded && s.status.tone === "ok"} />
        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <RoomList rooms={s.rooms} loaded={s.loaded} />
        </div>
        <CodingCard />
      </div>
      {children}
    </Shell>
  );
}

function CreateCard({ creating, online }: { creating: boolean; online: boolean }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const pinOk = pin === "" || pin.length >= 4;
  // Picked after hydration so server and client markup agree.
  useEffect(() => setName(randomRoomName()), []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pinOk && !creating && online) createRoom(name.trim(), pin);
  };

  return (
    <Card title="New room">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm text-fg-2">Name</span>
          <div className="relative">
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="Room name" className={cx(field, "pr-10")} />
            <button
              type="button"
              onClick={() => setName(randomRoomName())}
              aria-label="Pick another name"
              title="Pick another name"
              className="absolute top-1 right-1 flex size-8 items-center justify-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-raised hover:text-fg"
            >
              <Dices {...ICON} />
            </button>
          </div>
        </label>
        <label className="flex flex-col gap-2">
          <span className="flex items-baseline justify-between text-sm text-fg-2">
            PIN
            <span className="text-xs text-fg-3">Optional, 4 to 8 digits</span>
          </span>
          <input
            value={pin}
            onChange={(e) => setPin(normalizePin(e.target.value))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="No PIN"
            className={cx(field, "font-mono tracking-[0.2em] tabular")}
          />
        </label>
        <Button type="submit" variant="primary" disabled={!pinOk || creating || !online}>
          {!online ? "Connecting" : creating ? "Creating" : "Create room"}
        </Button>
        <p className="text-xs leading-4 text-fg-3">Two people per room. Empty rooms close after 10 minutes</p>
      </form>
    </Card>
  );
}

function age(ms: number, now: number) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

function RoomList({ rooms, loaded }: { rooms: RoomInfo[]; loaded: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card title="Rooms" aside={<span className="font-mono text-xs text-fg-3 tabular">{rooms.length} open</span>}>
      {!loaded ? (
        <p className="border-t border-line py-12 text-center text-sm text-fg-3">Loading rooms</p>
      ) : rooms.length === 0 ? (
        <p className="border-t border-line py-12 text-center text-sm text-fg-3">No rooms yet, create the first one</p>
      ) : (
        <ul>
          {rooms.map((r) => (
            <RoomRow key={r.id} r={r} now={now} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RoomRow({ r, now }: { r: RoomInfo; now: number }) {
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const full = r.members >= r.max;

  return (
    <li className="border-t border-line py-3">
      <div className="flex min-h-10 items-start gap-4">
        <div className="mt-1.5 shrink-0">
          <CallSign value={r.id} size="sm" label={`Room code ${r.id}`} />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-fg">{r.name}</span>
            {r.locked && <Lock size={14} strokeWidth={1.5} className="shrink-0 text-fg-3" aria-label="PIN required" />}
          </div>
          <div className="mt-0.5 text-xs text-fg-3">{age(r.createdAt, now)}</div>
          {asking && !full && (
            <form
              className="mt-3 flex max-w-72 animate-enter gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (pin.length >= 4) joinRoom(r.id, pin);
              }}
            >
              <input
                autoFocus
                value={pin}
                onChange={(e) => setPin(normalizePin(e.target.value))}
                inputMode="numeric"
                type="password"
                autoComplete="off"
                data-1p-ignore
                data-bwignore
                data-lpignore="true"
                placeholder="PIN"
                aria-label={`PIN for ${r.name}`}
                className={pinField}
              />
              <Button type="submit" variant="primary" size="sm" className="shrink-0" disabled={pin.length < 4}>
                Enter
              </Button>
            </form>
          )}
        </div>
        <div className="hidden items-center gap-2 self-start pt-3 sm:flex" aria-label={`${r.members} of ${r.max} people`}>
          {Array.from({ length: r.max }, (_, i) => (
            <span key={i} className={cx("size-2 rounded-full", i < r.members ? "bg-ok" : "border border-line-2")} />
          ))}
          <span className="w-12 font-mono text-xs text-fg-3 tabular">
            {r.members} of {r.max}
          </span>
        </div>
        <Button
          size="sm"
          className="w-20 shrink-0 self-start mt-1"
          disabled={full}
          onClick={() => (r.locked ? setAsking((v) => !v) : joinRoom(r.id, ""))}
        >
          {full ? "Full" : asking ? "Cancel" : "Join"}
        </Button>
      </div>
    </li>
  );
}

function CodingCard() {
  return (
    <Card title="How files travel">
      <div className="rounded-xl bg-deep p-4">
        <div className="flex items-end gap-3">
          <div className="flex flex-1 gap-0.5">
            {Array.from({ length: K }, (_, i) => (
              <span key={i} className="h-8 flex-1 rounded-[2px] bg-shard" />
            ))}
          </div>
          <div className="flex w-[22%] gap-0.5">
            {Array.from({ length: M }, (_, i) => (
              <span key={i} className="h-8 flex-1 rounded-[2px] bg-parity" />
            ))}
          </div>
        </div>
        <div className="mt-2 flex gap-3 font-mono text-xs text-fg-3">
          <span className="flex-1">{K} data</span>
          <span className="w-[22%]">{M} parity</span>
        </div>
      </div>
      <p className="mt-4 text-sm leading-5 text-fg-2">
        Any {K} of the {N} shards rebuild a block, so up to {M} lost packets per block cost no resend
      </p>
      <dl className="mt-4">
        <Row label="Route">Browser to browser</Row>
        <Row label="Shard">{SHARD_SIZE / 1024} KB</Row>
        <Row label="Block">{BLOCK_SIZE / 1024} KB</Row>
        <Row label="Code">Cauchy Reed-Solomon</Row>
      </dl>
    </Card>
  );
}
