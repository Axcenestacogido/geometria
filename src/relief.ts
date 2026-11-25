// Relieve desde una imagen: de una foto o logo en grises sacamos
//  · «logo»: los contornos de lo oscuro, para extruirlos (o grabarlos)
//  · «relieve»: una malla de alturas (oscuro = más alto), como una litofanía
// Todo es cálculo puro (sin DOM), para poder probarlo aparte.

/** Imagen en grises: 0 = negro, 255 = blanco. Fila 0 = arriba */
export interface Gray { w: number; h: number; data: Uint8Array }

export type P2 = [number, number];

/** Rejilla de «oscuridad» (0 = blanco, 1 = negro) con n puntos en el lado largo, por promedio de zonas */
export function darkGrid(img: Gray, n: number, invert: boolean): { w: number; h: number; v: Float32Array } {
  const long = Math.max(img.w, img.h);
  const k = Math.min(1, Math.max(2, Math.round(n)) / long); // nunca más puntos que píxeles
  const w = Math.max(2, Math.round(img.w * k)), h = Math.max(2, Math.round(img.h * k));
  const v = new Float32Array(w * h);
  const sx = img.w / w, sy = img.h / h;
  for (let j = 0; j < h; j++) {
    const y0 = Math.floor(j * sy), y1 = Math.max(y0 + 1, Math.floor((j + 1) * sy));
    for (let i = 0; i < w; i++) {
      const x0 = Math.floor(i * sx), x1 = Math.max(x0 + 1, Math.floor((i + 1) * sx));
      let s = 0, c = 0;
      for (let y = y0; y < y1 && y < img.h; y++) for (let x = x0; x < x1 && x < img.w; x++) { s += img.data[y * img.w + x]; c++; }
      const d = 1 - s / (c || 1) / 255;
      v[j * w + i] = invert ? 1 - d : d;
    }
  }
  return { w, h, v };
}

/** Suaviza la rejilla (media de 3 × 3), las veces que digas */
export function blur(g: { w: number; h: number; v: Float32Array }, passes = 2) {
  let v = g.v;
  for (let p = 0; p < passes; p++) {
    const o = new Float32Array(v.length);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      let s = 0, c = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const x = i + a, y = j + b;
        if (x >= 0 && y >= 0 && x < g.w && y < g.h) { s += v[y * g.w + x]; c++; }
      }
      o[j * g.w + i] = s / c;
    }
    v = o;
  }
  return { ...g, v };
}

/**
 * Contornos donde la oscuridad cruza «level» (marching squares), en unidades de rejilla
 * (x a la derecha, y hacia abajo). Los bordes de la imagen cuentan como blanco, así que
 * todos los contornos salen cerrados.
 */
export function contours(g: { w: number; h: number; v: Float32Array }, level: number): P2[][] {
  // rejilla con un marco blanco alrededor
  const W = g.w + 2, H = g.h + 2;
  const val = (i: number, j: number) => (i <= 0 || j <= 0 || i >= W - 1 || j >= H - 1 ? 0 : g.v[(j - 1) * g.w + (i - 1)]);
  const pt = new Map<string, P2>();
  const at = (key: string, a: P2, va: number, b: P2, vb: number): string => {
    if (!pt.has(key)) {
      const s = Math.abs(vb - va) < 1e-9 ? 0.5 : Math.min(1, Math.max(0, (level - va) / (vb - va)));
      pt.set(key, [a[0] + (b[0] - a[0]) * s - 1, a[1] + (b[1] - a[1]) * s - 1]);
    }
    return key;
  };
  const segs: [string, string][] = [];
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const tl = val(i, j), tr = val(i + 1, j), br = val(i + 1, j + 1), bl = val(i, j + 1);
    const c = (tl > level ? 8 : 0) | (tr > level ? 4 : 0) | (br > level ? 2 : 0) | (bl > level ? 1 : 0);
    if (c === 0 || c === 15) continue;
    const T = () => at(`h${i},${j}`, [i, j], tl, [i + 1, j], tr);
    const Rt = () => at(`v${i + 1},${j}`, [i + 1, j], tr, [i + 1, j + 1], br);
    const B = () => at(`h${i},${j + 1}`, [i, j + 1], bl, [i + 1, j + 1], br);
    const L = () => at(`v${i},${j}`, [i, j], tl, [i, j + 1], bl);
    const mid = (tl + tr + br + bl) / 4 > level;
    switch (c) {
      case 1: case 14: segs.push([L(), B()]); break;
      case 2: case 13: segs.push([B(), Rt()]); break;
      case 3: case 12: segs.push([L(), Rt()]); break;
      case 4: case 11: segs.push([T(), Rt()]); break;
      case 6: case 9: segs.push([T(), B()]); break;
      case 7: case 8: segs.push([L(), T()]); break;
      case 5: if (mid) segs.push([L(), T()], [B(), Rt()]); else segs.push([L(), B()], [T(), Rt()]); break;
      case 10: if (mid) segs.push([L(), B()], [T(), Rt()]); else segs.push([L(), T()], [B(), Rt()]); break;
    }
  }
  // unir los tramos en lazos
  const by = new Map<string, number[]>();
  segs.forEach(([a, b], k) => { (by.get(a) ?? by.set(a, []).get(a)!).push(k); (by.get(b) ?? by.set(b, []).get(b)!).push(k); });
  const used = new Uint8Array(segs.length);
  const loops: P2[][] = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const start = segs[s0][0];
    const keys = [start];
    let cur = segs[s0][1];
    while (cur !== start) {
      keys.push(cur);
      const next = (by.get(cur) ?? []).find((k) => !used[k]);
      if (next === undefined) break;
      used[next] = 1;
      cur = segs[next][0] === cur ? segs[next][1] : segs[next][0];
    }
    if (keys.length >= 3) loops.push(keys.map((k) => pt.get(k)!));
  }
  return loops;
}

