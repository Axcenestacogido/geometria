import { test } from "node:test";
import assert from "node:assert/strict";
import { docForRow, rowFileName, rowFromDoc, currentRow } from "../src/family.ts";
import { makeZip, crc32 } from "../src/zip.ts";

const doc = { version: 1, name: "Soporte", variables: [{ name: "ancho", value: "20" }, { name: "alto", value: "10" }, { name: "agujero", value: "3" }], features: [] };
const fam = { vars: ["ancho", "agujero"], rows: [{ name: "M3", values: { ancho: "20", agujero: "3" } }, { name: "M6", values: { ancho: "35", agujero: "6" } }] };

test("cada fila cambia solo sus variables", () => {
  const d = docForRow(doc, fam, 1);
  assert.deepEqual(d.variables.map((v) => v.value), ["35", "10", "6"]);
  assert.equal(doc.variables[0].value, "20"); // el original no cambia
});

test("fila actual y nombres", () => {
  assert.equal(currentRow(doc, fam), 0);
  assert.equal(currentRow(docForRow(doc, fam, 1), fam), 1);
  assert.equal(rowFileName("Mi soporte", "M6 / largo", 1), "Mi-soporte-M6-largo");
  assert.equal(rowFileName("", "", 2), "pieza-3");
  assert.deepEqual(rowFromDoc(doc, fam, "X").values, { ancho: "20", agujero: "3" });
});

test("zip sin comprimir con CRC correcto", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const z = makeZip([{ name: "a.txt", data: new TextEncoder().encode("hola") }, { name: "ñ.stl", data: new Uint8Array([1, 2, 3]) }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(v.getUint16(z.length - 22 + 10, true), 2);
});
