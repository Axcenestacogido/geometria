// Restricciones de boceto (horizontal, vertical, igual largo, paralelas, perpendiculares).
// Se resuelven con un método sencillo: cada restricción empuja un poco los puntos
// hasta que todas se cumplen. Solo se mueven las coordenadas que son números sueltos:
// si una coordenada lleva una variable o una cuenta, se respeta tal cual.

import type { Profile, SegRef, SketchConstraint, SketchFeature } from "./types";
import { fmt } from "./expr";

type Poly = Extract<Profile, { kind: "poly" }>;
const PLAIN_NUMBER = /^\s*-?(\d+\.?\d*|\.\d+)\s*$/;

export const CONSTRAINT_GLYPH: Record<SketchConstraint["kind"], string> = { h: "H", v: "V", equal: "=", parallel: "∥", perp: "⊥" };
export const CONSTRAINT_NAME: Record<SketchConstraint["kind"], string> = {
  h: "Horizontal", v: "Vertical", equal: "Igual largo", parallel: "Paralelas", perp: "Perpendiculares",
};

/** Los dos puntos (índices) de un tramo, o null si el tramo ya no existe */
export function segOf(f: SketchFeature, r: SegRef): [Poly, number, number] | null {
  const p = f.profiles.find((q) => q.id === r.p);
  if (!p || p.kind !== "poly") return null;
  const n = p.pts.length;
  if (r.i < 0 || r.i >= n || (p.open && r.i === n - 1)) return null;
  return [p, r.i, (r.i + 1) % n];
}

const refsOf = (c: SketchConstraint): SegRef[] => ("t" in c ? [c.s, c.t] : [c.s]);

/** Quita las restricciones cuyos tramos ya no existen (por ejemplo, tras borrar un punto) */
export function cleanConstraints(f: SketchFeature) {
  if (!f.constraints?.length) return;
  f.constraints = f.constraints.filter((c) => refsOf(c).every((r) => segOf(f, r)));
  if (!f.constraints.length) delete f.constraints;
}

/**
 * Mueve los puntos para cumplir las restricciones.
 * `pinned`: puntos que no se deben mover ("idPerfil:índice"), p. ej. el que estás arrastrando.
 * Devuelve false si no se pueden cumplir todas a la vez.
 */
export function solveSketch(f: SketchFeature, ev: (e: string) => number, pinned: Set<string> = new Set()): boolean {
  cleanConstraints(f);
  const cons = f.constraints ?? [];
  if (!cons.length) return true;
  const val = new Map<string, number>();
  const free = new Set<string>();
  const key = (p: Poly, i: number, ax: "x" | "y") => `${p.id}:${i}:${ax}`;
  for (const c of cons) for (const r of refsOf(c)) {
    const [p, a, b] = segOf(f, r)!;
    for (const i of [a, b]) for (const ax of ["x", "y"] as const) {
      const k = key(p, i, ax);
      if (val.has(k)) continue;
      try { val.set(k, ev(p.pts[i][ax])); } catch { val.set(k, 0); }
      if (PLAIN_NUMBER.test(p.pts[i][ax]) && !pinned.has(`${p.id}:${i}`)) free.add(k);
    }
  }
  const seg = (r: SegRef) => {
    const [p, a, b] = segOf(f, r)!;
    return { keys: [key(p, a, "x"), key(p, a, "y"), key(p, b, "x"), key(p, b, "y")] };
  };
  const vec = (ks: string[]) => [val.get(ks[2])! - val.get(ks[0])!, val.get(ks[3])! - val.get(ks[1])!];
  const residual = (c: SketchConstraint): number => {
    const s = seg(c.s).keys;
    const d1 = vec(s);
    switch (c.kind) {
      case "h": return d1[1];
      case "v": return d1[0];
      default: {
        const d2 = vec(seg(c.t).keys);
        const l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
        if (c.kind === "equal") return l1 - l2;
        const L = Math.max(l1 * l2, 1e-9);
        // paralelas: el seno del ángulo entre ellas es 0; perpendiculares: el coseno es 0
        return c.kind === "parallel" ? (d1[0] * d2[1] - d1[1] * d2[0]) / L : (d1[0] * d2[0] + d1[1] * d2[1]) / L;
      }
    }
  };
  // Gauss-Newton con todas a la vez: el cambio más pequeño de los puntos libres que
  // anula todas las restricciones (mínimos cuadrados amortiguados)
  const vars = [...free];
  const m = cons.length, n = vars.length;
  let worst = Infinity;
  for (let it = 0; it < 120; it++) {
    const C = cons.map(residual);
    worst = Math.max(...C.map(Math.abs));
    if (worst < 1e-10 || !n) break;
    // jacobiano numérico (m × n)
    const J = cons.map(() => new Array<number>(n).fill(0));
    vars.forEach((k, j) => {
      const v0 = val.get(k)!, h = 1e-6 * Math.max(1, Math.abs(v0));
      val.set(k, v0 + h);
      cons.forEach((c, i) => (J[i][j] = (residual(c) - C[i]) / h));
      val.set(k, v0);
    });
    // (J Jᵀ + λ I) y = C  →  Δ = -Jᵀ y
    const A = J.map((ri) => J.map((rk) => ri.reduce((acc, x, j) => acc + x * rk[j], 0)));
    // amortiguación: restricciones repetidas (p. ej. horizontal + paralela a otra horizontal)
    // hacen el sistema casi singular y sin ella los puntos saltarían lejos
    const diag = Math.max(1e-12, ...A.map((r, i) => r[i]));
    for (let i = 0; i < m; i++) A[i][i] += 1e-6 * diag;
    const y = solveLinear(A, C);
    if (!y) break;
    const delta = vars.map((_, j) => { let d = 0; for (let i = 0; i < m; i++) d += J[i][j] * y[i]; return d; });
    // pasos cortos: como mucho 2 mm por vuelta, para no saltar a una solución rara
    const big = Math.max(...delta.map(Math.abs));
    const k = big > 2 ? 2 / big : 1;
    vars.forEach((key, j) => val.set(key, val.get(key)! - k * delta[j]));
  }
  worst = Math.max(...cons.map((c) => Math.abs(residual(c))));
  // escribir los números nuevos
  for (const k of free) {
    const [pid, i, ax] = k.split(":");
    const p = f.profiles.find((q) => q.id === pid) as Poly;
    const pt = p.pts[Number(i)];
    const nv = val.get(k)!;
    let old: number;
    try { old = ev(pt[ax as "x" | "y"]); } catch { old = NaN; }
    if (!(Math.abs(nv - old) < 1e-7)) p.pts[Number(i)] = { ...pt, [ax]: fmt(nv) };
  }
  return worst < 1e-4;
}

/** Resuelve A x = b (eliminación de Gauss con pivote). null si es singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
