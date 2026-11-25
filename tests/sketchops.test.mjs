import { test } from "node:test";
import assert from "node:assert/strict";
import { filletCorner, filletAll, offsetPoly, removeSegment, arcCenter } from "../src/sketchops.ts";

const sq = () => [{ x: 0, y: 0, s: 0 }, { x: 10, y: 0, s: 0 }, { x: 10, y: 10, s: 0 }, { x: 0, y: 10, s: 0 }];
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test("redondear una esquina de un cuadrado", () => {
  const p = filletCorner(sq(), 1, 2, true);
  assert.equal(p.length, 5);
  near(p[1].x, 8); near(p[1].y, 0); near(p[2].x, 10); near(p[2].y, 2);
  const { c, r } = arcCenter([p[1].x, p[1].y], [p[2].x, p[2].y], p[1].s);
  near(r, 2); near(c[0], 8); near(c[1], 2);
});

test("redondear todas y luego desfasar hacia fuera conserva los centros", () => {
  const { pts, done } = filletAll(sq(), 2, true);
  assert.equal(done, 4);
  const o = offsetPoly(pts, 1, true);
  // primer arco (esquina de abajo a la derecha): mismo centro, radio 3
  const i = o.findIndex((q) => Math.abs(q.s) > 1e-9);
  const { c, r } = arcCenter([o[i].x, o[i].y], [o[i + 1].x, o[i + 1].y], o[i].s);
  const c0 = arcCenter([pts[i].x, pts[i].y], [pts[i + 1].x, pts[i + 1].y], pts[i].s).c;
  near(c[0], c0[0]); near(c[1], c0[1]); near(r, 3);
});

test("desfase de un cuadrado: hacia fuera crece y hacia dentro encoge", () => {
  const out = offsetPoly(sq(), 1, true);
  near(Math.min(...out.map((p) => p.x)), -1); near(Math.max(...out.map((p) => p.x)), 11);
  const inn = offsetPoly(sq().reverse(), -1, true);
  near(Math.min(...inn.map((p) => p.x)), 1); near(Math.max(...inn.map((p) => p.y)), 9);
});

test("quitar un tramo", () => {
  const [open] = removeSegment(sq(), 1, true);
  assert.equal(open.length, 4);
  assert.deepEqual([open[0].x, open[0].y], [10, 10]);
  assert.deepEqual([open[3].x, open[3].y], [10, 0]);
  const parts = removeSegment(open, 1, false);
  assert.equal(parts.length, 2);
});
