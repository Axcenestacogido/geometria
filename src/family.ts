// Familias de piezas: la misma pieza en varios tamaños, con una tabla de valores para sus variables.
import type { Doc, Family } from "./types";

/** El documento con las variables de la fila «i» puestas */
export function docForRow(doc: Doc, fam: Family, i: number): Doc {
  const row = fam.rows[i];
  const out: Doc = JSON.parse(JSON.stringify(doc));
  for (const v of out.variables) {
    const val = row?.values[v.name];
    if (fam.vars.includes(v.name) && val !== undefined && String(val).trim() !== "") v.value = val;
  }
  return out;
}

/** Nombre de archivo de una fila: «Soporte-M6» */
export function rowFileName(base: string, rowName: string, i: number): string {
  const clean = (s: string) => s.replace(/[^\wáéíóúñÁÉÍÓÚÑ\-. ]+/g, "").trim().replace(/\s+/g, "-");
  return `${clean(base) || "pieza"}-${clean(rowName) || String(i + 1)}`;
}

/** Fila nueva con los valores que tienen ahora las variables */
export function rowFromDoc(doc: Doc, fam: Family, name: string) {
  return { name, values: Object.fromEntries(fam.vars.map((n) => [n, doc.variables.find((v) => v.name === n)?.value ?? ""])) };
}

/** ¿Qué fila coincide con los valores actuales? (-1 si ninguna) */
export function currentRow(doc: Doc, fam: Family): number {
  return fam.rows.findIndex((r) => fam.vars.every((n) => String(r.values[n] ?? "").trim() === String(doc.variables.find((v) => v.name === n)?.value ?? "").trim()));
}
