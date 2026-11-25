// Piezas reales que se compran (rodamientos, imanes, insertos, tuercas, perfiles, motores).
// Medidas de catálogo habituales. «hueco» = el agujero para meterla, con holgura.

export type CatalogKind = "bearing" | "magnet" | "insert" | "nut" | "profile" | "servo" | "stepper";

export interface CatalogPart {
  id: string;
  name: string;
  group: string;
  kind: CatalogKind;
  /** medidas en mm según el tipo */
  d?: number; // diámetro exterior / del imán / entre caras de la tuerca
  id2?: number; // agujero interior (rodamiento, tuerca)
  h?: number; // alto / ancho / grosor
  hole?: number; // insertos: agujero recomendado
  info: string;
}

export const CATALOG: CatalogPart[] = [
  { id: "608", name: "Rodamiento 608", group: "Rodamientos", kind: "bearing", d: 22, id2: 8, h: 7, info: "El de los patinetes: 22 × 8 × 7 mm" },
  { id: "625", name: "Rodamiento 625", group: "Rodamientos", kind: "bearing", d: 16, id2: 5, h: 5, info: "16 × 5 × 5 mm" },
  { id: "688", name: "Rodamiento 688", group: "Rodamientos", kind: "bearing", d: 16, id2: 8, h: 5, info: "16 × 8 × 5 mm" },
  { id: "6001", name: "Rodamiento 6001", group: "Rodamientos", kind: "bearing", d: 28, id2: 12, h: 8, info: "28 × 12 × 8 mm" },
  { id: "iman-6x2", name: "Imán 6 × 2", group: "Imanes de disco", kind: "magnet", d: 6, h: 2, info: "Neodimio, Ø6 × 2 mm" },
  { id: "iman-6x3", name: "Imán 6 × 3", group: "Imanes de disco", kind: "magnet", d: 6, h: 3, info: "Neodimio, Ø6 × 3 mm" },
  { id: "iman-8x3", name: "Imán 8 × 3", group: "Imanes de disco", kind: "magnet", d: 8, h: 3, info: "Neodimio, Ø8 × 3 mm" },
  { id: "iman-10x2", name: "Imán 10 × 2", group: "Imanes de disco", kind: "magnet", d: 10, h: 2, info: "Neodimio, Ø10 × 2 mm" },
  { id: "iman-10x3", name: "Imán 10 × 3", group: "Imanes de disco", kind: "magnet", d: 10, h: 3, info: "Neodimio, Ø10 × 3 mm" },
  { id: "iman-12x4", name: "Imán 12 × 4", group: "Imanes de disco", kind: "magnet", d: 12, h: 4, info: "Neodimio, Ø12 × 4 mm" },
  { id: "inserto-m2", name: "Inserto M2 (calor)", group: "Insertos roscados", kind: "insert", d: 3.6, h: 4, hole: 3.2, info: "Se mete con el soldador. Agujero Ø3,2" },
  { id: "inserto-m3", name: "Inserto M3 (calor)", group: "Insertos roscados", kind: "insert", d: 4.6, h: 5.7, hole: 4.0, info: "Se mete con el soldador. Agujero Ø4,0" },
  { id: "inserto-m4", name: "Inserto M4 (calor)", group: "Insertos roscados", kind: "insert", d: 6.0, h: 8.1, hole: 5.6, info: "Se mete con el soldador. Agujero Ø5,6" },
  { id: "inserto-m5", name: "Inserto M5 (calor)", group: "Insertos roscados", kind: "insert", d: 7.0, h: 9.5, hole: 6.4, info: "Se mete con el soldador. Agujero Ø6,4" },
  { id: "tuerca-m3", name: "Tuerca M3", group: "Tuercas", kind: "nut", d: 5.5, id2: 3, h: 2.4, info: "5,5 mm entre caras, 2,4 de alto" },
  { id: "tuerca-m4", name: "Tuerca M4", group: "Tuercas", kind: "nut", d: 7, id2: 4, h: 3.2, info: "7 mm entre caras, 3,2 de alto" },
  { id: "tuerca-m5", name: "Tuerca M5", group: "Tuercas", kind: "nut", d: 8, id2: 5, h: 4, info: "8 mm entre caras, 4 de alto" },
  { id: "tuerca-m6", name: "Tuerca M6", group: "Tuercas", kind: "nut", d: 10, id2: 6, h: 5, info: "10 mm entre caras, 5 de alto" },
  { id: "tuerca-m8", name: "Tuerca M8", group: "Tuercas", kind: "nut", d: 13, id2: 8, h: 6.5, info: "13 mm entre caras, 6,5 de alto" },
  { id: "perfil-2020", name: "Perfil de aluminio 2020", group: "Perfiles", kind: "profile", d: 20, info: "20 × 20 mm, ranura de 6. Pon el largo" },
  { id: "sg90", name: "Servo SG90", group: "Motores", kind: "servo", info: "Microservo 9 g. El origen es la base de las orejetas" },
  { id: "nema17", name: "Motor paso a paso NEMA 17", group: "Motores", kind: "stepper", info: "42,3 mm de lado, 40 de largo. El origen es la cara de montaje" },
];

export const catalogPart = (id: string) => CATALOG.find((p) => p.id === id);

/** Esquinas de un hexágono con «af» mm entre caras, centrado en el origen */
export function hexagon(af: number): [number, number][] {
  const r = af / Math.sqrt(3); // radio a la esquina
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
  });
}
