// Etiqueta de versión grabada en la pieza («v3 · 25-nov»): sube sola cada vez que se exporta para imprimir.
import type { Doc } from "./types";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** Fecha corta para grabar: «25-nov» */
export const shortDate = (d = new Date()) => `${d.getDate()}-${MESES[d.getMonth()]}`;
const LABEL_RE = /\{(v|n|fecha)\}/i;
/** ¿Este texto lleva huecos de etiqueta ({v}, {n}, {fecha})? */
export const hasLabel = (text: string) => LABEL_RE.test(text);
/** ¿Algún texto de la pieza lleva la etiqueta de versión? */
export const docHasLabel = (doc: Doc) => doc.features.some((f) => f.type === "text" && hasLabel(f.text));
/** La etiqueta que lleva ahora (antes de la primera impresión: v1 con la fecha de hoy) */
export const currentLabel = (doc: Doc) => doc.label ?? { n: 1, date: shortDate() };
/** Rellena {v} → v3, {n} → 3, {fecha} → 25-nov */
export function fillLabel(text: string, label: { n: number; date: string }): string {
  return text.replace(/\{(v|n|fecha)\}/gi, (_, k: string) => (k.toLowerCase() === "v" ? `v${label.n}` : k.toLowerCase() === "n" ? String(label.n) : label.date));
}
/**
 * Al exportar para imprimir: sube el número de versión y pone la fecha de hoy.
 * Devuelve la etiqueta nueva, o null si la pieza no lleva etiqueta.
 */
export function bumpLabel(doc: Doc, today = new Date()): { n: number; date: string } | null {
  if (!docHasLabel(doc)) return null;
  doc.label = { n: doc.label ? doc.label.n + 1 : 1, date: shortDate(today) };
  return doc.label;
}

