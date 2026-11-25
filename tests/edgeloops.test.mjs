import { test } from "node:test";
import assert from "node:assert/strict";
import { chainLoops, edgeShapes } from "../src/edgeloops.ts";

const seg = (pts) => { const o = []; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; o.push(a[0], a[1], b[0], b[1]); } return o; };
const circle = (cx, cy, r, n = 48) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);

test("une tramos sueltos (y desordenados) en un lazo", () => {
  const s = seg([[0, 0], [10, 0], [10, 5], [0, 5]]);
  const shuffled = [...s.slice(8), ...s.slice(0, 8)];
  assert.equal(chainLoops(shuffled).length, 1);
});

test("rectángulo con agujero redondo: rect + círculo marcado como agujero", () => {
  // el lado de abajo partido en dos tramos (como sale de una cara con una arista partida)
  const out = edgeShapes([...seg([[0, 0], [20, 0], [40, 0], [40, 30], [0, 30]]), ...seg(circle(20, 15, 5))]);
  const rect = out.find((s) => s.kind === "rect"), circ = out.find((s) => s.kind === "circle");
  assert.deepEqual(rect, { kind: "rect", x: 0, y: 0, w: 40, h: 30, hole: false });
  assert.equal(circ.hole, true);
  assert.ok(Math.abs(circ.r - 5) < 0.01 && Math.abs(circ.cx - 20) < 0.01);
});

test("forma en L: polilínea de 6 puntos; repetidos y abiertos fuera", () => {
  const L = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
  const out = edgeShapes([...seg(L), ...seg(L), 50, 50, 60, 60]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "poly");
  assert.equal(out[0].pts.length, 6);
});
