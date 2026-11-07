// Received blocks, kept on this device in IndexedDB so a transfer can resume later.
//
// Blocks are stored under the file's content ID, never the room, so half a file
// received in one room and the rest in another still add up to one file.
//
//   meta    fileId → StashItem
//   blocks  [fileId, blockIdx] → Blob (verified against its SHA-256 before it is written)

import { Store } from "./store";

export type StashItem = {
  fileId: string;
  fileName: string;
  fileSize: number;
  totalBlocks: number;
  /** Blocks stored so far. */
  stored: number;
  from: string;
  updatedAt: number;
  complete: boolean;
};

export type StashState = {
  supported: boolean;
  items: StashItem[];
  usage: number | null;
  quota: number | null;
};

export const stash = new Store<StashState>({ supported: true, items: [], usage: null, quota: null });

const DB = "tincan-files";
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "fileId" });
      if (!d.objectStoreNames.contains("blocks")) d.createObjectStore("blocks");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp.catch(() => {
    dbp = null;
    stash.set({ supported: false });
  });
  return dbp;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const range = (fileId: string) => IDBKeyRange.bound([fileId, 0], [fileId, Infinity]);

export async function getMeta(fileId: string): Promise<StashItem | undefined> {
  const d = await db();
  return result(d.transaction("meta").objectStore("meta").get(fileId));
}

export async function putMeta(item: StashItem) {
  const d = await db();
  const tx = d.transaction("meta", "readwrite");
  tx.objectStore("meta").put(item);
  await done(tx);
  refreshSoon();
}

/** Indexes of the blocks already stored for this file. */
export async function heldBlocks(fileId: string): Promise<Set<number>> {
  try {
    const d = await db();
    const keys = await result(d.transaction("blocks").objectStore("blocks").getAllKeys(range(fileId)));
    return new Set(keys.map((k) => (k as [string, number])[1]));
  } catch {
    return new Set();
  }
}

/** Store one verified block and bump the file's progress in the same transaction. */
export async function putBlock(fileId: string, idx: number, data: Blob) {
  const d = await db();
  const tx = d.transaction(["blocks", "meta"], "readwrite");
  tx.objectStore("blocks").put(data, [fileId, idx]);
  const metaStore = tx.objectStore("meta");
  const req = metaStore.get(fileId);
  req.onsuccess = () => {
    const m = req.result as StashItem | undefined;
    if (!m) return;
    m.stored = Math.min(m.totalBlocks, m.stored + 1);
    m.updatedAt = Date.now();
    metaStore.put(m);
  };
  await done(tx);
  refreshSoon();
}

/** The whole file as one Blob, in block order. Browsers back these blobs with disk, not memory. */
export async function readFile(fileId: string): Promise<Blob> {
  const d = await db();
  const parts = await result(d.transaction("blocks").objectStore("blocks").getAll(range(fileId)));
  return new Blob(parts as Blob[]);
}

export async function removeFile(fileId: string) {
  const d = await db();
  const tx = d.transaction(["blocks", "meta"], "readwrite");
  tx.objectStore("blocks").delete(range(fileId));
  tx.objectStore("meta").delete(fileId);
  await done(tx);
  await refreshStash();
}

export async function removeAll() {
  const d = await db();
  const tx = d.transaction(["blocks", "meta"], "readwrite");
  tx.objectStore("blocks").clear();
  tx.objectStore("meta").clear();
  await done(tx);
  await refreshStash();
}

/** Ask the browser not to evict stored blocks under storage pressure. */
export async function askPersist() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist?.();
  } catch {}
}

export async function refreshStash() {
  try {
    const d = await db();
    const items = (await result(d.transaction("meta").objectStore("meta").getAll())) as StashItem[];
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    let usage: number | null = null;
    let quota: number | null = null;
    try {
      const est = await navigator.storage?.estimate?.();
      usage = est?.usage ?? null;
      quota = est?.quota ?? null;
    } catch {}
    stash.set({ supported: true, items, usage, quota });
  } catch {
    stash.set({ supported: false, items: [] });
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshStash();
  }, 500);
}

/** Save a stored file to the user's downloads. */
export async function saveFile(item: Pick<StashItem, "fileId" | "fileName">) {
  const blob = await readFile(item.fileId);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: item.fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
