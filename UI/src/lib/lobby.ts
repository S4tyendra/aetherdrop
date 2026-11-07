import { CREATE_ERRORS, createHub, handoff, roomUrl, type RoomInfo, type Status } from "./signal";
import { Store } from "./store";
import { toast } from "./toast";

export type LobbyState = {
  status: Status;
  rooms: RoomInfo[];
  loaded: boolean;
  creating: boolean;
};

export const lobby = new Store<LobbyState>({
  status: { tone: "muted", label: "Connecting" },
  rooms: [],
  loaded: false,
  creating: false,
});

let pendingPin = "";

const hub = createHub({
  onOpen: () => lobby.set({ status: { tone: "ok", label: "Signal online" } }),
  onLost: (ms) => lobby.set({ status: { tone: "lamp", label: `Signal lost, retrying in ${Math.round(ms / 1000)}s` } }),
  onMessage: (m) => {
    if (m.type === "welcome" || m.type === "rooms") lobby.set({ rooms: m.rooms, loaded: true });
    if (m.type === "created") {
      handoff.set(m.room.id, pendingPin);
      location.href = roomUrl(m.room.id);
    }
    if (m.type === "create-error") {
      lobby.set({ creating: false });
      toast(CREATE_ERRORS[m.reason] ?? `Couldn't create the room (${m.reason})`, "bad");
    }
  },
});

export function createRoom(name: string, pin: string) {
  pendingPin = pin;
  lobby.set({ creating: true });
  hub.send({ type: "create", name, pin });
}

export function joinRoom(id: string, pin: string) {
  handoff.set(id, pin);
  location.href = roomUrl(id);
}

let started = false;
export function startLobby() {
  if (started) return;
  started = true;
  hub.connect();
}
