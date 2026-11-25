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

function gears(): Doc {
  const f: Feature[] = [
    { id: "R1", type: "gear", name: "Rueda grande", x: E("0"), y: E("0"), z: E("0"), module: E("modulo"), teeth: E("dientes1"), thickness: E("grosor"), bore: E("eje"), fit: E("holgura"), angle: E("0"), op: "new" },
    // a la distancia justa entre centros, y girada medio diente para que un diente caiga en un hueco
    { id: "R2", type: "gear", name: "Rueda pequeña", x: E("modulo*(dientes1 + dientes2)/2"), y: E("0"), z: E("0"), module: E("modulo"), teeth: E("dientes2"), thickness: E("grosor"), bore: E("eje"), fit: E("holgura"), angle: E("180 + 180/dientes2"), op: "new" },
  ];
  return {
    version: 1, name: "Pareja de engranajes",
    variables: [
      { name: "modulo", value: E("2") }, { name: "dientes1", value: E("30") }, { name: "dientes2", value: E("15") },
      { name: "grosor", value: E("8") }, { name: "eje", value: E("5.2") }, { name: "holgura", value: E("0.2") },
    ],
    features: f,
  };
}

function spring(): Doc {
  return {
    version: 1, name: "Muelle",
    variables: [
      { name: "diametro", value: E("20") }, { name: "hilo", value: E("1.6") }, { name: "paso", value: E("5") }, { name: "vueltas", value: E("6") },
    ],
    features: [
      { id: "M", type: "spring", name: "Muelle", x: E("0"), y: E("0"), z: E("0"), diameter: E("diametro"), wire: E("hilo"), pitch: E("paso"), turns: E("vueltas"), flat: true, op: "new" },
    ],
  };
}

function tubeClip(): Doc {
  const R = "(tubo/2 + grosor)";
  const sk = id("s");
  const f: Feature[] = [
    { id: "C", type: "cylinder", name: "Anillo", x: E("0"), y: E("0"), z: E("0"), r: E(R), h: E("ancho"), op: "new" },
    { id: id("b"), type: "box", name: "Base", x: E(`-(${R} + solapa)`), y: E(`-${R}`), z: E("0"), w: E(`2*(${R} + solapa)`), d: E("grosor"), h: E("ancho"), op: "add", target: "C" },
    // un poco más estrecho que el tubo para que apriete
    { id: id("h"), type: "cylinder", name: "Hueco del tubo", x: E("0"), y: E("0"), z: E("-1"), r: E("tubo/2 - apriete/2"), h: E("ancho + 2"), op: "cut", target: "C" },
    { id: id("a"), type: "box", name: "Abertura", x: E("-abertura/2"), y: E("0"), z: E("-1"), w: E("abertura"), d: E("tubo"), h: E("ancho + 2"), op: "cut", target: "C" },
    { id: sk, type: "sketch", name: "Tornillos (boceto)", plane: { kind: "std", name: "XZ", offset: E(R) } /* el plano XZ mira hacia -Y: desfase positivo = hacia la base */, profiles: [
      { id: id("c"), kind: "circle", hole: false, cx: E(`-(${R} + solapa/2)`), cy: E("ancho/2"), r: E("tornillo/2") },
      { id: id("c"), kind: "circle", hole: false, cx: E(`${R} + solapa/2`), cy: E("ancho/2"), r: E("tornillo/2") },
    ] },
    { id: id("e"), type: "extrude", name: "Agujeros de los tornillos", sketch: sk, distance: E("grosor*4"), symmetric: true, reverse: false, op: "cut", target: "C" },
  ];
  return {
    version: 1, name: "Clip para tubo",
    variables: [
      { name: "tubo", value: E("20") }, { name: "grosor", value: E("2.5") }, { name: "ancho", value: E("12") },
      { name: "apriete", value: E("0.4") }, { name: "abertura", value: E("tubo*0.8") }, { name: "solapa", value: E("10") }, { name: "tornillo", value: E("3.4") },
    ],
    features: f,
  };
}

