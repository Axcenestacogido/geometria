// DXF (R12, texto) para corte láser, CNC o para abrir el 2D en Rhino/AutoCAD/LibreCAD.
// Unidades: milímetros, escala 1:1, Y hacia arriba. Cálculo puro, sin DOM.
import { svgArcCenter, type P2 } from "./drawdims.ts";

export interface DxfLayer { name: string; color: number }

export class Dxf {
  private ents: string[] = [];
  private layers = new Map<string, number>();

  layer(name: string, color = 7) { this.layers.set(name, color); return this; }

  line(a: P2, b: P2, layer = "0") {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return;
    this.ents.push(`0\nLINE\n8\n${layer}\n10\n${n(a[0])}\n20\n${n(a[1])}\n30\n0\n11\n${n(b[0])}\n21\n${n(b[1])}\n31\n0`);
  }
  circle(c: P2, r: number, layer = "0") {
    this.ents.push(`0\nCIRCLE\n8\n${layer}\n10\n${n(c[0])}\n20\n${n(c[1])}\n30\n0\n40\n${n(r)}`);
  }
  /** arco en sentido antihorario de «a0» a «a1» (grados) */
  arc(c: P2, r: number, a0: number, a1: number, layer = "0") {
    this.ents.push(`0\nARC\n8\n${layer}\n10\n${n(c[0])}\n20\n${n(c[1])}\n30\n0\n40\n${n(r)}\n50\n${n(a0)}\n51\n${n(a1)}`);
  }
  polyline(pts: P2[], layer = "0") {
    for (let i = 0; i + 1 < pts.length; i++) this.line(pts[i], pts[i + 1], layer);
  }

  get count() { return this.ents.length; }

  toString(): string {
    const lay = [...this.layers].map(([name, color]) => `0\nLAYER\n2\n${name}\n70\n0\n62\n${color}\n6\nCONTINUOUS`).join("\n");
    return [
      "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n0\nENDSEC",
      `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${this.layers.size}${lay ? "\n" + lay : ""}\n0\nENDTAB\n0\nENDSEC`,
      `0\nSECTION\n2\nENTITIES${this.ents.length ? "\n" + this.ents.join("\n") : ""}\n0\nENDSEC`,
      "0\nEOF",
    ].join("\n") + "\n";
  }
}

const n = (v: number) => String(Math.round(v * 10000) / 10000);
const deg = (a: number) => ((a * 180) / Math.PI + 360) % 360;

/**
 * Pasa trazos SVG (M, L, Q, C, A, Z; Y hacia abajo, como los del plano) al DXF, moviéndolos
 * «off» y dando la vuelta a la Y. Las curvas Bézier van en tramos rectos; los arcos, como arcos.
 */
export function addSvgPaths(dxf: Dxf, paths: string[], layer: string, off: P2 = [0, 0]) {
  const T = (p: P2): P2 => [p[0] + off[0], -p[1] + off[1]];
  for (const d of paths) {
    const tk = d.trim().split(/[\s,]+/);
    let i = 0, cur: P2 = [0, 0], start: P2 = [0, 0];
    const num = () => Number(tk[i++]);
    while (i < tk.length) {
      const cmd = tk[i++];
      if (cmd === "M") { cur = [num(), num()]; start = cur; }
      else if (cmd === "L") { const p: P2 = [num(), num()]; dxf.line(T(cur), T(p), layer); cur = p; }
      else if (cmd === "Q" || cmd === "C") {
        const c1: P2 = [num(), num()];
        const c2: P2 = cmd === "C" ? [num(), num()] : c1;
        const p: P2 = [num(), num()];
        const pts: P2[] = [];
        for (let k = 0; k <= 16; k++) {
          const t = k / 16, u = 1 - t;
          pts.push(cmd === "Q"
            ? [u * u * cur[0] + 2 * u * t * c1[0] + t * t * p[0], u * u * cur[1] + 2 * u * t * c1[1] + t * t * p[1]]
            : [u ** 3 * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p[0], u ** 3 * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p[1]]);
        }
        dxf.polyline(pts.map(T), layer);
        cur = p;
      } else if (cmd === "A") {
        const rx = num(), ry = num(); i++; const large = tk[i++] === "1", sweep = tk[i++] === "1";
        const p: P2 = [num(), num()];
        if (Math.abs(rx - ry) < 1e-6 * Math.max(1, rx)) {
          const { c } = svgArcCenter(cur, p, rx, large, sweep);
          const C = T(c), A = T(cur), B = T(p);
          const a0 = deg(Math.atan2(A[1] - C[1], A[0] - C[0])), a1 = deg(Math.atan2(B[1] - C[1], B[0] - C[0]));
          // con la Y dada la vuelta, «sweep» del SVG es el sentido horario: el DXF siempre va antihorario
          if (sweep) dxf.arc(C, rx, a1, a0, layer); else dxf.arc(C, rx, a0, a1, layer);
        } else dxf.line(T(cur), T(p), layer); // elipse: no debería salir en un plano de piezas
        cur = p;
      } else if (cmd === "Z" || cmd === "z") { dxf.line(T(cur), T(start), layer); cur = start; }
      else break;
    }
  }
}
