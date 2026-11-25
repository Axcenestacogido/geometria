import { test } from "node:test";
import assert from "node:assert/strict";
import { snapsFromPaths, svgArcCenter, nearestPoint, nearestCircle, dimValue, dimAttached, dimSvg } from "../src/drawdims.ts";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test("centro de un arco SVG (medio círculo)", () => {
  const { c, angle } = svgArcCenter([0, 0], [10, 0], 5, false, true);
  near(c[0], 5); near(c[1], 0); near(angle, Math.PI);
});

test("rectángulo con agujero: esquinas, medios y un círculo entero", () => {
  // como lo da replicad: círculo entero = un solo arco con el final 1e-4 más abajo
  const s = snapsFromPaths(["M 0 0 L 40 0 L 40 20 L 0 20 L 0 0 Z", "M 25 10 A 5 5 0 1 0 25 10.0001"]);
  assert.ok(nearestPoint(s, [39.6, 0.3], 1));
  near(nearestPoint(s, [20.2, 0.1], 1)[0], 20); // medio del lado
  const c = nearestCircle(s, [25.2, 10], 0.5);
  assert.ok(c && c.full);
  near(c.r, 5); near(c.c[0], 20, 1e-3); near(c.c[1], 10, 1e-3);
  assert.ok(nearestPoint(s, [20, 10.2], 0.5)); // el centro también engancha
});

test("valores y enganche de las cotas", () => {
  const s = snapsFromPaths(["M 0 0 L 40 0 L 40 20 L 0 20 Z"]);
  const h = { id: "1", view: "front", kind: "h", a: [0, 20], b: [40, 20], off: 28 };
  near(dimValue(h), 40);
  near(dimValue({ ...h, kind: "a", a: [0, 0], b: [40, 20] }), Math.hypot(40, 20));
  near(dimValue({ ...h, kind: "d", c: [5, 5], r: 3 }), 6);
  assert.ok(dimAttached(h, s));
  assert.ok(!dimAttached({ ...h, b: [45, 20] }, s));
  const { svg, at } = dimSvg(h, { ox: 10, oy: 10, k: 1 }, "40");
  assert.match(svg, /<text[^>]*>40<\/text>/);
  near(at[0], 30); assert.ok(at[1] < 38);
});
