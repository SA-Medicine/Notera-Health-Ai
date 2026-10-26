// The recording is kept in this browser (IndexedDB) from the first second until the server confirms it has it. A refresh, a closed tab, a
// crashed browser or a failed upload no longer loses a visit: on the next page load the unfinished recording is found and saved again.
// Only this clinician's own browser holds it, and it is deleted as soon as the upload is confirmed.

type Meta = { id: string; consultId: string; mime: string; startedAt: number; stoppedAt?: number; transcript?: string; uploaded?: boolean }

const DB = 'notera-audio'; const META = 'sessions'; const CHUNKS = 'chunks';
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') { rej(new Error('no IndexedDB')); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' }); if (!d.objectStoreNames.contains(CHUNKS)) d.createObjectStore(CHUNKS, { autoIncrement: true }).createIndex('sid', 'sid'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
const tx = async (stores: string[], mode: IDBTransactionMode) => (await db()).transaction(stores, mode);
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Start keeping a recording. Never throws: the vault is a safety net, recording works without it. */
export async function vaultStart(m: Meta) { try { const t = await tx([META], 'readwrite'); t.objectStore(META).put(m); await done(t); } catch { /* private window: no vault */ } }
export async function vaultUpdate(id: string, patch: Partial<Meta>) {
  try { const t = await tx([META], 'readwrite'); const s = t.objectStore(META); const cur = await req(s.get(id)) as Meta | undefined; if (cur) s.put({ ...cur, ...patch }); await done(t); } catch { /* */ }
}
export async function vaultChunk(id: string, blob: Blob) { try { const t = await tx([CHUNKS], 'readwrite'); t.objectStore(CHUNKS).add({ sid: id, blob }); await done(t); } catch { /* */ } }
/** The whole recording as kept, in order. */
export async function vaultBlob(id: string, mime: string): Promise<Blob | null> {
  try { const t = await tx([CHUNKS], 'readonly'); const rows = await req(t.objectStore(CHUNKS).index('sid').getAll(id)) as { blob: Blob }[]; return rows.length ? new Blob(rows.map((r) => r.blob), { type: mime }) : null; } catch { return null; }
}
/** Forget a recording (after the server confirmed the upload). */
export async function vaultDrop(id: string) {
  try {
    const t = await tx([META, CHUNKS], 'readwrite'); t.objectStore(META).delete(id);
    const idx = t.objectStore(CHUNKS).index('sid'); const keys = await req(idx.getAllKeys(id)); for (const k of keys) t.objectStore(CHUNKS).delete(k);
    await done(t);
  } catch { /* */ }
}
/** Recordings still waiting to be saved on the server. */
export async function vaultPending(): Promise<Meta[]> { try { const t = await tx([META], 'readonly'); return ((await req(t.objectStore(META).getAll())) as Meta[]).filter((m) => !m.uploaded); } catch { return []; } }
export type { Meta as VaultMeta };
