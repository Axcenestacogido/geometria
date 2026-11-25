// Importar un dibujo SVG (de Inkscape, Illustrator, Figma…) como perfiles de un boceto.
// Se leen solo las formas (path, rect, circle, ellipse, polygon, polyline) y sus
// transformaciones; nada del archivo se ejecuta ni se mete en la página.
// Las curvas se convierten en polilíneas finas.

import type { Profile } from "./types";
import { uid } from "./geom";
import { fmt } from "./expr";

type P2 = [number, number];
/** matriz afín [a b c d e f] como en SVG: x' = a x + c y + e, y' = b x + d y + f */
type M = [number, number, number, number, number, number];

const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, p: P2): P2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

function parseTransform(t: string | null): M {
  let m = I;
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const v = (r[2].match(/-?[\d.]+(?:e-?\d+)?/gi) ?? []).map(Number);
    let n: M = I;
    switch (r[1]) {
      case "matrix": if (v.length === 6) n = v as M; break;
      case "translate": n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case "scale": n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        n = [c, s, -s, c, 0, 0];
        if (v.length === 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      }
      case "skewX": n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

/** Convierte el atributo d de un <path> en una lista de contornos (puntos en unidades del SVG) */
export function pathToLoops(d: string, curveSteps = 16): P2[][] {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const loops: P2[][] = [];
  let cur: P2[] = [];
  let i = 0, cmd = "";
  let p: P2 = [0, 0], start: P2 = [0, 0], lastCtrl: P2 | null = null, lastCmd = "";
  const num = () => Number(toks[i++]);
  const flush = () => { if (cur.length >= 3) loops.push(cur); cur = []; };
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const pt = (): P2 => { const x = num(), y = num(); return rel ? [p[0] + x, p[1] + y] : [x, y]; };
    switch (C) {
      case "M": {
        flush();
        p = pt(); start = p; cur = [p];
        cmd = rel ? "l" : "L"; // los siguientes pares son líneas
        break;
      }
      case "L": p = pt(); cur.push(p); break;
      case "H": { const x = num(); p = [rel ? p[0] + x : x, p[1]]; cur.push(p); break; }
      case "V": { const y = num(); p = [p[0], rel ? p[1] + y : y]; cur.push(p); break; }
      case "C": case "S": {
        let c1: P2;
        if (C === "C") c1 = pt();
        else c1 = lastCtrl && (lastCmd === "C" || lastCmd === "S") ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p;
        const c2 = pt(), e = pt();
        for (let k = 1; k <= curveSteps; k++) {
          const t = k / curveSteps, u = 1 - t;
          cur.push([
            u * u * u * p[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0],
            u * u * u * p[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1],
          ]);
        }
        lastCtrl = c2; p = e;
        break;
      }
      case "Q": case "T": {
        let c: P2;
        if (C === "Q") c = pt();
        else c = lastCtrl && (lastCmd === "Q" || lastCmd === "T") ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p;
        const e = pt();
        for (let k = 1; k <= curveSteps; k++) {
          const t = k / curveSteps, u = 1 - t;
          cur.push([u * u * p[0] + 2 * u * t * c[0] + t * t * e[0], u * u * p[1] + 2 * u * t * c[1] + t * t * e[1]]);
        }
        lastCtrl = c; p = e;
        break;
      }
      case "A": {
        const rx0 = Math.abs(num()), ry0 = Math.abs(num()), rot = num(), large = num(), sweep = num();
        const e = pt();
        cur.push(...arcPts(p, e, rx0, ry0, rot, !!large, !!sweep, curveSteps * 2));
        p = e;
        break;
      }
      case "Z": flush(); p = start; break;
      default: i++; // orden desconocida: la saltamos
    }
    lastCmd = C;
    if (C !== "C" && C !== "S" && C !== "Q" && C !== "T") lastCtrl = null;
    // si tras una orden vienen más números, el bucle repite la misma orden
  }
  flush();
  return loops;
}

/** Puntos de un arco elíptico SVG (sin incluir el inicial) */
function arcPts(a: P2, b: P2, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, steps: number): P2[] {
  if (!rx || !ry) return [b];
  const phi = (rotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (a[0] - b[0]) / 2, dy = (a[1] - b[1]) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cp * cx1 - sp * cy1 + (a[0] + b[0]) / 2, cy = sp * cx1 + cp * cy1 + (a[1] + b[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((steps * Math.abs(dt)) / Math.PI));
  const out: P2[] = [];
  for (let k = 1; k <= n; k++) {
    const t = t1 + (dt * k) / n;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    out.push([cp * x - sp * y + cx, sp * x + cp * y + cy]);
  }
  return out;
}

function ellipseLoop(cx: number, cy: number, rx: number, ry: number, n = 72): P2[] {
  const out: P2[] = [];
  for (let k = 0; k < n; k++) { const t = (k / n) * 2 * Math.PI; out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
  return out;
}

/** Simplifica una polilínea quitando puntos que casi no cambian la forma */
function simplify(pts: P2[], tol: number): P2[] {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bd = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1e-12;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, k) => keep[k]);
}

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, "": 25.4 / 96 };

function lengthMM(v: string | null): number | null {
  const m = v?.trim().match(/^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/);
  return m ? Number(m[1]) * UNIT_MM[m[2] ?? ""] : null;
}

function inside(p: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export interface SvgShapes {
  /** contornos ya en mm, con Y hacia arriba */
  loops: P2[][];
  width: number;
  height: number;
}

/** Lee el SVG y devuelve sus contornos en mm (tamaño real del dibujo) */
export function readSvg(text: string): SvgShapes {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) throw new Error("no es un SVG válido");
  // escala de unidades del SVG a mm
  const vb = root.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const wmm = lengthMM(root.getAttribute("width"));
  let k = UNIT_MM.px;
  if (vb && vb.length === 4 && vb[2] > 0 && wmm) k = wmm / vb[2];
  else if (vb && vb.length === 4 && !wmm) k = 1; // sin tamaño declarado: 1 unidad = 1 mm
  const loops: P2[][] = [];
  const walk = (el: Element, m: M) => {
    const tag = el.localName;
    if (["defs", "clipPath", "mask", "symbol", "marker", "pattern", "style", "script", "metadata", "title", "desc", "text", "foreignObject"].includes(tag)) return;
    if (el.getAttribute("display") === "none") return;
    const mm = el === root ? m : mul(m, parseTransform(el.getAttribute("transform")));
    const n = (a: string) => Number(el.getAttribute(a) ?? 0) || 0;
    let local: P2[][] = [];
    switch (tag) {
      case "path": local = pathToLoops(el.getAttribute("d") ?? ""); break;
      case "rect": {
        const x = n("x"), y = n("y"), w = n("width"), h = n("height");
        if (w > 0 && h > 0) {
          const rx = Math.min(n("rx") || n("ry"), w / 2), ry = Math.min(n("ry") || n("rx"), h / 2);
          if (rx > 0) {
            const d = `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
            local = pathToLoops(d);
          } else local = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
        }
        break;
      }
      case "circle": if (n("r") > 0) local = [ellipseLoop(n("cx"), n("cy"), n("r"), n("r"))]; break;
      case "ellipse": if (n("rx") > 0 && n("ry") > 0) local = [ellipseLoop(n("cx"), n("cy"), n("rx"), n("ry"))]; break;
      case "polygon": case "polyline": {
        const v = (el.getAttribute("points")?.match(/-?[\d.]+(?:e-?\d+)?/gi) ?? []).map(Number);
        const pts: P2[] = [];
        for (let q = 0; q + 1 < v.length; q += 2) pts.push([v[q], v[q + 1]]);
        if (pts.length >= 3) local = [pts];
        break;
      }
    }
    for (const l of local) loops.push(l.map((q) => { const [x, y] = apply(mm, q); return [x * k, -y * k] as P2; }));
    for (const c of Array.from(el.children)) walk(c, mm);
  };
  walk(root, I);
  // quitar el punto final repetido
  for (const l of loops) {
    const a = l[0], b = l[l.length - 1];
    if (l.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) l.pop();
  }
  const good = loops.filter((l) => l.length >= 3);
  if (!good.length) throw new Error("el SVG no tiene formas cerradas que se puedan usar");
  const xs = good.flat().map((p) => p[0]), ys = good.flat().map((p) => p[1]);
  return { loops: good, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Escala el dibujo al ancho pedido, lo centra en el origen y lo convierte en perfiles */
export function svgToProfiles(s: SvgShapes, width: number): { profiles: Profile[]; points: number } {
  const f = s.width > 0 ? width / s.width : 1;
  const xs = s.loops.flat().map((p) => p[0]), ys = s.loops.flat().map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const loops = s.loops
    .map((l) => simplify(l.map(([x, y]) => [(x - cx) * f, (y - cy) * f] as P2), 0.02))
    .filter((l) => l.length >= 3);
  let points = 0;
  const profiles: Profile[] = loops.map((l, i) => {
    // agujero = dentro de un número impar de otros contornos
    const depth = loops.filter((o, j) => j !== i && inside(l[0], o)).length;
    points += l.length;
    return { id: uid(), kind: "poly", hole: depth % 2 === 1, pts: l.map(([x, y]) => ({ x: fmt(x), y: fmt(y) })) };
  });
  return { profiles, points };
}
