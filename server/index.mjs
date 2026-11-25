// geometria-datos: guarda las piezas de Geometría en el servidor.
// Node puro, sin librerías de fuera. Solo le habla el Caddy de Geometría, por una red interna
// de Docker sin internet. Todo lo que guarda va dentro de DATA (y nada más): en el servidor,
// /srv/apps/geometria/datos, que entra en la copia de cada noche (restic copia todo /srv).
//
//   GET    /api/salud                 → { ok, piezas, bytes }
//   GET    /api/piezas                → [{ id, name, updated, rev }]
//   GET    /api/piezas/:id            → { id, name, updated, rev, doc, thumb?, versions? }
//   PUT    /api/piezas/:id            ← { base, name, updated, doc, thumb?, versions? }  → { rev } | 409 { rev }
//   DELETE /api/piezas/:id            → a la papelera (se borra sola a los 30 días)
//   HEAD/GET/PUT /api/archivos/:id    → STEP, STL e imágenes importadas (binario)
import { createServer } from "node:http";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA = process.env.DATA || "/data";
const PORT = Number(process.env.PORT || 8090);
const MAX_BODY = Number(process.env.MAX_BODY || 25 * 1024 * 1024); // por petición
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 2 * 1024 * 1024 * 1024); // todo junto
const TRASH_DAYS = Number(process.env.TRASH_DAYS || 30);

const DIR = { piezas: join(DATA, "piezas"), archivos: join(DATA, "archivos"), papelera: join(DATA, "papelera") };
/** nombres seguros: solo letras, números, guion y guion bajo (nada de «../») */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** lo que hay en la carpeta piezas/, en memoria: id → resumen */
const index = new Map();
let totalBytes = 0;

async function du(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile()) n += (await stat(join(dir, e.name))).size;
  }
  return n;
}

/** false si no se puede escribir en DATA (carpeta de otro dueño): la página lo enseña como «sin conexión» */
let writable = true;

async function load() {
  try {
    for (const d of Object.values(DIR)) await mkdir(d, { recursive: true });
    await writeAtomic(join(DATA, ".prueba"), "ok");
  } catch (e) {
    writable = false;
    console.error(`No puedo escribir en ${DATA} (${e.code}). Arreglo: sudo chown -R 1000:1000 <carpeta datos>`);
    return;
  }
  for (const name of await readdir(DIR.piezas)) {
    if (!name.endsWith(".json")) continue;
    try {
      const p = JSON.parse(await readFile(join(DIR.piezas, name), "utf8"));
      if (ID.test(p.id)) index.set(p.id, { id: p.id, name: String(p.name ?? ""), updated: Number(p.updated) || 0, rev: Number(p.rev) || 1 });
    } catch { /* un fichero roto no tumba el servicio */ }
  }
  totalBytes = (await du(DIR.piezas)) + (await du(DIR.archivos)) + (await du(DIR.papelera));
}

