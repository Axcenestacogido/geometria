// BIM de objetos: qué material lleva cada pieza, cuánto pesa, cuánto cuesta y el listado de piezas.
// Todo es cálculo puro (sin DOM), para poder probarlo aparte.
import type { BodyInfo, Doc } from "./types";
import { catalogPart } from "./catalog.ts";

export interface Material {
  id: string;
  name: string;
  group: "Filamento" | "Madera" | "Metal" | "Otros";
  /** g/cm³ */
  density: number;
  /** €/kg por defecto (orientativo, cámbialo con tus precios) */
  price: number;
}

export const MATERIALS: Material[] = [
  { id: "pla", name: "PLA", group: "Filamento", density: 1.24, price: 20 },
  { id: "petg", name: "PETG", group: "Filamento", density: 1.27, price: 22 },
  { id: "abs", name: "ABS", group: "Filamento", density: 1.04, price: 22 },
  { id: "asa", name: "ASA", group: "Filamento", density: 1.07, price: 28 },
  { id: "tpu", name: "TPU (flexible)", group: "Filamento", density: 1.21, price: 30 },
  { id: "pa", name: "Nailon (PA)", group: "Filamento", density: 1.14, price: 45 },
  { id: "pc", name: "Policarbonato (PC)", group: "Filamento", density: 1.2, price: 40 },
  { id: "pla-cf", name: "PLA con fibra de carbono", group: "Filamento", density: 1.3, price: 35 },
  { id: "resina", name: "Resina", group: "Filamento", density: 1.15, price: 35 },
  { id: "pino", name: "Pino", group: "Madera", density: 0.5, price: 3 },
  { id: "roble", name: "Roble", group: "Madera", density: 0.75, price: 8 },
  { id: "contrachapado", name: "Contrachapado", group: "Madera", density: 0.6, price: 4 },
  { id: "mdf", name: "DM (MDF)", group: "Madera", density: 0.75, price: 2 },
  { id: "aluminio", name: "Aluminio", group: "Metal", density: 2.7, price: 8 },
  { id: "acero", name: "Acero", group: "Metal", density: 7.85, price: 3 },
  { id: "inox", name: "Acero inoxidable", group: "Metal", density: 8.0, price: 6 },
  { id: "laton", name: "Latón", group: "Metal", density: 8.5, price: 9 },
  { id: "cobre", name: "Cobre", group: "Metal", density: 8.96, price: 10 },
  { id: "neodimio", name: "Neodimio (imán)", group: "Metal", density: 7.5, price: 60 },
  { id: "metacrilato", name: "Metacrilato", group: "Otros", density: 1.19, price: 8 },
  { id: "goma", name: "Goma / silicona", group: "Otros", density: 1.1, price: 15 },
  { id: "vidrio", name: "Vidrio", group: "Otros", density: 2.5, price: 5 },
  { id: "varios", name: "Varios (electrónica…)", group: "Otros", density: 1.5, price: 0 },
];

export const material = (id: string | undefined) => MATERIALS.find((m) => m.id === id);

/** Lo que se sabe de una pieza aunque no le hayas puesto nada: las de catálogo se compran */
export function defaultInfo(doc: Doc, bodyId: string): Required<Pick<BodyInfo, "material" | "kind" | "qty">> & BodyInfo {
  const f = doc.features.find((x) => x.id === bodyId);
  if (f?.type === "catalog") {
    const p = catalogPart(f.part);
    const mat = !p ? "acero" : p.kind === "magnet" ? "neodimio" : p.kind === "insert" ? "laton" : p.kind === "profile" ? "aluminio" : p.kind === "servo" || p.kind === "stepper" ? "varios" : "acero";
    return { material: mat, kind: "buy", qty: 1, ref: p?.name };
  }
  return { material: "pla", kind: "print", qty: 1 };
}

