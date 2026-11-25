import type { Vec3 } from "./types";

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface Basis {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  n: Vec3;
}

/** Planos estándar (mismos ejes que usa el motor) */
export const STD: Record<"XY" | "XZ" | "YZ", { x: Vec3; n: Vec3 }> = {
  XY: { x: [1, 0, 0], n: [0, 0, 1] },
  XZ: { x: [1, 0, 0], n: [0, -1, 0] },
  YZ: { x: [0, 1, 0], n: [1, 0, 0] },
};

type ResolvedPlane = (
  | { kind: "std"; name: "XY" | "XZ" | "YZ"; offset: number }
  | { kind: "face"; origin: Vec3; normal: Vec3; xDir: Vec3; offset: number }
) & { tilt?: number; turn?: number };

export function planeBasis(p: ResolvedPlane): Basis {
  let origin: Vec3, x: Vec3, n: Vec3;
  if (p.kind === "std") {
    ({ x, n } = STD[p.name]);
    origin = [0, 0, 0];
  } else {
    origin = p.origin;
    x = norm(p.xDir);
    n = norm(p.normal);
  }
  origin = add(origin, scale(n, p.offset || 0));
  let y = cross(n, x);
  // inclinar: girar el plano alrededor de su eje X (como abrir una tapa)
  const t = ((p.tilt || 0) * Math.PI) / 180;
  if (t) {
    const [c, s] = [Math.cos(t), Math.sin(t)];
    [y, n] = [add(scale(y, c), scale(n, s)), add(scale(n, c), scale(y, -s))];
  }
  // girar el dibujo dentro del plano (alrededor de la normal)
  const r = ((p.turn || 0) * Math.PI) / 180;
  if (r) {
    const [c, s] = [Math.cos(r), Math.sin(r)];
    [x, y] = [add(scale(x, c), scale(y, s)), add(scale(y, c), scale(x, -s))];
  }
  return { origin, x, y, n };
}

export const toWorld = (b: Basis, u: number, v: number): Vec3 =>
  add(b.origin, add(scale(b.x, u), scale(b.y, v)));

/** Plano a partir de un punto y una normal (clic en una cara plana). */
export function planeFromHit(point: Vec3, normal: Vec3) {
  const n = norm(normal);
  // Origen = el punto del plano más cercano al origen del mundo
  const origin = scale(n, dot(n, point));
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  // Eje X horizontal siempre que se pueda
  let x = norm(cross(ref, n));
  if (Math.abs(n[2]) >= 0.9) x = [1, 0, 0];
  const round = (v: Vec3): Vec3 => v.map((c) => Math.round(c * 1e6) / 1e6) as Vec3;
  return { origin: round(origin), normal: round(n), xDir: round(x) };
}

/**
 * Puntos de un arco definido por cuerda (a→b) y flecha s
 * (s > 0 = el arco se abomba a la izquierda de a→b).
 */
export function arcPoints(a: [number, number], b: [number, number], s: number, steps = 24): [number, number][] {
  if (!s) return [a, b];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const c = Math.hypot(dx, dy);
  if (c < 1e-9) return [a, b];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  // normal a la izquierda
  const nx = -dy / c, ny = dx / c;
  const peak: [number, number] = [mx + nx * s, my + ny * s];
  // centro del círculo por los 3 puntos
  const r = (c * c / 4 + s * s) / (2 * Math.abs(s));
  const sign = Math.sign(s);
  const cx = peak[0] - nx * sign * r, cy = peak[1] - ny * sign * r;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  let a1 = Math.atan2(b[1] - cy, b[0] - cx);
  // s > 0 (izquierda) => recorrido horario; s < 0 => antihorario
  if (s > 0) { while (a1 > a0) a1 -= 2 * Math.PI; } else { while (a1 < a0) a1 += 2 * Math.PI; }
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

type V2 = [number, number];

/**
 * Curva suave (spline) que pasa por todos los puntos: un tramo de Bézier cúbica entre cada dos,
 * con las tangentes de Catmull-Rom (sin picos en los puntos). Devuelve [inicio, control 1, control 2, fin].
 */
export function smoothSegs(pts: V2[], closed: boolean): [V2, V2, V2, V2][] {
  const n = pts.length;
  if (n < 2) return [];
  const at = (i: number): V2 => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out: [V2, V2, V2, V2][] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1: V2 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: V2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    out.push([p1, c1, c2, p2]);
  }
  return out;
}

/** Puntos de una Bézier cúbica, para dibujarla */
export function bezierPoints([a, b, c, d]: [V2, V2, V2, V2], steps = 16): V2[] {
  const out: V2[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps, u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push([w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]]);
  }
  return out;
}

export const uid = () => Math.random().toString(36).slice(2, 9);

type RProfile =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle" | "ngon"; cx: number; cy: number; r: number; n?: number }
  | { kind: "poly"; pts: { x: number; y: number; s?: number }[]; open?: boolean; smooth?: boolean };

/** Contorno 2D (en mm) de un perfil ya calculado */
export function profileLoop(p: RProfile): [number, number][] {
  if (p.kind === "rect") {
    const { x, y, w, h } = p;
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  }
  if (p.kind !== "poly") {
    const n = p.kind === "ngon" ? Math.max(3, Math.round(p.n ?? 6)) : 72;
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2 + (p.kind === "ngon" ? Math.PI / 2 : 0);
      out.push([p.cx + p.r * Math.cos(t), p.cy + p.r * Math.sin(t)]);
    }
    return out;
  }
  const out: [number, number][] = [];
  if (p.smooth && p.pts.length >= 2) {
    smoothSegs(p.pts.map((q) => [q.x, q.y]), !p.open).forEach((sg, i) => out.push(...(i === 0 ? bezierPoints(sg) : bezierPoints(sg).slice(1))));
    return out;
  }
  p.pts.forEach((a, i) => {
    // en una línea abierta no hay tramo de vuelta al primer punto
    if (p.open && i === p.pts.length - 1) return;
    const b = p.pts[(i + 1) % p.pts.length];
    const seg = arcPoints([a.x, a.y], [b.x, b.y], a.s || 0);
    out.push(...(i === 0 ? seg : seg.slice(1)));
  });
  return out;
}
