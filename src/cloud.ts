// Guardado en el servidor (geometria-datos, detrás de Caddy en /api/).
// El navegador sigue guardando todo como antes; esto sube y baja las piezas para que estén
// en todos tus equipos y entren en la copia nocturna. Sin conexión no pasa nada: se queda
// pendiente y se sube al volver.
//
// Cada pieza lleva un número de revisión. Al subir se dice «viene de la revisión N»; si el
// servidor ya tiene otra (la guardó otro equipo), no se pisa: lo tuyo se guarda como copia.
import type { Doc } from "./types";
import { storage, type Version } from "./state";
import { files } from "./files";

export type CloudStatus = "checking" | "on" | "offline" | "none";

/** rev = revisión del servidor que tienes; h = huella de esa versión (para no subir lo que no ha cambiado) */
interface SyncRec { rev: number; h?: string; dirty?: boolean; deleted?: boolean }

/** huella corta de un texto (FNV-1a): basta para saber si una pieza cambió */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
interface ServerMeta { id: string; name: string; updated: number; rev: number }
interface ServerPiece extends ServerMeta { doc: Doc; thumb?: string; versions?: Version[] }

const KEY = "geometria:nube";
const API = "/api";

function readRecs(): Record<string, SyncRec> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function writeRecs(r: Record<string, SyncRec>) {
  try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* sin sitio: se intentará otra vez */ }
}

/** Archivos importados que usa una pieza (STEP/STL, imagen de relieve, imagen de fondo de un boceto) */
export function docFileIds(doc: Doc): string[] {
  const out = new Set<string>();
  for (const f of doc.features) {
    const fid = f.type === "import" || f.type === "relief" ? f.file : f.type === "sketch" ? f.image?.file : undefined;
    if (fid) out.add(fid);
  }
  return [...out];
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T | null }> {
  const r = await fetch(API + path, { ...init, cache: "no-store" });
  const isJson = (r.headers.get("content-type") || "").includes("json");
  return { status: r.status, data: isJson ? ((await r.json()) as T) : null };
}

export interface CloudHooks {
  onStatus?: (s: CloudStatus, pending: number) => void;
  /** otro equipo cambió la pieza «id»: lo tuyo se guardó como «copyId» */
  onConflict?: (id: string, copyId: string) => void;
  /** piezas que han llegado nuevas o cambiadas del servidor */
  onPulled?: (ids: string[]) => void;
}

class Cloud {
  status: CloudStatus = "checking";
  hooks: CloudHooks = {};
  private timer = 0;
  private busy: Promise<void> | null = null;

  /** piezas con cambios sin subir (o borrados sin avisar) */
  pending(): number { return Object.values(readRecs()).filter((r) => r.dirty || r.deleted).length; }

  /** piezas que solo están en este navegador (nunca subidas) */
  localOnly() {
    const recs = readRecs();
    return storage.list().filter((m) => !recs[m.id]);
  }

  private set(s: CloudStatus) {
    this.status = s;
    this.hooks.onStatus?.(s, this.pending());
  }

