import { test } from "node:test";
import assert from "node:assert/strict";
import { gearOutline } from "../src/gear.ts";

test("engranaje: el contorno queda entre el fondo y la punta", () => {
  const m = 2, z = 20, pts = gearOutline({ m, z, fit: 0.2 });
  const r = pts.map(([x, y]) => Math.hypot(x, y));
  assert.ok(Math.max(...r) <= m * z / 2 + m + 1e-9);
  assert.ok(Math.min(...r) >= m * z / 2 - 1.25 * m - 1e-9);
  assert.ok(Math.abs(Math.max(...r) - (m * z / 2 + m)) < 1e-6);
});

test("engranaje: datos imposibles dan un aviso claro", () => {
  assert.throws(() => gearOutline({ m: 2, z: 4, fit: 0 }), /dientes/);
  assert.throws(() => gearOutline({ m: 0, z: 20, fit: 0 }), /módulo/);
  assert.throws(() => gearOutline({ m: 1, z: 20, fit: 5 }), /holgura/);
});
