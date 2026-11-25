// Cotas a tu elección en el plano 2D: puntos donde se engancha el ratón y dibujo de cada cota.
// Todo es geometría pura (sin DOM), para poder probarlo aparte.
import type { DrawingDim } from "./types";

export type P2 = [number, number];
export interface Circle { c: P2; r: number; full: boolean }
export interface Snaps { pts: P2[]; circles: Circle[] }

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Centro y ángulo barrido de un arco SVG «A r r 0 large sweep x y» que va de p0 a p1 */
export function svgArcCenter(p0: P2, p1: P2, r: number, large: boolean, sweep: boolean): { c: P2; angle: number } {
  const x1 = (p0[0] - p1[0]) / 2, y1 = (p0[1] - p1[1]) / 2;
  const q = x1 * x1 + y1 * y1;
  const rr = Math.max(r, Math.sqrt(q));
  const coef = Math.sqrt(Math.max(0, (rr * rr - q) / (q || 1e-12))) * (large === sweep ? -1 : 1);
  const cx = coef * y1, cy = -coef * x1;
  const c: P2 = [cx + (p0[0] + p1[0]) / 2, cy + (p0[1] + p1[1]) / 2];
  const t1 = Math.atan2((y1 - cy) / rr, (x1 - cx) / rr);
  let dt = Math.atan2((-y1 - cy) / rr, (-x1 - cx) / rr) - t1;
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  return { c, angle: Math.abs(dt) };
}

/** Saca de los trazos de una vista los puntos donde enganchar (extremos, medios de rectas, centros) y los círculos */
export function snapsFromPaths(paths: string[]): Snaps {
  const pts: P2[] = [];
  const arcs: { c: P2; r: number; angle: number }[] = [];
  for (const d of paths) {
    const tk = d.trim().split(/[\s,]+/);
    let i = 0, cur: P2 = [0, 0], start: P2 = [0, 0];
    const num = () => Number(tk[i++]);
    while (i < tk.length) {
      const cmd = tk[i++];
      if (cmd === "M") { cur = [num(), num()]; start = cur; pts.push(cur); }
      else if (cmd === "L") { const p: P2 = [num(), num()]; pts.push(p, [(cur[0] + p[0]) / 2, (cur[1] + p[1]) / 2]); cur = p; }
      else if (cmd === "Q") { i += 2; cur = [num(), num()]; pts.push(cur); }
      else if (cmd === "C") { i += 4; cur = [num(), num()]; pts.push(cur); }
      else if (cmd === "A") {
        const rx = num(), ry = num(); i++; const large = tk[i++] === "1", sweep = tk[i++] === "1";
        const p: P2 = [num(), num()];
        if (Math.abs(rx - ry) < 1e-6 * Math.max(1, rx)) {
          const { c, angle } = svgArcCenter(cur, p, rx, large, sweep);
          arcs.push({ c, r: rx, angle });
        }
        if (dist(cur, p) > 1e-3) pts.push(p);
        cur = p;
      } else if (cmd === "Z" || cmd === "z") { cur = start; }
      else break; // algo que no sabemos leer: mejor parar que inventar
    }
  }
  // arcos del mismo círculo juntos: si suman una vuelta, es un círculo entero
  const circles: Circle[] = [];
  const sum: number[] = [];
  for (const a of arcs) {
    const k = circles.findIndex((c) => dist(c.c, a.c) < 1e-3 && Math.abs(c.r - a.r) < 1e-3);
    if (k >= 0) sum[k] += a.angle;
    else { circles.push({ c: a.c, r: a.r, full: false }); sum.push(a.angle); }
  }
  circles.forEach((c, k) => { c.full = sum[k] > 2 * Math.PI - 0.02; pts.push(c.c); });
  // sin repetidos
  const out: P2[] = [];
  for (const p of pts) if (Number.isFinite(p[0]) && Number.isFinite(p[1]) && !out.some((q) => dist(p, q) < 1e-4)) out.push(p);
  return { pts: out, circles };
}

export function nearestPoint(s: Snaps, p: P2, tol: number): P2 | null {
  let best: P2 | null = null, bd = tol;
  for (const q of s.pts) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
  return best;
}

export function nearestCircle(s: Snaps, p: P2, tol: number): Circle | null {
  let best: Circle | null = null, bd = tol;
  for (const c of s.circles) { const d = Math.abs(dist(p, c.c) - c.r); if (d < bd) { bd = d; best = c; } }
  return best;
}

/** Lo que mide la cota, en mm */
export function dimValue(d: DrawingDim): number {
  if (d.kind === "h") return Math.abs(d.b[0] - d.a[0]);
  if (d.kind === "v") return Math.abs(d.b[1] - d.a[1]);
  if (d.kind === "a") return dist(d.a, d.b);
  return (d.r ?? 0) * (d.kind === "d" ? 2 : 1);
}

/** ¿Sigue la cota enganchada a la pieza tal como está ahora? (si la cambias, puede quedar suelta) */
export function dimAttached(d: DrawingDim, s: Snaps): boolean {
  const near = (p: P2) => s.pts.some((q) => dist(p, q) < 1e-2);
  if (d.kind === "d" || d.kind === "r") return !!d.c && s.circles.some((c) => dist(c.c, d.c!) < 1e-2 && Math.abs(c.r - (d.r ?? 0)) < 1e-2);
  return near(d.a) && near(d.b);
}

/** Cómo se pasa de mm de la vista a mm de la hoja */
export interface ViewXf { ox: number; oy: number; k: number }
const toSheet = (x: ViewXf, p: P2): P2 => [x.ox + p[0] * x.k, x.oy + p[1] * x.k];
const f = (v: number) => v.toFixed(3);

