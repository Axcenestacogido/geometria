import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "geometria-datos-"));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${PORT}/api`;
const doc = { version: 1, name: "A", variables: [], features: [] };
const put = (id, body) => fetch(`${B}/piezas/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("geometria-datos: guardar, choque entre equipos, nombres raros y papelera", async (t) => {
  const srv = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DATA, PORT: String(PORT), MAX_TOTAL: "200000" }, stdio: "pipe" });
  t.after(() => srv.kill());
  await new Promise((r) => srv.stdout.once("data", r));

  assert.equal((await put("p1", { base: 0, name: "A", updated: 1, doc })).status, 200);
  assert.deepEqual(await (await put("p1", { base: 1, name: "A", updated: 2, doc })).json(), { rev: 2 });
  // otro equipo que aún tenía la revisión 1: no pisa
  const c = await put("p1", { base: 1, name: "A", updated: 3, doc });
  assert.equal(c.status, 409);
  assert.deepEqual(await c.json(), { rev: 2 });
  // lo que no es una pieza, fuera
  assert.equal((await put("p2", { base: 0, name: "x", doc: { hola: 1 } })).status, 400);
  // nada de salir de la carpeta
  assert.equal((await fetch(`${B}/piezas/..%2F..%2Fetc`)).status, 400);
  assert.equal((await fetch(`${B}/archivos/a.b`, { method: "PUT", body: "x" })).status, 400);
  // el espacio tiene tope
  const big = { ...doc, features: [{ id: "x", type: "box", blob: "x".repeat(250000) }] };
  assert.equal((await put("p3", { base: 0, name: "Grande", doc: big })).status, 507);
  // borrar = a la papelera
  assert.equal((await fetch(`${B}/piezas/p1`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await (await fetch(`${B}/piezas`)).json(), []);
  assert.equal(readdirSync(join(DATA, "papelera")).length, 1);
});
