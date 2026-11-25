import { test } from "node:test";
import assert from "node:assert/strict";
import { bom, bomCsv, bodyInfo } from "../src/bim.ts";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const doc = { version: 1, name: "T", variables: [], features: [
  { id: "A", type: "box", name: "Caja" },
  { id: "R", type: "catalog", name: "Pieza de catálogo 1", part: "608", op: "new" },
], bim: { A: { material: "petg", qty: 2, notes: "pintar; rojo" }, R: { price: 1.5, qty: 4 } } };

test("las piezas de catálogo se compran y salen en acero", () => {
  const r = bodyInfo(doc, "R");
  assert.equal(r.kind, "buy"); assert.equal(r.material, "acero"); assert.equal(r.qty, 4);
});

test("peso y coste por pieza, por material y en total", () => {
  const out = bom(doc, [
    { id: "A", name: "Caja", volume: 10000, size: [10, 20, 50] },
    { id: "R", name: "Rodamiento 608", volume: 2310, size: [22, 22, 7] },
  ], { petg: 30 });
  const [a, r] = out.rows;
  near(a.weightG, 12.7); near(a.totalWeightG, 25.4); near(a.unitCost, 12.7 / 1000 * 30); near(a.totalCost, 2 * 0.381);
  near(r.unitCost, 1.5); near(r.totalCost, 6); near(r.weightG, 2.31 * 7.85);
  assert.equal(out.byMaterial.length, 2);
  near(out.totalCost, 6 + 0.762);
  const csv = bomCsv(out.rows);
  assert.ok(csv.startsWith("﻿Pieza;Cantidad"));
  assert.match(csv, /Caja;2;Imprimir;PETG;;10,0;20,0;50,0;10,00;12,7;25,4;0,38;0,76;"pintar; rojo"/);
});
