// Archivos importados (STEP/STL). Pueden pesar varios MB, así que no van en el
// documento (localStorage tiene poco sitio) sino en IndexedDB, por id.
// Al descargar el proyecto (.json) se meten dentro en base64 para poder llevarlo a otro equipo.

export interface StoredFile { name: string; format: "step" | "stl"; data: ArrayBuffer }

const DB = "geometria-archivos";
const STORE = "archivos";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(req.result); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}

export const files = {
  put: (id: string, f: StoredFile) => tx("readwrite", (s) => s.put(f, id)).then(() => undefined),
  get: (id: string) => tx<StoredFile | undefined>("readonly", (s) => s.get(id)).catch(() => undefined),
};

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** id estable a partir del contenido: el mismo archivo importado dos veces se guarda una vez */
export async function fileId(buf: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
