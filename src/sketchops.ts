// Operaciones de boceto sobre números: redondear esquinas, desfase (copia paralela) y quitar tramos.
// Trabajan con puntos ya calculados; quien las llama convierte de/a texto.

export interface NP { x: number; y: number; s: number }
type V = [number, number];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const len = (a: V) => Math.hypot(a[0], a[1]);
const unit = (a: V): V => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

/** Centro y radio del arco a→b con flecha s (s > 0 = se abomba a la izquierda de a→b) */
export function arcCenter(a: V, b: V, s: number): { c: V; r: number } {
  const d = sub(b, a), ch = len(d);
  const n: V = [-d[1] / ch, d[0] / ch];
  const r = (ch * ch / 4 + s * s) / (2 * Math.abs(s));
  const m: V = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const peak: V = [m[0] + n[0] * s, m[1] + n[1] * s];
  const sg = Math.sign(s);
  return { c: [peak[0] - n[0] * sg * r, peak[1] - n[1] * sg * r], r };
}

/** Dirección de avance al empezar (at=0) o al acabar (at=1) el tramo a→b */
function tangent(a: V, b: V, s: number, at: 0 | 1): V {
  if (Math.abs(s) < 1e-9) return unit(sub(b, a));
  const { c } = arcCenter(a, b, s);
  const p = at === 0 ? a : b;
  const rv = sub(p, c);
  // s > 0: horario; s < 0: antihorario
  return unit(s > 0 ? [rv[1], -rv[0]] : [-rv[1], rv[0]]);
}

/** Área con signo (positiva = antihorario), con los arcos muestreados */
function signedArea(pts: NP[]): number {
  let A = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const seg: V[] = [[a.x, a.y]];
    if (Math.abs(a.s) > 1e-9) {
      const { c, r } = arcCenter([a.x, a.y], [b.x, b.y], a.s);
      const a0 = Math.atan2(a.y - c[1], a.x - c[0]);
      let a1 = Math.atan2(b.y - c[1], b.x - c[0]);
      if (a.s > 0) { while (a1 > a0) a1 -= 2 * Math.PI; } else { while (a1 < a0) a1 += 2 * Math.PI; }
      for (let k = 1; k < 16; k++) { const t = a0 + ((a1 - a0) * k) / 16; seg.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
    }
    seg.push([b.x, b.y]);
    for (let k = 0; k < seg.length - 1; k++) A += seg[k][0] * seg[k + 1][1] - seg[k + 1][0] * seg[k][1];
  }
  return A / 2;
}

/** Redondea la esquina i (entre dos tramos rectos) con radio r */
export function filletCorner(pts: NP[], i: number, r: number, closed: boolean): NP[] {
  const n = pts.length;
  if (!closed && (i === 0 || i === n - 1)) throw new Error("los extremos de una línea abierta no son esquinas");
  const ip = (i - 1 + n) % n, inx = (i + 1) % n;
  if (Math.abs(pts[ip].s) > 1e-9 || Math.abs(pts[i].s) > 1e-9) throw new Error("solo se redondean esquinas entre dos tramos rectos");
  const P: V = [pts[i].x, pts[i].y], A: V = [pts[ip].x, pts[ip].y], B: V = [pts[inx].x, pts[inx].y];
  const d1 = unit(sub(A, P)), d2 = unit(sub(B, P));
  const cos = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
  const phi = Math.acos(cos);
  if (phi < 1e-3 || Math.PI - phi < 1e-3) throw new Error("ahí no hay esquina (los tramos están en línea)");
  const t = r / Math.tan(phi / 2);
  if (t >= len(sub(A, P)) - 1e-6 || t >= len(sub(B, P)) - 1e-6) throw new Error("el radio es demasiado grande para esos tramos");
  const P1: V = [P[0] + d1[0] * t, P[1] + d1[1] * t], P2: V = [P[0] + d2[0] * t, P[1] + d2[1] * t];
  const turn = (P[0] - A[0]) * (B[1] - P[1]) - (P[1] - A[1]) * (B[0] - P[0]);
  const theta = Math.PI - phi;
  const s = -Math.sign(turn) * r * (1 - Math.cos(theta / 2));
  const out = pts.slice();
  out.splice(i, 1, { x: P1[0], y: P1[1], s }, { x: P2[0], y: P2[1], s: pts[i].s });
  return out;
}

