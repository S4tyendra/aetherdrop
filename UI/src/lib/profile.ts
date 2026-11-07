// The visitor's display name, kept in localStorage and shown to the other person.

import { Store } from "./store";

const KEY = "aether:nick";
export const NICK_MAX = 24;

/** loaded stays false through server render and hydration, so markup matches. */
export const profile = new Store<{ loaded: boolean; nick: string; editing: boolean }>({ loaded: false, nick: "", editing: false });

export function loadProfile() {
  let nick = "";
  try {
    nick = localStorage.getItem(KEY) ?? "";
  } catch {}
  profile.set({ loaded: true, nick });
}

export function saveNick(raw: string) {
  const nick = raw.trim().slice(0, NICK_MAX);
  if (!nick) return;
  try {
    localStorage.setItem(KEY, nick);
  } catch {}
  profile.set({ nick, editing: false });
}

export const editNick = (editing: boolean) => profile.set({ editing });

const ADJ = ["Amber", "Quiet", "Copper", "Silver", "Late", "North", "Velvet", "Hollow", "Bright", "Paper", "Slow", "Salt", "Cedar", "Iron", "Lunar", "Misty"];
const NOUN = ["Harbor", "Lantern", "Signal", "Orchard", "Comet", "Atlas", "Meadow", "Relay", "Beacon", "Canyon", "Ferry", "Pine", "Station", "Tide", "Window", "Radio"];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
export const randomRoomName = () => `${pick(ADJ)} ${pick(NOUN)}`;
