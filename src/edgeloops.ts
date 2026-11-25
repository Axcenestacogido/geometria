// Bordes de la pieza → perfiles de boceto.
// Recibe tramos 2D sueltos (u1, v1, u2, v2, …) ya pasados al plano del boceto, los une en
// lazos cerrados y reconoce círculos y rectángulos (para que queden con sus medidas limpias).
// Cálculo puro, sin DOM, para poder probarlo aparte.

export type P2 = [number, number];

export type EdgeShape =
  | { kind: "circle"; cx: number; cy: number; r: number; hole: boolean }
  | { kind: "rect"; x: number; y: number; w: number; h: number; hole: boolean }
  | { kind: "poly"; pts: P2[]; hole: boolean };

const KEY = (p: P2) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;

/** Une los tramos en lazos cerrados (los abiertos se descartan) */
export function chainLoops(segs: number[]): P2[][] {
  const pts = new Map<string, P2>();
  const adj = new Map<string, string[]>();
  const seen = new Set<string>();
  for (let i = 0; i + 3 < segs.length; i += 4) {
    const a: P2 = [segs[i], segs[i + 1]], b: P2 = [segs[i + 2], segs[i + 3]];
    const ka = KEY(a), kb = KEY(b);
    if (ka === kb) continue;
    const e = ka < kb ? ka + "|" + kb : kb + "|" + ka;
    if (seen.has(e)) continue; // el mismo tramo dos veces (dos aristas que se ven encima)
    seen.add(e);
    pts.set(ka, a); pts.set(kb, b);
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push(kb);
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push(ka);
  }
  const used = new Set<string>();
  const ek = (a: string, b: string) => (a < b ? a + "|" + b : b + "|" + a);
  const loops: P2[][] = [];
  for (const start of adj.keys()) {
    for (const first of adj.get(start)!) {
      if (used.has(ek(start, first))) continue;
      const keys = [start];
      used.add(ek(start, first));
      let prev = start, cur = first, ok = false;
      for (let guard = 0; guard < 100000; guard++) {
        if (cur === start) { ok = true; break; }
        keys.push(cur);
        const next = (adj.get(cur) ?? []).find((k) => k !== prev && !used.has(ek(cur, k)));
        if (next === undefined) break;
        used.add(ek(cur, next));
        prev = cur; cur = next;
      }
      if (ok && keys.length >= 3) loops.push(keys.map((k) => pts.get(k)!));
    }
  }
  return loops;
}

export function area(p: P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** Quita puntos que están en línea recta con sus vecinos */
function dropCollinear(p: P2[]): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (Math.abs(cross) > 1e-6 * Math.max(1, len)) out.push(b);
  }
  return out.length >= 3 ? out : p;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Reconoce la forma de un lazo: círculo, rectángulo recto o polilínea */
export function shapeOf(loop: P2[], hole: boolean): EdgeShape {
  // círculo: muchos puntos, todos a la misma distancia del centro
  if (loop.length >= 12) {
    const cx = loop.reduce((s, p) => s + p[0], 0) / loop.length, cy = loop.reduce((s, p) => s + p[1], 0) / loop.length;
    const rs = loop.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
    const r = rs.reduce((s, v) => s + v, 0) / rs.length;
    if (r > 0 && rs.every((v) => Math.abs(v - r) < Math.max(0.02, r * 0.01))) return { kind: "circle", cx: r3(cx), cy: r3(cy), r: r3(r), hole };
  }
  const p = dropCollinear(loop);
  // rectángulo con los lados rectos (en los ejes del boceto)
  if (p.length === 4) {
    const xs = [...new Set(p.map((q) => r3(q[0])))], ys = [...new Set(p.map((q) => r3(q[1])))];
    if (xs.length === 2 && ys.length === 2) {
      const x = Math.min(...xs), y = Math.min(...ys);
      return { kind: "rect", x, y, w: r3(Math.max(...xs) - x), h: r3(Math.max(...ys) - y), hole };
    }
  }
  return { kind: "poly", pts: p.map((q) => [r3(q[0]), r3(q[1])] as P2), hole };
}

/** Tramos → formas, con los agujeros marcados (un lazo dentro de otro, a profundidad impar) */
export function edgeShapes(segs: number[], minArea = 0.01): EdgeShape[] {
  const loops = chainLoops(segs).filter((l) => Math.abs(area(l)) >= minArea);
  // lazos repetidos (p. ej. arriba y abajo de una caja vistos de frente): uno solo
  const sig = (l: P2[]) => `${r3(Math.abs(area(l)))}:${l.map(KEY).sort()[0]}`;
  const uniq = [...new Map(loops.map((l) => [sig(l), l])).values()];
  return uniq.map((l) => {
    const depth = uniq.filter((o) => o !== l && Math.abs(area(o)) > Math.abs(area(l)) && inside(l[0], o)).length;
    return shapeOf(l, depth % 2 === 1);
  });
}
