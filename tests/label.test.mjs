import { test } from "node:test";
import assert from "node:assert/strict";
import { fillLabel, bumpLabel, shortDate, docHasLabel } from "../src/label.ts";

const doc = () => ({ version: 1, name: "P", variables: [], features: [
  { id: "a", name: "Caja", type: "box", op: "new", x: "0", y: "0", z: "0", w: "10", d: "10", h: "10" },
  { id: "t", name: "Etiqueta", type: "text", text: "{v} · {fecha}", font: "sans-bold", size: "5", depth: "0.6", angle: "0", points: [], op: "cut" }] });

test("etiqueta: huecos {v} {n} {fecha}", () => {
  assert.equal(fillLabel("{v} · {fecha}", { n: 3, date: "25-nov" }), "v3 · 25-nov");
  assert.equal(fillLabel("Prueba {n}", { n: 12, date: "1-ene" }), "Prueba 12");
  assert.equal(shortDate(new Date(2026, 10, 25)), "25-nov");
});

test("etiqueta: sube al imprimir", () => {
  const d = doc();
  assert.equal(docHasLabel(d), true);
  assert.deepEqual(bumpLabel(d, new Date(2026, 10, 25)), { n: 1, date: "25-nov" });
  assert.deepEqual(bumpLabel(d, new Date(2026, 11, 2)), { n: 2, date: "2-dic" });
  assert.equal(fillLabel(d.features[1].text, d.label), "v2 · 2-dic");
  // sin etiqueta no cambia nada
  const e = doc(); e.features[1].text = "Hola";
  assert.equal(bumpLabel(e), null); assert.equal(e.label, undefined);
});