/** escribir sin dejar ficheros a medias: primero a uno temporal y luego se renombra */
async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function purgeTrash() {
  const limit = Date.now() - TRASH_DAYS * 86400000;
  for (const name of await readdir(DIR.papelera).catch(() => [])) {
    const p = join(DIR.papelera, name);
    const s = await stat(p).catch(() => null);
    if (s && s.mtimeMs < limit) { totalBytes -= s.size; await unlink(p).catch(() => {}); }
  }
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  const data = body === undefined ? "" : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] || 0);
    if (len > MAX_BODY) return reject(Object.assign(new Error("demasiado grande"), { code: 413 }));
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) { req.destroy(); reject(Object.assign(new Error("demasiado grande"), { code: 413 })); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validPiece(p) {
  const d = p?.doc;
  return d && d.version === 1 && Array.isArray(d.features) && Array.isArray(d.variables) && typeof p.name === "string" && p.name.length <= 200;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // api, piezas, id
  if (parts[0] !== "api") return send(res, 404, { error: "no existe" });
  const [, kind, id, extra] = parts;
  if (extra !== undefined || (id !== undefined && !ID.test(id))) return send(res, 400, { error: "nombre no válido" });

  if (kind === "salud" && req.method === "GET") return send(res, writable ? 200 : 503, { ok: writable, piezas: index.size, bytes: totalBytes });
  if (!writable) return send(res, 503, { error: "no puedo escribir en la carpeta de datos" });

  if (kind === "piezas") {
    if (!id) {
      if (req.method !== "GET") return send(res, 405, { error: "método no permitido" });
      return send(res, 200, [...index.values()].sort((a, b) => b.updated - a.updated));
    }
    const file = join(DIR.piezas, `${id}.json`);
    if (req.method === "GET") {
      if (!index.has(id)) return send(res, 404, { error: "no existe" });
      return send(res, 200, await readFile(file), "application/json; charset=utf-8");
    }
    if (req.method === "PUT") {
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "solo JSON" });
      let p;
      try { p = JSON.parse((await readBody(req)).toString("utf8")); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? "demasiado grande" : "JSON roto" }); }
      if (!validPiece(p)) return send(res, 400, { error: "no es una pieza de Geometría" });
      const cur = index.get(id);
      // otro equipo la guardó después de la que tú tenías: no se pisa
      if (cur && Number(p.base) !== cur.rev) return send(res, 409, { rev: cur.rev });
      const rev = (cur?.rev ?? 0) + 1;
      const out = JSON.stringify({ id, name: p.name, updated: Number(p.updated) || Date.now(), rev, doc: p.doc, thumb: typeof p.thumb === "string" ? p.thumb : undefined, versions: Array.isArray(p.versions) ? p.versions : undefined });
      const old = cur ? (await stat(file).catch(() => ({ size: 0 }))).size : 0;
      if (totalBytes - old + out.length > MAX_TOTAL) return send(res, 507, { error: "el espacio de Geometría está lleno" });
      await writeAtomic(file, out);
      totalBytes += out.length - old;
      index.set(id, { id, name: p.name, updated: Number(p.updated) || Date.now(), rev });
      return send(res, 200, { rev });
    }
    if (req.method === "DELETE") {
      if (!index.has(id)) return send(res, 200, { ok: true }); // ya no estaba: da igual
      await rename(file, join(DIR.papelera, `${id}-${Date.now()}.json`));
      index.delete(id);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: "método no permitido" });
  }

  if (kind === "archivos" && id) {
    const file = join(DIR.archivos, id);
    if (req.method === "HEAD" || req.method === "GET") {
      const s = await stat(file).catch(() => null);
      if (!s) return send(res, 404, req.method === "HEAD" ? undefined : { error: "no existe" });
      if (req.method === "HEAD") { res.writeHead(200, { "Content-Length": s.size }); return res.end(); }
      return send(res, 200, await readFile(file), "application/octet-stream");
    }
    if (req.method === "PUT") {
      let buf;
      try { buf = await readBody(req); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: "no se pudo leer" }); }
      if (!buf.length) return send(res, 400, { error: "vacío" });
      const s = await stat(file).catch(() => null);
      if (s) return send(res, 200, { ok: true }); // mismo id = mismo contenido (es su huella)
      if (totalBytes + buf.length > MAX_TOTAL) return send(res, 507, { error: "el espacio de Geometría está lleno" });
      await writeAtomic(file, buf);
      totalBytes += buf.length;
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: "método no permitido" });
  }
  return send(res, 404, { error: "no existe" });
}

await load();
if (writable) await purgeTrash();
setInterval(() => purgeTrash().catch(() => {}), 86400000).unref();
createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: "error interno" }); else res.end(); });
}).listen(PORT, () => console.log(`geometria-datos en :${PORT}, datos en ${DATA}, ${index.size} piezas`));
