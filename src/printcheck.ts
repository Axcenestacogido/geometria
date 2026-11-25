// Comprobación para imprimir: ¿cabe en la cama?, ¿hay voladizos?, ¿hay paredes muy finas?
// Se hace sobre la malla que ya se dibuja, en el propio navegador.

import type { BodyMesh } from "./types";

export interface PrintSettings { bedX: number; bedY: number; bedZ: number; minWall: number; maxOverhang: number }
export const DEFAULT_PRINT: PrintSettings = { bedX: 256, bedY: 256, bedZ: 256, minWall: 0.8, maxOverhang: 45 };

export interface PrintCheck {
  size: [number, number, number];
  fits: boolean;
  /** cabría girándola 90° en la cama */
  fitsRotated: boolean;
  /** la pieza no toca el suelo (Z mínima distinta de 0) */
  floating: number;
  overhangArea: number;
  overhangTris: Float32Array;
  thinArea: number;
  thinTris: Float32Array;
  /** true si la pared fina se miró solo en una muestra de triángulos */
  sampled: boolean;
}

type V = [number, number, number];

export function checkPrint(bodies: BodyMesh[], st: PrintSettings): PrintCheck {
  // todos los triángulos juntos
  const tris: { a: V; b: V; c: V; n: V; area: number }[] = [];
  const mn: V = [Infinity, Infinity, Infinity], mx: V = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    const P = b.vertices, T = b.triangles;
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
    for (let i = 0; i < T.length; i += 3) {
      const a: V = [P[T[i] * 3], P[T[i] * 3 + 1], P[T[i] * 3 + 2]];
      const bb: V = [P[T[i + 1] * 3], P[T[i + 1] * 3 + 1], P[T[i + 1] * 3 + 2]];
      const c: V = [P[T[i + 2] * 3], P[T[i + 2] * 3 + 1], P[T[i + 2] * 3 + 2]];
      const u = sub(bb, a), v = sub(c, a);
      let n = cross(u, v);
      const L = Math.hypot(...n);
      if (L < 1e-12) continue;
      n = [n[0] / L, n[1] / L, n[2] / L];
      // la normal guardada por el motor manda (apunta hacia fuera)
      const N = b.normals;
      const sn: V = [N[T[i] * 3] + N[T[i + 1] * 3] + N[T[i + 2] * 3], N[T[i] * 3 + 1] + N[T[i + 1] * 3 + 1] + N[T[i + 2] * 3 + 1], N[T[i] * 3 + 2] + N[T[i + 1] * 3 + 2] + N[T[i + 2] * 3 + 2]];
      if (dot(sn, n) < 0) n = [-n[0], -n[1], -n[2]];
      tris.push({ a, b: bb, c, n, area: L / 2 });
    }
  }
  const size: [number, number, number] = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const fits = size[0] <= st.bedX && size[1] <= st.bedY && size[2] <= st.bedZ;
  const fitsRotated = !fits && size[1] <= st.bedX && size[0] <= st.bedY && size[2] <= st.bedZ;

  // voladizos: caras que miran hacia abajo más tumbadas que el ángulo máximo y que no están en la cama
  const lim = -Math.cos((st.maxOverhang * Math.PI) / 180);
  const over: number[] = [];
  let overhangArea = 0;
  for (const t of tris) {
    if (t.n[2] >= lim) continue;
    if (Math.min(t.a[2], t.b[2], t.c[2]) < mn[2] + 0.05) continue; // apoyada en la cama
    over.push(...t.a, ...t.b, ...t.c);
    overhangArea += t.area;
  }

  // paredes finas: desde el centro de cada triángulo, hacia dentro, ¿a qué distancia está la otra cara?
  const grid = new TriGrid(tris, mn, mx, Math.max(st.minWall * 2, Math.max(...size) / 80));
  const MAX = 20000;
  const stride = Math.max(1, Math.ceil(tris.length / MAX));
  const thin: number[] = [];
  let thinArea = 0;
  for (let i = 0; i < tris.length; i += stride) {
    const t = tris[i];
    const c: V = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
    const d: V = [-t.n[0], -t.n[1], -t.n[2]];
    const hit = grid.nearestHit(c, d, st.minWall, i);
    if (hit < st.minWall) { thin.push(...t.a, ...t.b, ...t.c); thinArea += t.area * stride; }
  }
  return {
    size, fits, fitsRotated, floating: mn[2],
    overhangArea, overhangTris: new Float32Array(over),
    thinArea, thinTris: new Float32Array(thin), sampled: stride > 1,
  };
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Rejilla de cubos con los triángulos que tocan cada uno, para lanzar rayos cortos deprisa */
class TriGrid {
  private cells = new Map<string, number[]>();
  constructor(private tris: { a: V; b: V; c: V }[], private mn: V, _mx: V, private cell: number) {
    tris.forEach((t, i) => {
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(t.a[k], t.b[k], t.c[k]) - mn[k]) / cell));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(t.a[k], t.b[k], t.c[k]) - mn[k]) / cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const k = `${x},${y},${z}`;
        const l = this.cells.get(k);
        if (l) l.push(i); else this.cells.set(k, [i]);
      }
    });
  }

  /** distancia al primer triángulo que corta el rayo (máximo `maxT`), saltándose el propio */
  nearestHit(o: V, d: V, maxT: number, self: number): number {
    const e: V = [o[0] + d[0] * maxT, o[1] + d[1] * maxT, o[2] + d[2] * maxT];
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(o[k], e[k]) - this.mn[k]) / this.cell));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(o[k], e[k]) - this.mn[k]) / this.cell));
    let best = Infinity;
    const seen = new Set<number>();
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      for (const i of this.cells.get(`${x},${y},${z}`) ?? []) {
        if (i === self || seen.has(i)) continue;
        seen.add(i);
        const t = rayTri(o, d, this.tris[i]);
        if (t > 1e-3 && t < best) best = t;
      }
    }
    return best;
  }
}

/** Möller–Trumbore: distancia del rayo al triángulo, o Infinity */
function rayTri(o: V, d: V, t: { a: V; b: V; c: V }): number {
  const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const s = sub(o, t.a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const tt = dot(e2, q) * inv;
  return tt > 0 ? tt : Infinity;
}