/** Ensamblaje: caja con tapa que se abre con una bisagra, para probar uniones y choques */
function hingedLid(): Doc {
  const f: Feature[] = [
    { id: "caja", type: "box", name: "Caja", x: E("-ancho/2"), y: E("-fondo/2"), z: E("0"), w: E("ancho"), d: E("fondo"), h: E("alto"), op: "new" },
    { id: id("h"), type: "box", name: "Hueco de la caja", x: E("-ancho/2 + pared"), y: E("-fondo/2 + pared"), z: E("pared"), w: E("ancho - 2*pared"), d: E("fondo - 2*pared"), h: E("alto"), op: "cut", target: "caja" },
    { id: "tapa", type: "box", name: "Tapa", x: E("-ancho/2"), y: E("-fondo/2"), z: E("alto"), w: E("ancho"), d: E("fondo"), h: E("pared"), op: "new" },
    { id: id("l"), type: "box", name: "Labio de la tapa", x: E("-ancho/2 + pared + holgura"), y: E("-fondo/2 + pared + holgura"), z: E("alto - labio"), w: E("ancho - 2*pared - 2*holgura"), d: E("fondo - 2*pared - 2*holgura"), h: E("labio"), op: "add", target: "tapa" },
    { id: id("l"), type: "box", name: "Hueco del labio", x: E("-ancho/2 + 2*pared + holgura"), y: E("-fondo/2 + 2*pared + holgura"), z: E("alto - labio - 1"), w: E("ancho - 4*pared - 2*holgura"), d: E("fondo - 4*pared - 2*holgura"), h: E("labio + 1"), op: "cut", target: "tapa" },
    { id: id("j"), type: "joint", name: "Bisagra de la tapa", kind: "hinge", bodies: ["tapa"], axis: "-x", x: E("0"), y: E("fondo/2"), z: E("alto + pared"), value: E("0"), min: E("0"), max: E("120") },
  ];
  return {
    version: 1, name: "Caja con tapa abatible",
    variables: [
      { name: "ancho", value: E("60") }, { name: "fondo", value: E("40") }, { name: "alto", value: E("25") },
      { name: "pared", value: E("2") }, { name: "holgura", value: E("0.3") }, { name: "labio", value: E("3") },
    ],
    features: f,
  };
}

export const TEMPLATES: Template[] = [
  { id: "caja", name: "Caja con tapa a presión", info: "La tapa encaja por dentro con un labio. «holgura» decide lo que aprieta: 0,1 aprieta mucho, 0,3 entra suelta.", make: snapBox },
  { id: "abatible", name: "Caja con tapa abatible (ensamblaje)", info: "Abre la tapa con el deslizador del paso «Bisagra de la tapa» y pulsa «Recorrer y buscar choques». Prueba a subir «labio» a 5: la tapa choca con la pared de delante al abrirse.", make: hingedLid },
  { id: "bisagra", name: "Bisagra imprimible", info: "Se imprime ya montada, de una vez, tumbada como sale. «holgura» es el hueco entre piezas: 0,4 va bien en la Bambu con boquilla de 0,4.", make: hinge },
  { id: "engranajes", name: "Pareja de engranajes", info: "Dos ruedas que engranan, ya colocadas. Cambia «dientes1» y «dientes2» y se recolocan solas. «eje» es el agujero (5,2 para un eje de 5 mm).", make: gears },
  { id: "muelle", name: "Muelle", info: "Muelle de compresión con las puntas planas. Impreso en PETG o TPU aguanta mejor que en PLA; hilo de 1,6 mm o más.", make: spring },
  { id: "clip", name: "Clip para tubo", info: "Abrazadera que se cierra a presión sobre un tubo y se atornilla. «apriete» es cuánto más estrecha que el tubo es (0,4 sujeta bien). Imprímela de pie, como sale.", make: tubeClip },
  { id: "tornillo", name: "Tornillo y tuerca M10", info: "Rosca métrica real. Imprímelos de pie; con «holgura» 0,3 la tuerca entra a mano.", make: boltNut },
];
