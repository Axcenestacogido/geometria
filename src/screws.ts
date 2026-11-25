// Medidas de tornillería métrica para piezas impresas (mm).
// Fuentes: ISO 273 (paso "medio"), ISO 4762 (cabeza allen), ISO 10642 (avellanado 90°),
// ISO 4032 (tuerca hexagonal) y medidas habituales de insertos térmicos de latón.
// A todo lo que tiene que encajar se le suma después la holgura de la impresora (`fit`).

export interface ScrewSize {
  d: number;          // diámetro nominal
  pitch: number;      // paso de rosca normal
  clearance: number;  // agujero de paso (ajuste medio ISO 273)
  pilot: number;      // agujero para atornillar directamente en plástico
  insert: number;     // agujero para inserto térmico
  insertDepth: number;
  headCb: number;     // diámetro de cabeza allen (para la caja)
  headCbH: number;    // altura de cabeza allen
  headCs: number;     // diámetro de cabeza avellanada (90°)
  nutAf: number;      // tuerca: entrecaras
  nutH: number;       // tuerca: altura
}

export const SCREWS: Record<string, ScrewSize> = {
  M2:   { d: 2,   pitch: 0.4,  clearance: 2.4,  pilot: 1.6, insert: 3.2, insertDepth: 4,  headCb: 3.8, headCbH: 2,   headCs: 4.0,  nutAf: 4,  nutH: 1.6 },
  "M2.5": { d: 2.5, pitch: 0.45, clearance: 2.9,  pilot: 2.0, insert: 3.5, insertDepth: 5,  headCb: 4.5, headCbH: 2.5, headCs: 5.0,  nutAf: 5,  nutH: 2 },
  M3:   { d: 3,   pitch: 0.5,  clearance: 3.4,  pilot: 2.5, insert: 4.0, insertDepth: 5.7, headCb: 5.5, headCbH: 3,   headCs: 6.72, nutAf: 5.5, nutH: 2.4 },
  M4:   { d: 4,   pitch: 0.7,  clearance: 4.5,  pilot: 3.3, insert: 5.6, insertDepth: 8.1, headCb: 7,   headCbH: 4,   headCs: 8.96, nutAf: 7,  nutH: 3.2 },
  M5:   { d: 5,   pitch: 0.8,  clearance: 5.5,  pilot: 4.2, insert: 6.4, insertDepth: 9.5, headCb: 8.5, headCbH: 5,   headCs: 11.2, nutAf: 8,  nutH: 4.7 },
  M6:   { d: 6,   pitch: 1,    clearance: 6.6,  pilot: 5.0, insert: 8.0, insertDepth: 12.7, headCb: 10, headCbH: 6,   headCs: 13.44, nutAf: 10, nutH: 5.2 },
  M8:   { d: 8,   pitch: 1.25, clearance: 9.0,  pilot: 6.8, insert: 9.7, insertDepth: 12.7, headCb: 13, headCbH: 8,   headCs: 17.92, nutAf: 13, nutH: 6.8 },
  M10:  { d: 10,  pitch: 1.5,  clearance: 11.0, pilot: 8.5, insert: 12,  insertDepth: 14, headCb: 16,  headCbH: 10,  headCs: 22.4, nutAf: 16, nutH: 8.4 },
  M12:  { d: 12,  pitch: 1.75, clearance: 13.5, pilot: 10.2, insert: 14, insertDepth: 16, headCb: 18, headCbH: 12,  headCs: 26.88, nutAf: 18, nutH: 10.8 },
  M16:  { d: 16,  pitch: 2,    clearance: 17.5, pilot: 14,  insert: 18,  insertDepth: 20, headCb: 24,  headCbH: 16,  headCs: 33.6, nutAf: 24, nutH: 14.8 },
  M20:  { d: 20,  pitch: 2.5,  clearance: 22,   pilot: 17.5, insert: 22, insertDepth: 24, headCb: 30,  headCbH: 20,  headCs: 40.32, nutAf: 30, nutH: 18 },
};

export const SCREW_NAMES = Object.keys(SCREWS);

export const HOLE_KIND_LABEL: Record<string, string> = {
  clearance: "De paso (el tornillo pasa holgado)",
  countersink: "Avellanado (cabeza plana enrasada)",
  counterbore: "Con caja (cabeza allen escondida)",
  insert: "Para inserto térmico de latón",
  pilot: "Para atornillar directo en el plástico",
  nut: "Hueco hexagonal para tuerca",
  thread: "Rosca hembra modelada",
};
