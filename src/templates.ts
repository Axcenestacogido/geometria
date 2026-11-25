// Plantillas: piezas que encajan entre sí, ya hechas con variables.
// Cambia las variables (ancho, holgura…) y todo se recalcula.

import type { Doc, Feature, Expr } from "./types";

export interface Template { id: string; name: string; info: string; make: () => Doc }

const E = (s: string) => s as Expr;
let n = 0;
const id = (p: string) => `${p}${++n}`;

function snapBox(): Doc {
  const f: Feature[] = [
    { id: "caja", type: "box", name: "Caja", x: E("-ancho/2"), y: E("-fondo/2"), z: E("0"), w: E("ancho"), d: E("fondo"), h: E("alto"), op: "new" },
    { id: id("h"), type: "box", name: "Hueco de la caja", x: E("-ancho/2 + pared"), y: E("-fondo/2 + pared"), z: E("pared"), w: E("ancho - 2*pared"), d: E("fondo - 2*pared"), h: E("alto"), op: "cut", target: "caja" },
    { id: "tapa", type: "box", name: "Tapa", x: E("ancho/2 + separacion"), y: E("-fondo/2"), z: E("0"), w: E("ancho"), d: E("fondo"), h: E("pared"), op: "new" },
    { id: id("l"), type: "box", name: "Labio de la tapa", x: E("ancho/2 + separacion + pared + holgura"), y: E("-fondo/2 + pared + holgura"), z: E("pared"), w: E("ancho - 2*pared - 2*holgura"), d: E("fondo - 2*pared - 2*holgura"), h: E("labio"), op: "add", target: "tapa" },
    { id: id("l"), type: "box", name: "Hueco del labio", x: E("ancho/2 + separacion + 2*pared + holgura"), y: E("-fondo/2 + 2*pared + holgura"), z: E("pared"), w: E("ancho - 4*pared - 2*holgura"), d: E("fondo - 4*pared - 2*holgura"), h: E("labio + 1"), op: "cut", target: "tapa" },
  ];
  return {
    version: 1, name: "Caja con tapa a presión",
    variables: [
      { name: "ancho", value: E("60") }, { name: "fondo", value: E("40") }, { name: "alto", value: E("30") },
      { name: "pared", value: E("2") }, { name: "holgura", value: E("0.15") }, { name: "labio", value: E("5") },
      { name: "separacion", value: E("10") },
    ],
    features: f,
  };
}

function hinge(): Doc {
  const f: Feature[] = [
    { id: "A", type: "box", name: "Hoja A", x: E("-largo/2"), y: E("-(hoja + d/2)"), z: E("-d/2"), w: E("largo"), d: E("hoja - holgura"), h: E("grosor"), op: "new" },
    { id: "B", type: "box", name: "Hoja B", x: E("-largo/2"), y: E("d/2 + holgura"), z: E("-d/2"), w: E("largo"), d: E("hoja - holgura"), h: E("grosor"), op: "new" },
  ];
  for (let i = 0; i < 3; i++) {
    const mine = i % 2 === 0 ? "A" : "B";
    const x0 = `-largo/2 + ${i}*(tramo + holgura)`;
    const sk = id("s");
    f.push(
      { id: sk, type: "sketch", name: `Nudillo ${i + 1} (boceto)`, plane: { kind: "std", name: "YZ", offset: E(x0) }, profiles: [{ id: id("c"), kind: "circle", hole: false, cx: E("0"), cy: E("0"), r: E("d/2") }] },
      { id: id("e"), type: "extrude", name: `Nudillo ${i + 1} (${mine})`, sketch: sk, distance: E("tramo"), symmetric: false, reverse: false, op: "add", target: mine },
      {
        id: id("u"), type: "box", name: `Unión nudillo ${i + 1}`, x: E(x0), y: E(mine === "A" ? "-(d/2 + holgura)" : "0"), z: E("-d/2"),
        w: E("tramo"), d: E("d/2 + holgura"), h: E("grosor"), op: "add", target: mine,
      },
    );
  }
  const pin = id("s"), bore = id("s");
  f.push(
    { id: pin, type: "sketch", name: "Eje (boceto)", plane: { kind: "std", name: "YZ", offset: E("-largo/2") }, profiles: [{ id: id("c"), kind: "circle", hole: false, cx: E("0"), cy: E("0"), r: E("d/4") }] },
    { id: id("e"), type: "extrude", name: "Eje (de la hoja A)", sketch: pin, distance: E("largo"), symmetric: false, reverse: false, op: "add", target: "A" },
    { id: bore, type: "sketch", name: "Agujero del eje (boceto)", plane: { kind: "std", name: "YZ", offset: E("-largo/2 + tramo + holgura - 1") }, profiles: [{ id: id("c"), kind: "circle", hole: false, cx: E("0"), cy: E("0"), r: E("d/4 + holgura") }] },
    { id: id("e"), type: "extrude", name: "Agujero del eje (en B)", sketch: bore, distance: E("tramo + 2"), symmetric: false, reverse: false, op: "cut", target: "B" },
  );
  return {
    version: 1, name: "Bisagra imprimible",
    variables: [
      { name: "largo", value: E("40") }, { name: "d", value: E("8") }, { name: "holgura", value: E("0.4") },
      { name: "hoja", value: E("20") }, { name: "grosor", value: E("3") }, { name: "tramo", value: E("(largo - 2*holgura)/3") },
    ],
    features: f,
  };
}