export function bodyInfo(doc: Doc, bodyId: string): BodyInfo & { material: string; kind: Kind; qty: number } {
  const mine = doc.bim?.[bodyId] ?? {};
  const out = { ...defaultInfo(doc, bodyId), ...mine };
  // madera, metal… que no se imprimen: se fabrican aparte (salvo que digas otra cosa)
  if (!mine.kind && out.kind === "print" && material(out.material)?.group !== "Filamento") out.kind = "make";
  return out as never;
}

export type Kind = "print" | "make" | "buy";
export const KIND_LABEL: Record<Kind, string> = { print: "Imprimir", make: "Fabricar", buy: "Comprar" };

export interface BomBody { id: string; name: string; volume: number; size: [number, number, number] }
export interface BomRow {
  id: string; name: string; qty: number; kind: Kind; material: string; materialName: string;
  ref: string; notes: string; size: [number, number, number];
  /** de una unidad */
  volumeCm3: number; weightG: number; unitCost: number;
  /** de todas las unidades */
  totalWeightG: number; totalCost: number;
}

/**
 * Listado de piezas. Las impresas pesan su volumen por la densidad del material (macizas);
 * las compradas cuestan su precio por unidad (si lo pones) o su peso por el precio del material.
 */
export function bom(doc: Doc, bodies: BomBody[], prices: Record<string, number> = {}): { rows: BomRow[]; byMaterial: { material: string; name: string; weightG: number; cost: number }[]; totalWeightG: number; totalCost: number } {
  const rows: BomRow[] = bodies.map((b) => {
    const inf = bodyInfo(doc, b.id);
    const m = material(inf.material) ?? MATERIALS[0];
    const qty = Math.max(1, Math.round(inf.qty || 1));
    const volumeCm3 = b.volume / 1000;
    const weightG = volumeCm3 * m.density;
    const perKg = prices[m.id] ?? m.price;
    const unitCost = inf.kind === "buy" && inf.price !== undefined && inf.price >= 0 ? inf.price : (weightG / 1000) * perKg;
    return {
      id: b.id, name: b.name, qty, kind: inf.kind, material: m.id, materialName: m.name, ref: inf.ref ?? "", notes: inf.notes ?? "",
      size: b.size, volumeCm3, weightG, unitCost, totalWeightG: weightG * qty, totalCost: unitCost * qty,
    };
  });
  const map = new Map<string, { material: string; name: string; weightG: number; cost: number }>();
  for (const r of rows) {
    const e = map.get(r.material) ?? { material: r.material, name: r.materialName, weightG: 0, cost: 0 };
    e.weightG += r.totalWeightG; e.cost += r.totalCost;
    map.set(r.material, e);
  }
  const byMaterial = [...map.values()].sort((a, b) => b.weightG - a.weightG);
  return { rows, byMaterial, totalWeightG: rows.reduce((s, r) => s + r.totalWeightG, 0), totalCost: rows.reduce((s, r) => s + r.totalCost, 0) };
}

const n = (v: number, d: number) => v.toFixed(d).replace(".", ",");
const cell = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** CSV para Excel en español: punto y coma, coma decimal y BOM para que lea bien las tildes */
export function bomCsv(rows: BomRow[]): string {
  const head = ["Pieza", "Cantidad", "Tipo", "Material", "Referencia", "Ancho (mm)", "Fondo (mm)", "Alto (mm)", "Volumen (cm³)", "Peso unidad (g)", "Peso total (g)", "Coste unidad (€)", "Coste total (€)", "Notas"];
  const lines = rows.map((r) => [
    cell(r.name), String(r.qty), KIND_LABEL[r.kind], cell(r.materialName), cell(r.ref),
    n(r.size[0], 1), n(r.size[1], 1), n(r.size[2], 1), n(r.volumeCm3, 2), n(r.weightG, 1), n(r.totalWeightG, 1), n(r.unitCost, 2), n(r.totalCost, 2), cell(r.notes),
  ].join(";"));
  return "﻿" + [head.join(";"), ...lines].join("\r\n") + "\r\n";
}
