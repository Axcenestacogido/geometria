// Medir con un clic: reconocer círculos (aristas) y cilindros (caras) a partir de la malla.
// Cálculo puro, sin DOM, para poder probarlo aparte.

export type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Dos ejes perpendiculares a «n» (y entre sí) */
function basis(n: V3): [V3, V3] {
  const t: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(n, t));
  return [u, cross(n, u)];
}

/** Resuelve un sistema 3 × 3 (Cramer). null si no tiene solución clara. */
function solve3(m: number[][], b: number[]): [number, number, number] | null {
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  const col = (k: number) => m.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

export interface Circle3 { center: V3; normal: V3; r: number; /** ángulo que abarca (grados): 360 = entero */ sweep: number }

/** ¿Estos puntos (de una arista) forman un círculo o un arco? */
export function circleFrom(points: V3[]): Circle3 | null {
  if (points.length < 6) return null;
  const c0: V3 = [0, 0, 0];
  for (const p of points) { c0[0] += p[0] / points.length; c0[1] += p[1] / points.length; c0[2] += p[2] / points.length; }
  // normal del plano: la del triángulo más grande entre el centro y dos puntos repartidos
  let n: V3 = [0, 0, 0];
  const k = Math.floor(points.length / 3);
  for (let i = 0; i + k < points.length; i++) {
    const c = cross(sub(points[i], c0), sub(points[i + k], c0));
    if (len(c) > len(n)) n = c;
  }
  if (len(n) < 1e-9) return null; // en línea recta
  n = norm(n);
  if (points.some((p) => Math.abs(dot(sub(p, c0), n)) > 1e-3 * (1 + len(sub(p, c0))))) return null; // no es plana
  const [u, w] = basis(n);
  const xy = points.map((p) => { const d = sub(p, c0); return [dot(d, u), dot(d, w)] as [number, number]; });
  // ajuste algebraico: x² + y² + D x + E y + F = 0
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  for (const [x, y] of xy) {
    const row = [x, y, 1], rhs = -(x * x + y * y);
    for (let i = 0; i < 3; i++) { B[i] += row[i] * rhs; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; }
  }
  const s = solve3(A, B);
  if (!s) return null;
  const cx = -s[0] / 2, cy = -s[1] / 2, r = Math.sqrt(Math.max(0, cx * cx + cy * cy - s[2]));
  if (!(r > 1e-6)) return null;
  if (xy.some(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r) > Math.max(0.01, r * 0.01))) return null;
  // ángulo barrido: suma de los giros entre puntos seguidos
  let sweep = 0;
  for (let i = 1; i < xy.length; i++) {
    const a = Math.atan2(xy[i - 1][1] - cy, xy[i - 1][0] - cx), b = Math.atan2(xy[i][1] - cy, xy[i][0] - cx);
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sweep += d;
  }
  const center: V3 = [c0[0] + u[0] * cx + w[0] * cy, c0[1] + u[1] * cx + w[1] * cy, c0[2] + u[2] * cx + w[2] * cy];
  return { center, normal: n, r, sweep: Math.min(360, Math.abs((sweep * 180) / Math.PI)) };
}

export type FaceKind =
  | { kind: "plane"; normal: V3 }
  | { kind: "cylinder"; axis: V3; r: number; /** true = agujero (la pieza queda fuera del cilindro) */ hole: boolean; /** true = da la vuelta entera (no es un trozo, como un redondeo) */ full: boolean }
  | { kind: "other" };

/** Reconoce una cara por sus vértices y normales (las de la malla, hacia fuera de la pieza) */
export function faceKind(verts: V3[], normals: V3[]): FaceKind {
  if (!verts.length) return { kind: "other" };
  const n0 = norm(normals[0]);
  if (normals.every((n) => dot(norm(n), n0) > 0.9995)) return { kind: "plane", normal: n0 };
  // eje: perpendicular a dos normales bien distintas
  let axis: V3 = [0, 0, 0];
  for (const n of normals) { const c = cross(n0, norm(n)); if (len(c) > len(axis)) axis = c; }
  if (len(axis) < 1e-6) return { kind: "other" };
  axis = norm(axis);
  if (normals.some((n) => Math.abs(dot(norm(n), axis)) > 0.02)) return { kind: "other" }; // cono, esfera…
  const [u, w] = basis(axis);
  // cada vértice = centro + r · normal (en el plano perpendicular al eje): mínimos cuadrados en (cx, cy, r)
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  verts.forEach((v, i) => {
    const n = norm(normals[i]);
    const px = dot(v, u), py = dot(v, w), nx = dot(n, u), ny = dot(n, w);
    for (const [row, rhs] of [[[1, 0, nx], px], [[0, 1, ny], py]] as [number[], number][]) {
      for (let a = 0; a < 3; a++) { B[a] += row[a] * rhs; for (let b = 0; b < 3; b++) A[a][b] += row[a] * row[b]; }
    }
  });
  const s = solve3(A, B);
  if (!s) return { kind: "other" };
  const [cx, cy, r] = s;
  const ok = verts.every((v, i) => {
    const n = norm(normals[i]);
    return Math.hypot(dot(v, u) - (cx + r * dot(n, u)), dot(v, w) - (cy + r * dot(n, w))) < Math.max(0.02, Math.abs(r) * 0.02);
  });
  if (!ok || Math.abs(r) < 1e-6) return { kind: "other" };
  // ¿da la vuelta entera? mirando el mayor hueco entre las direcciones de las normales
  const ang = normals.map((n) => Math.atan2(dot(norm(n), w), dot(norm(n), u))).sort((a, b) => a - b);
  let gap = ang[0] + 2 * Math.PI - ang[ang.length - 1];
  for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
  return { kind: "cylinder", axis, r: Math.abs(r), hole: r < 0, full: gap < Math.PI / 3 };
}

/** Ángulo entre dos caras planas (0-90°) y, si son paralelas, la distancia entre ellas */
export function planesAngle(n1: V3, p1: V3, n2: V3, p2: V3): { angle: number; gap: number | null } {
  const c = Math.min(1, Math.abs(dot(norm(n1), norm(n2))));
  const angle = (Math.acos(c) * 180) / Math.PI;
  return { angle, gap: angle < 0.05 ? Math.abs(dot(sub(p2, p1), norm(n1))) : null };
}