export function area(p: P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

/** Quita puntos que casi no cambian la forma (Douglas-Peucker), para un lazo cerrado */
export function simplify(loop: P2[], tol: number): P2[] {
  if (loop.length < 5) return loop;
  // partimos por el punto más lejano al primero: así el lazo son dos trozos abiertos
  let far = 0, fd = -1;
  loop.forEach((p, i) => { const d = Math.hypot(p[0] - loop[0][0], p[1] - loop[0][1]); if (d > fd) { fd = d; far = i; } });
  const dp = (pts: P2[]): P2[] => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-12;
    let k = 0, kd = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / l;
      if (d > kd) { kd = d; k = i; }
    }
    if (kd <= tol) return [a, b];
    return [...dp(pts.slice(0, k + 1)).slice(0, -1), ...dp(pts.slice(k))];
  };
  const one = dp(loop.slice(0, far + 1));
  const two = dp([...loop.slice(far), loop[0]]);
  const out = [...one.slice(0, -1), ...two.slice(0, -1)];
  return out.length >= 3 ? out : loop;
}

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** Piezas del logo: cada contorno de fuera con sus agujeros (una «O» = un aro, una isla dentro del agujero = otra pieza) */
export interface LogoPart { outer: P2[]; holes: P2[][] }

export function nest(loops: P2[][]): LogoPart[] {
  const info = loops.map((p) => ({ p, a: Math.abs(area(p)), depth: 0, parent: -1 }));
  info.forEach((x, i) => {
    let best = -1;
    info.forEach((y, k) => {
      if (k === i || y.a <= x.a || !inside(x.p[0], y.p)) return;
      x.depth++;
      if (best < 0 || y.a < info[best].a) best = k;
    });
    x.parent = best;
  });
  const parts: LogoPart[] = [];
  const idx = new Map<number, number>();
  info.forEach((x, i) => { if (x.depth % 2 === 0) { idx.set(i, parts.length); parts.push({ outer: x.p, holes: [] }); } });
  info.forEach((x) => { if (x.depth % 2 === 1 && idx.has(x.parent)) parts[idx.get(x.parent)!].holes.push(x.p); });
  return parts;
}

/**
 * Contornos del logo en mm, centrados en el origen, con Y hacia arriba.
 * «widthMm» es el ancho de la imagen entera; «threshold» de 0 a 100 (% de oscuridad).
 */
export function logoParts(img: Gray, opts: { detail: number; threshold: number; invert: boolean; widthMm: number }): LogoPart[] {
  const g = blur(darkGrid(img, opts.detail, opts.invert), 1);
  const mm = opts.widthMm / g.w;
  const minArea = 4; // en celdas: motas sueltas fuera
  const loops = contours(g, Math.min(0.99, Math.max(0.01, opts.threshold / 100)))
    .map((l) => simplify(l, 0.35))
    .filter((l) => l.length >= 3 && Math.abs(area(l)) >= minArea);
  const toMm = (p: P2): P2 => [(p[0] + 0.5 - g.w / 2) * mm, (g.h / 2 - p[1] - 0.5) * mm];
  // en mm (Y hacia arriba): el contorno de fuera en sentido antihorario y los agujeros al revés, como pide OpenCascade
  const orient = (l: P2[], ccw: boolean) => { const m = l.map(toMm); return (area(m) > 0) === ccw ? m : m.reverse(); };
  return nest(loops).map((pt) => ({ outer: orient(pt.outer, true), holes: pt.holes.map((h) => orient(h, false)) }));
}

/** Alturas del relieve en mm: base + oscuridad × alto, rejilla w × h (fila 0 = arriba) */
export function heightGrid(img: Gray, opts: { detail: number; invert: boolean; base: number; depth: number }) {
  const g = blur(darkGrid(img, opts.detail, opts.invert), 2);
  const z = new Float32Array(g.v.length);
  for (let k = 0; k < z.length; k++) z[k] = opts.base + g.v[k] * opts.depth;
  return { w: g.w, h: g.h, z };
}