function boltNut(): Doc {
  const head = id("s"), nut = id("s");
  const f: Feature[] = [
    { id: head, type: "sketch", name: "Cabeza (boceto)", plane: { kind: "std", name: "XY", offset: E("0") }, profiles: [{ id: id("p"), kind: "ngon", hole: false, cx: E("0"), cy: E("0"), r: E("llave/sqrt(3)"), n: E("6") }] },
    { id: "T", type: "extrude", name: "Cabeza", sketch: head, distance: E("cabeza"), symmetric: false, reverse: false, op: "new" },
    { id: id("r"), type: "rod", name: "Rosca del tornillo", size: "M10", length: E("largo"), fit: E("holgura"), points: [{ x: E("0"), y: E("0"), z: E("cabeza"), n: [0, 0, 1] }], target: "T" },
    { id: nut, type: "sketch", name: "Tuerca (boceto)", plane: { kind: "std", name: "XY", offset: E("0") }, profiles: [{ id: id("p"), kind: "ngon", hole: false, cx: E("llave*2"), cy: E("0"), r: E("llave/sqrt(3)"), n: E("6") }] },
    { id: "N", type: "extrude", name: "Tuerca", sketch: nut, distance: E("alto_tuerca"), symmetric: false, reverse: false, op: "new" },
    { id: id("h"), type: "hole", name: "Rosca de la tuerca", kind: "thread", size: "M10", depth: E("alto_tuerca + 1"), through: false, fit: E("holgura"), points: [{ x: E("llave*2"), y: E("0"), z: E("alto_tuerca"), n: [0, 0, 1] }], target: "N" },
  ];
  return {
    version: 1, name: "Tornillo y tuerca M10",
    variables: [
      { name: "largo", value: E("20") }, { name: "holgura", value: E("0.3") }, { name: "llave", value: E("16") },
      { name: "cabeza", value: E("6.5") }, { name: "alto_tuerca", value: E("8") },
    ],
    features: f,
  };
}

export const TEMPLATES: Template[] = [
  { id: "caja", name: "Caja con tapa a presión", info: "La tapa encaja por dentro con un labio. «holgura» decide lo que aprieta: 0,1 aprieta mucho, 0,3 entra suelta.", make: snapBox },
  { id: "bisagra", name: "Bisagra imprimible", info: "Se imprime ya montada, de una vez, tumbada como sale. «holgura» es el hueco entre piezas: 0,4 va bien en la Bambu con boquilla de 0,4.", make: hinge },
  { id: "tornillo", name: "Tornillo y tuerca M10", info: "Rosca métrica real. Imprímelos de pie; con «holgura» 0,3 la tuerca entra a mano.", make: boltNut },
];
