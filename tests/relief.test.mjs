import { test } from "node:test";
import assert from "node:assert/strict";
import { darkGrid, contours, simplify, nest, logoParts, heightGrid, area } from "../src/relief.ts";

/** imagen blanca de w × h con lo que pinte «fn» (true = negro) */
const img = (w, h, fn) => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y) ? 0 : 255;
  return { w, h, data };
};

test("una «O» da una pieza con un agujero", () => {
  const o = img(100, 100, (x, y) => { const r = Math.hypot(x - 50, y - 50); return r < 40 && r > 20; });
  const parts = logoParts(o, { detail: 100, threshold: 50, invert: false, widthMm: 50 });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].holes.length, 1);
  const a = Math.abs(area(parts[0].outer)) - Math.abs(area(parts[0].holes[0]));
  const real = Math.PI * (20 * 20 - 10 * 10); // en mm (la mitad de escala)
  assert.ok(Math.abs(a - real) / real < 0.05, `área ${a} frente a ${real}`);
});

test("una isla dentro del agujero es otra pieza", () => {
  const im = img(100, 100, (x, y) => { const r = Math.hypot(x - 50, y - 50); return (r < 45 && r > 30) || r < 15; });
  const parts = logoParts(im, { detail: 100, threshold: 50, invert: false, widthMm: 100 });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.holes.length).sort(), [0, 1]);
});

test("invertir: lo blanco es la pieza", () => {
  const sq = img(60, 40, (x, y) => x > 20 && x < 40 && y > 10 && y < 30);
  const parts = logoParts(sq, { detail: 60, threshold: 50, invert: true, widthMm: 60 });
  // el marco blanco alrededor del cuadrado: una pieza con un agujero
  assert.equal(parts.length, 1);
  assert.equal(parts[0].holes.length, 1);
});

test("centrado y con Y hacia arriba", () => {
  const top = img(100, 100, (x, y) => y < 30 && x > 40 && x < 60);
  const [p] = logoParts(top, { detail: 100, threshold: 50, invert: false, widthMm: 100 });
  const ys = p.outer.map((q) => q[1]);
  assert.ok(Math.min(...ys) > 15 && Math.max(...ys) <= 50, `y de ${Math.min(...ys)} a ${Math.max(...ys)}`);
});

test("simplificar un cuadrado con muchos puntos deja 4 esquinas", () => {
  const sq = [];
  for (let i = 0; i < 10; i++) sq.push([i, 0]);
  for (let i = 0; i < 10; i++) sq.push([10, i]);
  for (let i = 10; i > 0; i--) sq.push([i, 10]);
  for (let i = 10; i > 0; i--) sq.push([0, i]);
  assert.equal(simplify(sq, 0.1).length, 4);
});

test("rejilla de alturas: oscuro = alto", () => {
  const half = img(40, 20, (x) => x < 20);
  const g = heightGrid(half, { detail: 40, invert: false, base: 1, depth: 3 });
  assert.equal(g.w, 40); assert.equal(g.h, 20);
  assert.ok(Math.abs(g.z[10 * 40 + 2] - 4) < 1e-6);
  assert.ok(Math.abs(g.z[10 * 40 + 37] - 1) < 1e-6);
  const small = darkGrid(half, 10, false);
  assert.equal(small.w, 10); assert.equal(small.h, 5);
});

test("imagen en blanco: sin contornos", () => {
  const blank = img(30, 30, () => false);
  assert.equal(contours(darkGrid(blank, 30, false), 0.5).length, 0);
  assert.equal(nest([]).length, 0);
});

test("el contorno de fuera va antihorario y los agujeros al revés", () => {
  const o = img(100, 100, (x, y) => { const r = Math.hypot(x - 50, y - 50); return r < 40 && r > 20; });
  const [p] = logoParts(o, { detail: 100, threshold: 50, invert: false, widthMm: 50 });
  assert.ok(area(p.outer) > 0);
  assert.ok(area(p.holes[0]) < 0);
});
