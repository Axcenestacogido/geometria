import { test } from "node:test";
import assert from "node:assert/strict";
import { circleFrom, faceKind, planesAngle } from "../src/measure.ts";

const near = (a, b, t = 1e-3) => assert.ok(Math.abs(a - b) < t, `${a} ≈ ${b}`);

test("arista circular de Ø12 a z = 10: centro, radio y vuelta entera", () => {
  const pts = Array.from({ length: 49 }, (_, i) => { const t = (i / 48) * 2 * Math.PI; return [20 + 6 * Math.cos(t), 15 + 6 * Math.sin(t), 10]; });
  const c = circleFrom(pts);
  near(c.r, 6); near(c.center[0], 20); near(c.center[1], 15); near(c.center[2], 10); near(c.sweep, 360, 0.5);
});

test("un arco de 90° inclinado y una recta", () => {
  const pts = Array.from({ length: 13 }, (_, i) => { const t = (i / 12) * Math.PI / 2; return [5 * Math.cos(t), 0, 5 * Math.sin(t)]; });
  const c = circleFrom(pts);
  near(c.r, 5); near(c.sweep, 90, 0.5);
  assert.equal(circleFrom(Array.from({ length: 10 }, (_, i) => [i, 2 * i, 0])), null);
});

/** cara cilíndrica de radio r a lo largo de Z; hole = normales hacia el eje */
const cyl = (r, hole, part = 1) => {
  const v = [], n = [];
  for (let i = 0; i < 24; i++) for (const z of [0, 10]) {
    const t = (i / 24) * 2 * Math.PI * part, c = Math.cos(t), s = Math.sin(t);
    v.push([3 + r * c, -2 + r * s, z]); n.push(hole ? [-c, -s, 0] : [c, s, 0]);
  }
  return [v, n];
};

test("cara cilíndrica: agujero Ø8 y tetón Ø20", () => {
  const a = faceKind(...cyl(4, true));
  assert.equal(a.kind, "cylinder"); near(a.r, 4); assert.equal(a.hole, true);
  const b = faceKind(...cyl(10, false));
  near(b.r, 10); assert.equal(b.hole, false); assert.equal(b.full, true);
  const q = faceKind(...cyl(5, false, 0.25)); // redondeo de un cuarto
  near(q.r, 5); assert.equal(q.full, false);
  assert.equal(faceKind([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 1], [0, 0, 1], [0, 0, 1]]).kind, "plane");
});

test("ángulo entre caras: 90° en una esquina, paralelas a 20 mm", () => {
  near(planesAngle([0, 0, 1], [0, 0, 20], [1, 0, 0], [40, 0, 0]).angle, 90);
  const p = planesAngle([0, 0, 1], [0, 0, 20], [0, 0, -1], [5, 5, 0]);
  near(p.angle, 0); near(p.gap, 20);
  near(planesAngle([0, 0, 1], [0, 0, 0], [0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)], [0, 0, 0]).angle, 30);
});