  async init() {
    try {
      const r = await api<{ ok: boolean }>("/salud");
      // sin geometria-datos detrás (p. ej. la página abierta en local): todo sigue solo en el navegador
      if (r.status === 404 || !r.data?.ok) { this.set(r.status === 404 ? "none" : "offline"); return; }
      this.set("on");
    } catch { this.set("offline"); }
    window.addEventListener("online", () => this.sync());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.sync(); });
    // si no hay conexión, se vuelve a intentar cada 30 s
    setInterval(() => { if (this.status === "offline" || this.pending()) this.sync(); }, 30000);
    if (this.status === "on") await this.sync();
  }

  /**
   * Se acaba de guardar la pieza en este navegador. Si es distinta de la del servidor, se sube en
   * unos segundos. Las piezas que aún no estaban en el servidor empiezan a subirse desde ahora.
   */
  saved(id: string) {
    if (this.status === "none") return;
    const recs = readRecs();
    const doc = storage.load(id);
    if (!doc) return;
    const rec = (recs[id] ??= { rev: 0 });
    if (rec.h && rec.h === hash(JSON.stringify(doc))) return; // igual que la del servidor
    rec.dirty = true;
    writeRecs(recs);
    this.hooks.onStatus?.(this.status, this.pending());
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.sync(), 2000);
  }

  /** sube las piezas que solo estaban en este navegador */
  async uploadLocal(): Promise<number> {
    const ids = this.localOnly().map((m) => m.id);
    const recs = readRecs();
    for (const id of ids) recs[id] = { rev: 0, dirty: true };
    writeRecs(recs);
    await this.sync();
    return ids.length;
  }

  remove(id: string) {
    const recs = readRecs();
    if (!recs[id]) return;
    recs[id] = { ...recs[id], deleted: true, dirty: false };
    writeRecs(recs);
    void this.sync();
  }

  /** sube lo pendiente y baja lo nuevo; una sola cosa a la vez */
  sync(): Promise<void> {
    if (this.status === "none") return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.run().finally(() => { this.busy = null; });
    return this.busy;
  }

  private async run() {
    try {
      await this.pushAll();
      await this.pull();
      this.set("on");
    } catch {
      this.set("offline");
    }
  }

  private async pushAll() {
    const recs = readRecs();
    for (const [id, rec] of Object.entries(recs)) {
      if (rec.deleted) {
        const r = await api(`/piezas/${id}`, { method: "DELETE" });
        if (r.status >= 500) throw new Error("servidor");
        const now = readRecs(); delete now[id]; writeRecs(now);
        continue;
      }
      if (!rec.dirty) continue;
      const doc = storage.load(id);
      if (!doc) { const now = readRecs(); delete now[id]; writeRecs(now); continue; }
      // primero los archivos importados que use (si el servidor no los tiene)
      for (const fid of docFileIds(doc)) {
        const head = await fetch(`${API}/archivos/${fid}`, { method: "HEAD", cache: "no-store" });
        if (head.status === 200) continue;
        const st = await files.get(fid);
        if (st) {
          const up = await fetch(`${API}/archivos/${fid}`, { method: "PUT", body: st.data, headers: { "Content-Type": "application/octet-stream" } });
          if (!up.ok && up.status >= 500) throw new Error("servidor");
        }
      }
      const body = { base: rec.rev, name: doc.name, updated: storage.meta(id)?.updated ?? Date.now(), doc, thumb: storage.thumb(id) ?? undefined, versions: storage.versions(id) };
      const r = await api<{ rev: number }>(`/piezas/${id}`, { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      if (r.status === 200 && r.data) {
        const now = readRecs();
        // si mientras subía la volviste a cambiar, sigue pendiente
        const same = JSON.stringify(storage.load(id)) === JSON.stringify(doc);
        now[id] = { rev: r.data.rev, h: hash(JSON.stringify(doc)), dirty: !same };
        writeRecs(now);
      } else if (r.status === 409) {
        await this.conflict(id, doc);
      } else if (r.status >= 500 || r.status === 0) throw new Error("servidor");
      else {
        // 400/413/507: no se reintenta en bucle; se queda en este navegador
        const now = readRecs(); now[id] = { ...now[id], dirty: false }; writeRecs(now);
        console.warn("Geometría: no se pudo subir", id, r.status, r.data);
      }
    }
  }

  /** otro equipo la cambió: lo tuyo se guarda aparte y la original se pone al día */
  private async conflict(id: string, mine: Doc) {
    const copyId = Math.random().toString(36).slice(2, 9);
    const copy: Doc = { ...JSON.parse(JSON.stringify(mine)), name: `${mine.name} (copia de este equipo)` };
    storage.put(copyId, copy, Date.now());
    const v = storage.versions(id);
    if (v.length) storage.setVersions(copyId, v);
    const recs = readRecs();
    recs[copyId] = { rev: 0, dirty: true };
    recs[id] = { rev: 0, dirty: false };
    writeRecs(recs);
    await this.fetchPiece(id);
    this.hooks.onConflict?.(id, copyId);
    await this.pushAll();
  }

  private async fetchPiece(id: string): Promise<boolean> {
    const r = await api<ServerPiece>(`/piezas/${id}`);
    if (r.status !== 200 || !r.data) return false;
    const p = r.data;
    storage.put(id, p.doc, p.updated);
    if (p.thumb) storage.setThumb(id, p.thumb);
    if (p.versions) storage.setVersions(id, p.versions);
    for (const fid of docFileIds(p.doc)) {
      if (await files.get(fid)) continue;
      const fr = await fetch(`${API}/archivos/${fid}`, { cache: "no-store" });
      if (!fr.ok) continue;
      const st = { name: fid, format: "step" as const, data: await fr.arrayBuffer() };
      // el formato real va en el paso que lo usa; aquí solo hace falta el contenido
      const f = p.doc.features.find((x) => (x.type === "import" || x.type === "relief" ? x.file : x.type === "sketch" ? x.image?.file : "") === fid);
      const format = f?.type === "import" ? f.format : "image";
      await files.put(fid, { ...st, name: f?.type === "import" || f?.type === "relief" ? f.fileName : fid, format });
    }
    const recs = readRecs();
    recs[id] = { rev: p.rev, h: hash(JSON.stringify(p.doc)), dirty: false };
    writeRecs(recs);
    return true;
  }

  private async pull() {
    const r = await api<ServerMeta[]>("/piezas");
    if (r.status !== 200 || !r.data) throw new Error("servidor");
    const recs = readRecs();
    const changed: string[] = [];
    const onServer = new Set(r.data.map((m) => m.id));
    for (const m of r.data) {
      const rec = recs[m.id];
      if (rec?.deleted) continue;
      if (rec?.dirty) continue; // lo tuyo va primero; si choca, se resuelve al subir
      if (!rec || m.rev > rec.rev || !storage.load(m.id)) {
        if (await this.fetchPiece(m.id)) changed.push(m.id);
      }
    }
    // borradas en otro equipo (ya subidas antes y sin cambios aquí): fuera de este navegador también
    for (const [id, rec] of Object.entries(readRecs())) {
      if (rec.rev > 0 && !rec.dirty && !rec.deleted && !onServer.has(id)) {
        storage.remove(id);
        const now = readRecs(); delete now[id]; writeRecs(now);
        changed.push(id);
      }
    }
    if (changed.length) this.hooks.onPulled?.(changed);
  }
}

export const cloud = new Cloud();
