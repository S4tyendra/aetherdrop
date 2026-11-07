import { Store } from "./store";

export type ToastTone = "info" | "ok" | "bad";
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; text: string; tone: ToastTone; action?: ToastAction };

export const toasts = new Store<{ items: Toast[] }>({ items: [] });

let seq = 0;

export const dismiss = (id: number) => toasts.set((s) => ({ items: s.items.filter((t) => t.id !== id) }));

export function toast(text: string, tone: ToastTone = "info", action?: ToastAction) {
  const id = ++seq;
  toasts.set((s) => ({ items: [...s.items, { id, text, tone, action }].slice(-4) }));
  setTimeout(() => dismiss(id), action ? 7000 : 4000);
}
