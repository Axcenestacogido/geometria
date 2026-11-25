import { test } from "node:test";
import assert from "node:assert/strict";
import { Dxf, addSvgPaths } from "../src/dxf.ts";

const ents = (s) => s.split(/\n0\n(?=LINE|ARC|CIRCLE|ENDSEC)/).filter((x) => /^(LINE|ARC|CIRCLE)\n/.test(x));

test("cuadrado SVG → 4 líneas con la Y dada la vuelta", () => {
  const d = new Dxf().layer("VISIBLE");
  addSvgPaths(d, ["M 0 0 L 10 0 L 10 -5 L 0 -5 Z"], "VISIBLE");
  const e = ents(d.toString());
  assert.equal(e.length, 4);
  assert.match(e[1], /10\n10\n20\n0\n30\n0\n11\n10\n21\n5\n/); // (10,0) → (10,5)
});

test("arco SVG de un cuarto → ARC antihorario de 0 a 90°", () => {
  const d = new Dxf();
  addSvgPaths(d, ["M 10 0 A 10 10 0 0 0 0 -10"], "0");
  const [a] = ents(d.toString());
  assert.match(a, /^ARC/);
  assert.match(a, /\n40\n10\n50\n0\n51\n90$/);
});

test("archivo completo: cabecera en mm, capas y fin", () => {
  const s = new Dxf().layer("CONTORNO", 7).toString();
  assert.match(s, /\$INSUNITS\n70\n4/);
  assert.match(s, /LAYER\n2\nCONTORNO/);
  assert.ok(s.trimEnd().endsWith("0\nEOF"));
});