/** Todas las esquinas posibles de un contorno, con radio r (las que no se pueden, se saltan) */
export function filletAll(pts: NP[], r: number, closed: boolean): { pts: NP[]; done: number } {
  let cur = pts.slice(), done = 0;
  // de atrás adelante para que los índices no se muevan
  for (let i = cur.length - 1; i >= 0; i--) {
    try { cur = filletCorner(cur, i, r, closed); done++; } catch { /* esa no se puede */ }
  }
  return { pts: cur, done };
}

/**
 * Copia paralela a distancia d. Contorno cerrado: d > 0 hacia fuera. Línea abierta: d > 0 hacia su izquierda.
 * Los arcos mantienen su centro y cambian de radio.
 */
export function offsetPoly(pts: NP[], d: number, closed: boolean): NP[] {
  const n = pts.length;
  const nSeg = closed ? n : n - 1;
  const orient = closed ? (signedArea(pts) > 0 ? -1 : 1) : 1; // multiplica la normal izquierda
  const normal = (t: V): V => [-t[1] * orient, t[0] * orient];
  const P = (k: number): V => [pts[k % n].x, pts[k % n].y];
  const out: NP[] = [];
  for (let i = 0; i < n; i++) {
    const hasIn = closed || i > 0, hasOut = closed || i < n - 1;
    const tin = hasIn ? tangent(P(i - 1 + n), P(i), pts[(i - 1 + n) % n].s, 1) : null;
    const tout = hasOut ? tangent(P(i), P(i + 1), pts[i].s, 0) : null;
    let off: V;
    if (tin && tout && tin[0] * tout[0] + tin[1] * tout[1] > 0.9995) {
      // empalme tangente (p. ej. recta → redondeo): manda la recta, que no arrastra redondeos de la flecha
      const inStraight = Math.abs(pts[(i - 1 + n) % n].s) < 1e-9;
      const nn = normal(inStraight ? tin : tout);
      off = [nn[0] * d, nn[1] * d];
    } else if (tin && tout) {
      const n1 = normal(tin), n2 = normal(tout);
      const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
      if (k < 1e-3) throw new Error("hay una punta demasiado afilada para el desfase");
      off = [((n1[0] + n2[0]) / k) * d, ((n1[1] + n2[1]) / k) * d];
    } else {
      const nn = normal((tin ?? tout)!);
      off = [nn[0] * d, nn[1] * d];
    }
    out.push({ x: pts[i].x + off[0], y: pts[i].y + off[1], s: 0 });
  }
  // flechas de los arcos: mismo centro, radio nuevo
  for (let i = 0; i < nSeg; i++) {
    const s = pts[i].s;
    if (Math.abs(s) < 1e-9) continue;
    const a = P(i), b = P(i + 1);
    const { c, r } = arcCenter(a, b, s);
    const na: V = [out[i].x, out[i].y], nb: V = [out[(i + 1) % n].x, out[(i + 1) % n].y];
    const r2 = len(sub(na, c));
    if (r2 < 1e-6) throw new Error("el desfase hace desaparecer un arco");
    const ch = len(sub(nb, na));
    const h = Math.sqrt(Math.max(0, r2 * r2 - (ch * ch) / 4));
    const major = Math.abs(s) > r;
    out[i].s = Math.sign(s) * (major ? r2 + h : r2 - h);
  }
  return out;
}

/** Quita el tramo i. Cerrado → una línea abierta. Abierto → hasta dos líneas. */
export function removeSegment(pts: NP[], i: number, closed: boolean): NP[][] {
  if (closed) {
    const rot = [...pts.slice(i + 1), ...pts.slice(0, i + 1)];
    rot[rot.length - 1] = { ...rot[rot.length - 1], s: 0 };
    return [rot];
  }
  const a = pts.slice(0, i + 1).map((p, k, arr) => (k === arr.length - 1 ? { ...p, s: 0 } : p));
  const b = pts.slice(i + 1);
  return [a, b].filter((x) => x.length >= 2);
}
