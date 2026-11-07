// WebSocket client for the signaling hub (main.go / hub.go) with backoff reconnect.

export const WS_URL: string = import.meta.env.PUBLIC_WS_URL ?? "wss://p2p.devh.in/ws";

// Our own STUN responder (stun.go) on the signaling VPS, one URL per address
// family so browsers learn both their public IPv4 and IPv6 addresses.
// STUN only, no TURN: media and files never relay through any server.
const STUN_V4 = import.meta.env.PUBLIC_STUN_V4 ?? "178.105.80.149:23478";
const STUN_V6 = import.meta.env.PUBLIC_STUN_V6 ?? "[2a01:4f8:1c19:fb77::1]:23478";
export const ICE: RTCIceServer[] = [{ urls: [`stun:${STUN_V4}`, `stun:${STUN_V6}`] }];

export type RoomInfo = {
  id: string;
  name: string;
  locked: boolean;
  members: number;
  max: number;
  createdAt: number;
};

export type PeerInfo = { id: string; client: string; name?: string };

export type HubMsg =
  | { type: "welcome"; id: string; rooms: RoomInfo[] }
  | { type: "rooms"; rooms: RoomInfo[] }
  | { type: "created"; room: RoomInfo }
  | { type: "create-error"; reason: string }
  | { type: "joined"; room: RoomInfo; self: string; peers: PeerInfo[] }
  | { type: "join-error"; reason: string }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; peer: PeerInfo }
  | { type: "left" }
  | { type: "signal"; from: string; data: any };

type Handlers = {
  onOpen?: () => void;
  onLost?: (retryMs: number) => void;
  onMessage: (msg: HubMsg) => void;
};

export function createHub(h: Handlers) {
  let ws: WebSocket | null = null;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watching = false;

  function connect() {
    if (!watching) {
      watching = true;
      // Reconnect at once when the tab comes back (tab switch, screen on).
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && (!ws || ws.readyState === WebSocket.CLOSED)) {
          clearTimeout(timer);
          delay = 1000;
          connect();
        }
      });
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      delay = 1000;
      h.onOpen?.();
    };
    ws.onerror = (e) => console.warn("WS error", e);
    ws.onclose = () => {
      ws = null;
      h.onLost?.(delay);
      timer = setTimeout(() => {
        delay = Math.min(delay * 2, 30000);
        connect();
      }, delay);
    };
    ws.onmessage = (ev) => {
      try {
        h.onMessage(JSON.parse(ev.data));
      } catch (e) {
        console.warn("bad hub message", e);
      }
    };
  }

  function send(obj: unknown) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  return { connect, send };
}

export type Tone = "muted" | "ok" | "lamp" | "bad";
export type Status = { tone: Tone; label: string };

export const CODE_LEN = 5;
export const normalizeCode = (v: string) =>
  v
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LEN);

export const normalizePin = (v: string) => v.replace(/\D/g, "").slice(0, 8);

export const JOIN_ERRORS: Record<string, string> = {
  not_found: "This room doesn't exist anymore",
  full: "This room already has 2 people",
  bad_pin: "Wrong PIN",
  pin_required: "This room needs a PIN",
  too_many_attempts: "Too many wrong PINs, try again in 5 minutes",
};

export const CREATE_ERRORS: Record<string, string> = {
  bad_pin_format: "A PIN is 4 to 8 digits",
  too_many_rooms: "The server is at its room limit",
  too_many_rooms_ip: "You have 10 rooms open already",
};

/** Hand-off from the lobby to the room page, so the PIN never goes in the URL. */
export const handoff = {
  set(id: string, pin: string) {
    try {
      sessionStorage.setItem(`aether:join:${id}`, pin);
    } catch {}
  },
  take(id: string): string | null {
    try {
      const v = sessionStorage.getItem(`aether:join:${id}`);
      sessionStorage.removeItem(`aether:join:${id}`);
      return v;
    } catch {
      return null;
    }
  },
};

export const roomUrl = (id: string) => `/room/?r=${encodeURIComponent(id)}`;