/** Flecha con la punta en p y apuntando en la dirección u (en la hoja) */
function arrow(p: P2, u: P2, color: string) {
  const a = 1.6, w = a / 3;
  const b: P2 = [p[0] - u[0] * a, p[1] - u[1] * a];
  const n: P2 = [-u[1] * w, u[0] * w];
  return `<path d="M${f(p[0])} ${f(p[1])} L${f(b[0] + n[0])} ${f(b[1] + n[1])} L${f(b[0] - n[0])} ${f(b[1] - n[1])} Z" fill="${color}"/>`;
}
const line = (a: P2, b: P2, w: number, color: string) => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="${color}" stroke-width="${w}"/>`;

/** Texto a lo largo de la dirección u, siempre legible (nunca boca abajo) */
function label(p: P2, u: P2, txt: string, color: string) {
  let ang = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  if (ang >= 89.99) ang -= 180;
  if (ang < -90.01) ang += 180;
  const t = ang ? ` transform="rotate(${ang.toFixed(2)} ${f(p[0])} ${f(p[1])})"` : "";
  return `<text x="${f(p[0])}" y="${f(p[1])}" font-size="3" text-anchor="middle" fill="${color}"${t}>${txt}</text>`;
}

/** Dibuja una cota en la hoja. Devuelve el SVG y el punto de su texto (para poder borrarla con un clic). */
export function dimSvg(d: DrawingDim, x: ViewXf, txt: string, color = "#000"): { svg: string; at: P2 } {
  const out: string[] = [];
  if (d.kind === "d" || d.kind === "r") {
    const c = toSheet(x, d.c!), r = (d.r ?? 0) * x.k;
    const dir0: P2 = [d.a[0] - d.c![0], d.a[1] - d.c![1]];
    const l = Math.hypot(dir0[0], dir0[1]) || 1;
    const u: P2 = [dir0[0] / l, dir0[1] / l];
    const edge: P2 = [c[0] + u[0] * r, c[1] + u[1] * r];
    const tail: P2 = [edge[0] + u[0] * 7, edge[1] + u[1] * 7];
    const shelf: P2 = [tail[0] + (u[0] >= 0 ? 1 : -1) * (txt.length * 1.7 + 1), tail[1]];
    if (d.kind === "d") {
      const other: P2 = [c[0] - u[0] * r, c[1] - u[1] * r];
      out.push(line(other, tail, 0.18, color), arrow(edge, u, color), arrow(other, [-u[0], -u[1]], color));
    } else {
      out.push(line(c, tail, 0.18, color), arrow(edge, u, color));
    }
    out.push(line(tail, shelf, 0.18, color));
    const at: P2 = [(tail[0] + shelf[0]) / 2, tail[1] - 1];
    out.push(`<text x="${f(at[0])}" y="${f(at[1])}" font-size="3" text-anchor="middle" fill="${color}">${txt}</text>`);
    return { svg: out.join(""), at };
  }
  // lineales: a y b, con la línea de cota en «off»
  let A: P2 = d.a, B: P2 = d.b, LA: P2, LB: P2;
  if (d.kind === "h") { LA = [A[0], d.off]; LB = [B[0], d.off]; }
  else if (d.kind === "v") { LA = [d.off, A[1]]; LB = [d.off, B[1]]; }
  else {
    const l = dist(A, B) || 1;
    const n: P2 = [-(B[1] - A[1]) / l, (B[0] - A[0]) / l];
    LA = [A[0] + n[0] * d.off, A[1] + n[1] * d.off]; LB = [B[0] + n[0] * d.off, B[1] + n[1] * d.off];
  }
  A = toSheet(x, A); B = toSheet(x, B); LA = toSheet(x, LA); LB = toSheet(x, LB);
  // líneas de referencia, con un hueco junto a la pieza y pasando 1 mm de la cota
  const ext = (p: P2, q: P2) => {
    const l = dist(p, q);
    if (l < 0.3) return "";
    const u: P2 = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    return line([p[0] + u[0] * Math.min(1, l / 3), p[1] + u[1] * Math.min(1, l / 3)], [q[0] + u[0], q[1] + u[1]], 0.13, color);
  };
  out.push(ext(A, LA), ext(B, LB));
  const l = dist(LA, LB);
  const u: P2 = l > 1e-6 ? [(LB[0] - LA[0]) / l, (LB[1] - LA[1]) / l] : [1, 0];
  out.push(line(LA, LB, 0.18, color));
  if (l > 4) out.push(arrow(LA, [-u[0], -u[1]], color), arrow(LB, u, color));
  else {
    // cota muy corta: flechas por fuera
    out.push(arrow(LA, u, color), arrow(LB, [-u[0], -u[1]], color),
      line([LA[0] - u[0] * 3, LA[1] - u[1] * 3], LA, 0.18, color), line(LB, [LB[0] + u[0] * 3, LB[1] + u[1] * 3], 0.18, color));
  }
  // texto encima de la línea (hacia «arriba» del texto)
  const ang = Math.atan2(u[1], u[0]);
  const tu: P2 = ang >= Math.PI / 2 - 1e-3 || ang < -Math.PI / 2 - 1e-3 ? [-u[0], -u[1]] : u;
  const up: P2 = [tu[1], -tu[0]];
  const at: P2 = [(LA[0] + LB[0]) / 2 + up[0] * 1.2, (LA[1] + LB[1]) / 2 + up[1] * 1.2];
  out.push(label(at, tu, txt, color));
  return { svg: out.join(""), at };
}
