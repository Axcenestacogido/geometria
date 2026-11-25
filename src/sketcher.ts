// Editor de bocetos en 2D. Se dibuja sobre una hoja milimetrada (SVG).
// Las medidas se guardan como texto, así que pueden llevar variables.

import type { Profile, SegRef, SketchConstraint, SketchFeature } from "./types";
import { CONSTRAINT_GLYPH, CONSTRAINT_NAME, segOf, solveSketch, cleanConstraints } from "./constraints";
import { arcPoints, uid } from "./geom";
import { fmt } from "./expr";
import { filletAll, filletCorner, offsetPoly, removeSegment, type NP } from "./sketchops";

export type SketchTool = "select" | "poly" | "path" | "rect" | "circle" | "ngon";

type P2 = [number, number];

interface Callbacks {
  /** commit=false mientras se arrastra; true al soltar */
  onChange: (commit: boolean) => void;
  onSelect: (profileId: string | null, segment: number | null) => void;
  ev: (expr: string) => number;
}

export const TOOL_HINT: Record<SketchTool, string> = {
  select: "Clic para elegir un perfil o un tramo. Arrastra los puntos para moverlos. Doble clic en una cota para escribir la medida.",
  poly: "Clic para cada esquina. Clic en el primer punto (o Intro) para cerrar. Esc para cancelar.",
  path: "Línea abierta (camino para un barrido): clic para cada punto e Intro para terminar.",
  rect: "Clic en una esquina y clic en la opuesta.",
  circle: "Clic en el centro y clic para el radio.",
  ngon: "Clic en el centro y clic para el tamaño (polígono regular, 6 lados por defecto).",
};

export class SketchEditor {
  svg: SVGSVGElement;
  feature: SketchFeature | null = null;
  tool: SketchTool = "select";
  selected: string | null = null;
  selSeg: number | null = null;
  /** tramos elegidos para poner restricciones (Mayús+clic añade otro) */
  picks: SegRef[] = [];
  private center: P2 = [0, 0];
  private zoom = 4; // px por mm
  private draft: P2[] = [];
  private cursor: P2 | null = null;
  private drag:
    | { kind: "pan"; sx: number; sy: number; c: P2 }
    | { kind: "point"; pid: string; key: string; start: P2; moved: boolean }
    | { kind: "move"; pid: string; start: P2; orig: string; moved: boolean }
    | null = null;
  private editing: HTMLInputElement | null = null;
  snapOn = true;
  /** Aristas de la pieza vistas desde el plano del boceto: [x1,y1,x2,y2, …] */
  private refIn: number[] = [];
  private refOut: number[] = [];
  private refPts: P2[] = [];
  private pendingFit = false;
  /** pantalla táctil: puntos más grandes y más margen al tocar */
  readonly coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  /** dedos apoyados, para pellizcar (zoom) y mover con dos dedos */
  private touches = new Map<number, P2>();
  private pinch: { d0: number; z0: number; m0: P2; c0: P2 } | null = null;
  private draftAtTouch = 0;

  /** imagen de fondo del boceto (mm del boceto) */
  private image: { url: string; x: number; y: number; w: number; h: number; opacity: number } | null = null;
  setImage(im: { url: string; x: number; y: number; w: number; h: number; opacity: number } | null) {
    this.image = im;
    this.render();
  }

  /** Volver a encajar la vista cuando llegue la referencia (p. ej. tras cambiar de plano) */
  refitSoon() { this.pendingFit = true; }

  setReference(inPlane: number[], outPlane: number[]) {
    this.refIn = inPlane;
    this.refOut = outPlane;
    const pts: P2[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < inPlane.length; i += 2) {
      const k = `${inPlane[i].toFixed(3)},${inPlane[i + 1].toFixed(3)}`;
      if (!seen.has(k)) { seen.add(k); pts.push([inPlane[i], inPlane[i + 1]]); }
    }
    // solo los extremos (puntos que aparecen en un número impar de tramos o esquinas) serían ideales;
    // para no complicarlo, limitamos a 400 puntos de enganche
    this.refPts = pts.length > 400 ? [] : pts;
    if (this.pendingFit) { this.pendingFit = false; this.fitView(); }
    this.render();
  }

  constructor(private host: HTMLElement, private cb: Callbacks) {
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("sketch-svg");
    host.appendChild(this.svg);
    new ResizeObserver(() => this.render()).observe(host);
    this.svg.addEventListener("pointerdown", (e) => this.down(e));
    this.svg.addEventListener("pointermove", (e) => this.move(e));
    this.svg.addEventListener("pointerup", (e) => this.up(e));
    this.svg.addEventListener("pointercancel", (e) => { this.touches.delete(e.pointerId); if (!this.touches.size) this.pinch = null; this.drag = null; });
    this.svg.addEventListener("dblclick", (e) => this.dbl(e));
    this.svg.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.svg.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  open(f: SketchFeature) {
    const fresh = this.feature?.id !== f.id;
    this.feature = f;
    if (fresh) {
      this.selected = null;
      this.selSeg = null;
      this.picks = [];
      this.draft = [];
      this.refIn = []; this.refOut = []; this.refPts = [];
      this.pendingFit = true;
      this.fitView();
    }
    this.render();
  }

  close() {
    this.feature = null;
    this.draft = [];
    this.stopEditing();
  }

  setTool(t: SketchTool) {
    this.tool = t;
    this.draft = [];
    this.render();
  }

  // ---------- coordenadas ----------
  private get W() { return this.host.clientWidth || 1; }
  private get H() { return this.host.clientHeight || 1; }
  private toScreen = (p: P2): P2 => [this.W / 2 + (p[0] - this.center[0]) * this.zoom, this.H / 2 - (p[1] - this.center[1]) * this.zoom];
  private toModel(e: { clientX: number; clientY: number }): P2 {
    const r = this.svg.getBoundingClientRect();
    return [(e.clientX - r.left - this.W / 2) / this.zoom + this.center[0], -(e.clientY - r.top - this.H / 2) / this.zoom + this.center[1]];
  }
  private get step() {
    // paso de la rejilla según el zoom: 1, 5 o 10 mm…
    const target = 12 / this.zoom;
    for (const s of [0.5, 1, 2, 5, 10, 20, 50, 100]) if (s >= target) return s;
    return 200;
  }

  private snap(p: P2, e?: { shiftKey: boolean }): P2 {
    // 1) puntos existentes
    const tol = (this.coarse ? 14 : 8) / this.zoom;
    let best: P2 | null = null, bd = tol;
    for (const q of this.allPoints()) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) return best;
    if (!this.snapOn || e?.shiftKey) return p;
    const s = this.step / (this.step >= 5 ? 5 : 1);
    return [Math.round(p[0] / s) * s, Math.round(p[1] / s) * s];
  }

  private allPoints(): P2[] {
    const out: P2[] = [[0, 0]];
    for (const p of this.feature?.profiles ?? []) {
      if (this.drag && "pid" in this.drag && this.drag.pid === p.id) continue;
      const g = this.geo(p);
      if (g) out.push(...g.handles.map((h) => h.p));
    }
    out.push(...this.draft);
    out.push(...this.refPts);
    return out;
  }

  fitView() {
    const pts: P2[] = [];
    for (const p of this.feature?.profiles ?? []) {
      const g = this.geo(p);
      if (g) for (const l of g.loop) pts.push(l);
    }
    for (let i = 0; i < this.refIn.length; i += 2) pts.push([this.refIn[i], this.refIn[i + 1]]);
    for (let i = 0; i < this.refOut.length; i += 2) pts.push([this.refOut[i], this.refOut[i + 1]]);
    if (!pts.length) { this.center = [0, 0]; this.zoom = Math.min(this.W, this.H) / 120; return; }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    this.center = [(x0 + x1) / 2, (y0 + y1) / 2];
    this.zoom = Math.min(this.W / Math.max(x1 - x0, 10), this.H / Math.max(y1 - y0, 10)) * 0.7;
    this.render();
  }

  // ---------- geometría de cada perfil (en números) ----------
  private geo(p: Profile): { loop: P2[]; handles: { key: string; p: P2 }[]; dims: Dim[]; segs?: P2[][] } | null {
    const ev = this.cb.ev;
    try {
      if (p.kind === "rect") {
        const x = ev(p.x), y = ev(p.y), w = ev(p.w), h = ev(p.h);
        const c: P2[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        return {
          loop: [...c, c[0]],
          handles: c.map((q, i) => ({ key: `c${i}`, p: q })),
          dims: [
            { a: [x, Math.min(y, y + h)], b: [x + w, Math.min(y, y + h)], value: Math.abs(w), field: "w", side: -1 },
            { a: [Math.max(x, x + w), y], b: [Math.max(x, x + w), y + h], value: Math.abs(h), field: "h", side: 1 },
          ],
        };
      }
      if (p.kind === "circle" || p.kind === "ngon") {
        const cx = ev(p.cx), cy = ev(p.cy), r = ev(p.r);
        const n = p.kind === "ngon" ? Math.max(3, Math.round(ev(p.n))) : 72;
        const loop: P2[] = [];
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * Math.PI * 2 + (p.kind === "ngon" ? Math.PI / 2 : 0);
          loop.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
        }
        return {
          loop,
          handles: [{ key: "c", p: [cx, cy] }, { key: "r", p: [cx + r, cy] }],
          dims: [{ a: [cx - r, cy], b: [cx + r, cy], value: 2 * r, field: "r", side: 0, diameter: true }],
        };
      }
      if (p.kind === "poly") {
        const pts: P2[] = p.pts.map((q) => [ev(q.x), ev(q.y)]);
        const loop: P2[] = [];
        const segs: P2[][] = [];
        const dims: Dim[] = [];
        pts.forEach((a, i) => {
          if (p.open && i === pts.length - 1) return; // línea abierta: sin tramo de vuelta
          const b = pts[(i + 1) % pts.length];
          const s = ev(p.pts[i].s || "0");
          const seg = arcPoints(a, b, s);
          segs.push(seg);
          loop.push(...(i === 0 ? seg : seg.slice(1)));
          if (!s) dims.push({ a, b, value: Math.hypot(b[0] - a[0], b[1] - a[1]), field: `seg${i}`, side: 1 });
        });
        return { loop, handles: pts.map((q, i) => ({ key: `p${i}`, p: q })), dims, segs };
      }
    } catch {
      return null;
    }
    return null;
  }

  // ---------- dibujo ----------
  render() {
    if (!this.feature) { this.svg.innerHTML = ""; return; }
    const W = this.W, H = this.H;
    this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const out: string[] = [];
    // imagen de referencia, debajo de todo
    if (this.image) {
      const im = this.image;
      const [sx, sy] = this.toScreen([im.x, im.y + im.h]);
      out.push(`<image href="${im.url}" x="${sx}" y="${sy}" width="${im.w * this.zoom}" height="${im.h * this.zoom}" opacity="${im.opacity}" preserveAspectRatio="none" class="refimg"/>`);
    }
    // rejilla
    const st = this.step;
    const big = st * 5;
    const [mx0, my1] = [this.center[0] - W / 2 / this.zoom, this.center[1] + H / 2 / this.zoom];
    const [mx1, my0] = [this.center[0] + W / 2 / this.zoom, this.center[1] - H / 2 / this.zoom];
    const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
    for (let x = Math.ceil(mx0 / st) * st; x <= mx1; x += st) {
      const [sx] = this.toScreen([x, 0]);
      out.push(line(sx, 0, sx, H, Math.abs(x % big) < 1e-9 ? "g2" : "g1"));
    }
    for (let y = Math.ceil(my0 / st) * st; y <= my1; y += st) {
      const [, sy] = this.toScreen([0, y]);
      out.push(line(0, sy, W, sy, Math.abs(y % big) < 1e-9 ? "g2" : "g1"));
    }
    const [ox, oy] = this.toScreen([0, 0]);
    out.push(line(0, oy, W, oy, "ax-x"), line(ox, 0, ox, H, "ax-y"));
    out.push(`<text x="${W - 8}" y="${oy - 6}" class="ax-label" text-anchor="end">X</text><text x="${ox + 6}" y="14" class="ax-label">Y</text>`);

    // la pieza, vista desde el plano del boceto
    const segs = (arr: number[]) => {
      let d = "";
      for (let i = 0; i < arr.length; i += 4) {
        const [x1, y1] = this.toScreen([arr[i], arr[i + 1]]), [x2, y2] = this.toScreen([arr[i + 2], arr[i + 3]]);
        d += `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`;
      }
      return d;
    };
    if (this.refOut.length) out.push(`<path d="${segs(this.refOut)}" class="ref-out"/>`);
    if (this.refIn.length) out.push(`<path d="${segs(this.refIn)}" class="ref-in"/>`);

    // perfiles
    const path = (pts: P2[]) => pts.map((p, i) => `${i ? "L" : "M"}${this.toScreen(p).join(",")}`).join("") ;
    for (const p of this.feature.profiles) {
      const g = this.geo(p);
      if (!g) continue;
      const sel = p.id === this.selected;
      const open = p.kind === "poly" && p.open;
      out.push(`<path d="${path(g.loop)}${open ? "" : "Z"}" class="prof ${open ? "open" : ""} ${p.hole ? "hole" : ""} ${sel ? "sel" : ""}" data-pid="${p.id}"/>`);
      if (g.segs) g.segs.forEach((s, i) => {
        const picked = this.picks.some((r) => r.p === p.id && r.i === i);
        out.push(`<path d="${path(s)}" class="seg ${picked ? "segsel" : ""}" data-pid="${p.id}" data-seg="${i}"/>`);
      });
      // cotas: siempre en el elegido; en los demás solo si el dibujo es sencillo (un SVG importado tendría cientos)
      if (sel || (this.feature.profiles.length < 12 && g.dims.length <= 16)) for (const d of g.dims) out.push(this.dimSvg(d, p.id, sel));
      if (sel) for (const h of g.handles) {
        const [x, y] = this.toScreen(h.p);
        const hs = this.coarse ? 9 : 5;
        out.push(`<rect x="${x - hs}" y="${y - hs}" width="${hs * 2}" height="${hs * 2}" class="handle" data-pid="${p.id}" data-h="${h.key}"/>`);
      }
    }
    // restricciones: un símbolo junto a cada tramo (clic para quitarla)
    for (const c of this.feature.constraints ?? []) {
      for (const r of "t" in c ? [c.s, c.t] : [c.s]) {
        const sg = segOf(this.feature, r);
        if (!sg) continue;
        const [pp, ia, ib] = sg;
        let a: P2, b: P2;
        try { a = [this.cb.ev(pp.pts[ia].x), this.cb.ev(pp.pts[ia].y)]; b = [this.cb.ev(pp.pts[ib].x), this.cb.ev(pp.pts[ib].y)]; } catch { continue; }
        const [ax, ay] = this.toScreen(a), [bx, by] = this.toScreen(b);
        const L = Math.hypot(bx - ax, by - ay) || 1;
        // al otro lado de la cota, y un poco desplazado si hay varias en el mismo tramo
        const nth = (this.feature.constraints ?? []).filter((o) => ("t" in o ? [o.s, o.t] : [o.s]).some((q) => q.p === r.p && q.i === r.i)).indexOf(c);
        const gx = (ax + bx) / 2 + ((by - ay) / L) * 14 + nth * 16, gy = (ay + by) / 2 - ((bx - ax) / L) * 14;
        out.push(`<g class="cons" data-cons="${c.id}"><title>${CONSTRAINT_NAME[c.kind]} (clic para quitarla)</title><rect x="${gx - 8}" y="${gy - 8}" width="16" height="16" rx="4" data-cons="${c.id}"/><text x="${gx}" y="${gy + 4}" text-anchor="middle" data-cons="${c.id}">${CONSTRAINT_GLYPH[c.kind]}</text></g>`);
      }
    }
    // borrador
    if (this.draft.length && this.cursor) {
      const c = this.cursor;
      if (this.tool === "poly" || this.tool === "path") {
        out.push(`<path d="${path([...this.draft, c])}" class="draft"/>`);
        const a = this.draft[this.draft.length - 1];
        out.push(this.dimSvg({ a, b: c, value: Math.hypot(c[0] - a[0], c[1] - a[1]), field: "", side: 1 }, "", false));
        const [fx, fy] = this.toScreen(this.draft[0]);
        if (this.tool === "poly") out.push(`<circle cx="${fx}" cy="${fy}" r="7" class="close-hint"/>`);
      } else if (this.tool === "rect") {
        const a = this.draft[0];
        out.push(`<path d="${path([a, [c[0], a[1]], c, [a[0], c[1]], a])}" class="draft"/>`);
        out.push(this.dimSvg({ a: [a[0], Math.min(a[1], c[1])], b: [c[0], Math.min(a[1], c[1])], value: Math.abs(c[0] - a[0]), field: "", side: -1 }, "", false));
        out.push(this.dimSvg({ a: [Math.max(a[0], c[0]), a[1]], b: [Math.max(a[0], c[0]), c[1]], value: Math.abs(c[1] - a[1]), field: "", side: 1 }, "", false));
      } else {
        const a = this.draft[0];
        const r = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const [sx, sy] = this.toScreen(a);
        if (this.tool === "circle") out.push(`<circle cx="${sx}" cy="${sy}" r="${r * this.zoom}" class="draft"/>`);
        else {
          const pts: P2[] = [];
          for (let i = 0; i <= 6; i++) { const t = (i / 6) * Math.PI * 2 + Math.PI / 2; pts.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]); }
          out.push(`<path d="${path(pts)}" class="draft"/>`);
        }
        out.push(this.dimSvg({ a, b: c, value: r, field: "", side: 1, label: "R" }, "", false));
      }
    }
    if (this.cursor && this.tool !== "select") {
      const [x, y] = this.toScreen(this.cursor);
      out.push(`<circle cx="${x}" cy="${y}" r="3.5" class="cursor"/>`);
      out.push(`<text x="${x + 10}" y="${y - 10}" class="coord">${fmt(this.cursor[0])}, ${fmt(this.cursor[1])}</text>`);
    }
    this.svg.innerHTML = out.join("");
  }

  private dimSvg(d: Dim, pid: string, sel: boolean) {
    const [ax, ay] = this.toScreen(d.a), [bx, by] = this.toScreen(d.b);
    const dx = bx - ax, dy = by - ay;
    const L = Math.hypot(dx, dy);
    if (L < 18) return "";
    const nx = -dy / L, ny = dx / L;
    const off = d.side * 18;
    const [p1x, p1y, p2x, p2y] = [ax + nx * off, ay + ny * off, bx + nx * off, by + ny * off];
    const tx = (p1x + p2x) / 2 + nx * (d.side ? 10 * Math.sign(d.side) : -8), ty = (p1y + p2y) / 2 + ny * (d.side ? 10 * Math.sign(d.side) : -8);
    const tyFix = d.diameter ? -16 : 0;
    const txt = `${d.diameter ? "Ø" : d.label ? d.label + " " : ""}${fmt(d.value)}`;
    const ext = d.side ? `<line x1="${ax}" y1="${ay}" x2="${p1x}" y2="${p1y}" class="dimext"/><line x1="${bx}" y1="${by}" x2="${p2x}" y2="${p2y}" class="dimext"/>` : "";
    const editable = pid && d.field ? `data-pid="${pid}" data-dim="${d.field}"` : "";
    return `${ext}<line x1="${p1x}" y1="${p1y}" x2="${p2x}" y2="${p2y}" class="dim ${sel ? "dimsel" : ""}"/>` +
      `<text x="${tx}" y="${ty + 4 + tyFix}" class="dimtxt ${editable ? "editable" : ""}" text-anchor="middle" ${editable}>${txt}</text>`;
  }

  // ---------- ratón ----------
  /** Dos dedos: pellizcar para el zoom y arrastrar para mover la vista */
  private touchDown(e: PointerEvent): boolean {
    if (e.pointerType !== "touch") return false;
    this.touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (this.touches.size === 1) this.draftAtTouch = this.draft.length;
    if (this.touches.size !== 2) return this.touches.size > 2;
    // el segundo dedo cancela lo que hiciera el primero (también el punto que acababa de poner)
    this.drag = null;
    this.draft.length = Math.min(this.draft.length, this.draftAtTouch);
    const [a, b] = [...this.touches.values()];
    this.pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z0: this.zoom, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], c0: [...this.center] };
    try { this.svg.setPointerCapture(e.pointerId); } catch { /* el dedo ya se levantó */ }
    return true;
  }

  private touchMove(e: PointerEvent): boolean {
    if (e.pointerType !== "touch" || !this.touches.has(e.pointerId)) return false;
    this.touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (!this.pinch || this.touches.size < 2) return false;
    const [a, b] = [...this.touches.values()];
    const p = this.pinch;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const r = this.svg.getBoundingClientRect();
    // el punto del dibujo que estaba bajo el centro de los dedos se queda bajo ellos
    const under: P2 = [(p.m0[0] - r.left - this.W / 2) / p.z0 + p.c0[0], -(p.m0[1] - r.top - this.H / 2) / p.z0 + p.c0[1]];
    this.zoom = Math.max(0.05, Math.min(400, p.z0 * (d / p.d0)));
    this.center = [under[0] - (mid[0] - r.left - this.W / 2) / this.zoom, under[1] + (mid[1] - r.top - this.H / 2) / this.zoom];
    this.render();
    return true;
  }

  private touchUp(e: PointerEvent): boolean {
    if (e.pointerType !== "touch") return false;
    this.touches.delete(e.pointerId);
    if (this.pinch) {
      if (this.touches.size === 0) this.pinch = null;
      return true;
    }
    return false;
  }

  private down(e: PointerEvent) {
    if (!this.feature) return;
    if (this.touchDown(e)) return;
    this.stopEditing();
    const t = e.target as Element;
    // capturar el puntero solo si vamos a arrastrar algo (para no estropear el doble clic)
    if (e.button !== 0 || e.altKey || (this.tool === "select" && t.hasAttribute("data-pid") && !t.hasAttribute("data-dim"))) {
      this.svg.setPointerCapture(e.pointerId);
    }
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, c: [...this.center] };
      return;
    }
    if (e.button !== 0) return;
    const m = this.snap(this.toModel(e), e);
    if (this.tool === "select") {
      const consId = t.getAttribute("data-cons");
      if (consId) {
        this.feature.constraints = (this.feature.constraints ?? []).filter((c) => c.id !== consId);
        if (!this.feature.constraints.length) delete this.feature.constraints;
        this.cb.onChange(true);
        this.render();
        return;
      }
      const pid = t.getAttribute("data-pid");
      const h = t.getAttribute("data-h");
      const seg = t.getAttribute("data-seg");
      if (pid && h) {
        this.drag = { kind: "point", pid, key: h, start: m, moved: false };
        return;
      }
      if (pid && !t.hasAttribute("data-dim")) {
        this.selected = pid;
        this.selSeg = seg !== null ? Number(seg) : null;
        if (seg !== null) {
          const r = { p: pid, i: Number(seg) };
          const has = this.picks.findIndex((q) => q.p === r.p && q.i === r.i);
          // con el dedo no hay Mayús: tocar otro tramo lo añade, y tocar el mismo lo quita
          const touchAdd = e.pointerType === "touch" && this.picks.length > 0;
          if (e.shiftKey || touchAdd) { if (has >= 0) this.picks.splice(has, 1); else this.picks = [...this.picks.slice(-1), r]; }
          else this.picks = [r];
        } else if (!e.shiftKey) this.picks = [];
        const prof = this.feature.profiles.find((p) => p.id === pid)!;
        this.drag = { kind: "move", pid, start: m, orig: JSON.stringify(prof), moved: false };
        this.cb.onSelect(pid, this.selSeg);
        this.render();
        return;
      }
      if (!pid) {
        this.selected = null;
        this.selSeg = null;
        this.picks = [];
        this.cb.onSelect(null, null);
        this.render();
      }
      return;
    }
    // herramientas de dibujo
    const f = this.feature;
    if (this.tool === "poly" || this.tool === "path") {
      if (this.tool === "poly" && this.draft.length >= 3 && samePt(m, this.draft[0])) return this.finishPoly();
      if (this.draft.length && samePt(m, this.draft[this.draft.length - 1])) return;
      this.draft.push(m);
    } else if (!this.draft.length) {
      this.draft = [m];
    } else {
      const a = this.draft[0];
      const id = uid();
      if (this.tool === "rect") {
        if (Math.abs(m[0] - a[0]) < 1e-6 || Math.abs(m[1] - a[1]) < 1e-6) return;
        f.profiles.push({ id, kind: "rect", hole: false, x: fmt(Math.min(a[0], m[0])), y: fmt(Math.min(a[1], m[1])), w: fmt(Math.abs(m[0] - a[0])), h: fmt(Math.abs(m[1] - a[1])), r: "0" });
      } else {
        const r = Math.hypot(m[0] - a[0], m[1] - a[1]);
        if (r < 1e-6) return;
        if (this.tool === "circle") f.profiles.push({ id, kind: "circle", hole: false, cx: fmt(a[0]), cy: fmt(a[1]), r: fmt(r) });
        else f.profiles.push({ id, kind: "ngon", hole: false, cx: fmt(a[0]), cy: fmt(a[1]), r: fmt(r), n: "6" });
      }
      this.autoHole(f.profiles[f.profiles.length - 1]);
      this.draft = [];
      this.selected = id;
      this.cb.onSelect(id, null);
      this.cb.onChange(true);
    }
    this.render();
  }

  /** Si un perfil nuevo queda dentro de otro, lo marcamos como agujero */
  private autoHole(p: Profile) {
    if (p.kind === "poly" && p.open) return;
    const g = this.geo(p);
    if (!g || !this.feature) return;
    for (const o of this.feature.profiles) {
      if (o.id === p.id || o.hole) continue;
      const og = this.geo(o);
      if (og && g.loop.every((q) => inside(q, og.loop))) { p.hole = true; return; }
    }
  }

  finishPoly() {
    const open = this.tool === "path";
    if (!this.feature || this.draft.length < (open ? 2 : 3)) return;
    const id = uid();
    const prof: Profile = { id, kind: "poly", hole: false, pts: this.draft.map((p) => ({ x: fmt(p[0]), y: fmt(p[1]) })), ...(open ? { open: true } : {}) };
    this.feature.profiles.push(prof);
    this.autoHole(prof);
    this.draft = [];
    this.selected = id;
    this.cb.onSelect(id, null);
    this.cb.onChange(true);
    this.render();
  }

  cancel() {
    if (this.draft.length) { this.draft = []; this.render(); return true; }
    if (this.tool !== "select") { this.setTool("select"); return true; }
    return false;
  }

  /** Añade una restricción a los tramos elegidos y mueve los puntos para cumplirla */
  addConstraint(kind: SketchConstraint["kind"]): string | null {
    if (!this.feature) return null;
    const [s, t] = this.picks;
    if (!s || ((kind === "h" || kind === "v") ? this.picks.length !== 1 : !t)) return "elige los tramos primero";
    const id = uid();
    const c: SketchConstraint = kind === "h" || kind === "v" ? { id, kind, s } : { id, kind, s, t };
    (this.feature.constraints ??= []).push(c);
    // el primer punto del primer tramo se queda quieto, para que la figura no se desplace
    const ok = solveSketch(this.feature, this.cb.ev, new Set([`${s.p}:${s.i}`]));
    if (!ok) {
      this.feature.constraints = this.feature.constraints.filter((x) => x.id !== id);
      solveSketch(this.feature, this.cb.ev);
      this.render();
      return "no se puede: choca con otra restricción o con una medida escrita con variables";
    }
    this.cb.onChange(true);
    this.render();
    return null;
  }

  // ---------- redondear, desfase, quitar tramo ----------
  private numPts(p: Extract<Profile, { kind: "poly" }>): NP[] {
    const ev = this.cb.ev;
    return p.pts.map((q) => ({ x: ev(q.x), y: ev(q.y), s: q.s ? ev(q.s) : 0 }));
  }
  private setPts(p: Extract<Profile, { kind: "poly" }>, pts: NP[]) {
    p.pts = pts.map((q) => (Math.abs(q.s) > 1e-9 ? { x: fmt(q.x), y: fmt(q.y), s: fmt(q.s) } : { x: fmt(q.x), y: fmt(q.y) }));
    // los números de tramo cambian: fuera las restricciones de este contorno
    if (this.feature?.constraints) {
      this.feature.constraints = this.feature.constraints.filter((c) => c.s.p !== p.id && (!("t" in c) || c.t.p !== p.id));
      if (!this.feature.constraints.length) delete this.feature.constraints;
    }
  }
  private commit() {
    this.picks = [];
    this.selSeg = null;
    this.cb.onChange(true);
    this.render();
  }

  /** Redondea: la esquina entre los dos tramos elegidos, o todas las del contorno elegido. Devuelve un aviso o null. */
  filletSelection(r: number): string | null {
    const f = this.feature;
    if (!f) return null;
    if (!(r > 0)) return "el radio tiene que ser mayor que 0";
    try {
      if (this.picks.length === 2 && this.picks[0].p === this.picks[1].p) {
        const p = f.profiles.find((q) => q.id === this.picks[0].p);
        if (p?.kind !== "poly") return "elige tramos de unas líneas";
        const n = p.pts.length, [a, b] = [this.picks[0].i, this.picks[1].i];
        const corner = (a + 1) % n === b ? b : (b + 1) % n === a ? a : -1;
        if (corner < 0) return "los dos tramos tienen que tocarse";
        this.setPts(p, filletCorner(this.numPts(p), corner, r, !p.open));
        this.commit();
        return null;
      }
      const p = f.profiles.find((q) => q.id === this.selected);
      if (!p) return "elige un contorno, o dos tramos que se toquen";
      if (p.kind === "rect") { p.r = fmt(r); this.commit(); return null; }
      if (p.kind !== "poly") return "los círculos y polígonos no tienen esquinas que redondear";
      const { pts, done } = filletAll(this.numPts(p), r, !p.open);
      if (!done) return "ninguna esquina admite ese radio";
      this.setPts(p, pts);
      this.commit();
      return null;
    } catch (e) { return (e as Error).message; }
  }

  /** Copia paralela del contorno elegido, a distancia d (positiva = hacia fuera) */
  offsetSelected(d: number): string | null {
    const f = this.feature;
    const p = f?.profiles.find((q) => q.id === this.selected);
    if (!f || !p) return "elige primero un contorno";
    if (!d) return "pon una distancia distinta de 0";
    const ev = this.cb.ev;
    const id = uid();
    let np: Profile;
    try {
      if (p.kind === "circle") {
        const r = ev(p.r) + d;
        if (r <= 0) return "el círculo desaparecería";
        np = { ...p, id, r: fmt(r) };
      } else if (p.kind === "rect") {
        const w = ev(p.w) + 2 * d, hh = ev(p.h) + 2 * d;
        if (w <= 0 || hh <= 0) return "el rectángulo desaparecería";
        const r0 = ev(p.r);
        np = { ...p, id, x: fmt(ev(p.x) - d), y: fmt(ev(p.y) - d), w: fmt(w), h: fmt(hh), r: fmt(r0 > 0 ? Math.max(0, r0 + d) : 0) };
      } else if (p.kind === "ngon") {
        const n = Math.round(ev(p.n)), r = ev(p.r) + d / Math.cos(Math.PI / n);
        if (r <= 0) return "el polígono desaparecería";
        np = { ...p, id, r: fmt(r) };
      } else {
        const q: Profile = { ...p, id, pts: [] };
        this.setPts(q as Extract<Profile, { kind: "poly" }>, offsetPoly(this.numPts(p), d, !p.open));
        np = q;
      }
    } catch (e) { return (e as Error).message; }
    f.profiles.push(np);
    this.selected = id;
    this.cb.onSelect(id, null);
    this.commit();
    return null;
  }

  /** Quita el tramo elegido de unas líneas (un contorno cerrado pasa a línea abierta) */
  removeSelectedSegment(): string | null {
    const f = this.feature;
    const r = this.picks[0] ?? (this.selected && this.selSeg !== null ? { p: this.selected, i: this.selSeg } : null);
    if (!f || !r) return "elige primero un tramo";
    const p = f.profiles.find((q) => q.id === r.p);
    if (p?.kind !== "poly") return "solo se quitan tramos de unas líneas";
    const parts = removeSegment(this.numPts(p), r.i, !p.open);
    const idx = f.profiles.indexOf(p);
    const made: Profile[] = parts.map((pts, k) => {
      const q = { ...p, id: k === 0 ? p.id : uid(), open: true, pts: [] } as Extract<Profile, { kind: "poly" }>;
      this.setPts(q, pts);
      return q;
    });
    f.profiles.splice(idx, 1, ...made);
    if (!made.length) { this.selected = null; this.cb.onSelect(null, null); }
    this.commit();
    return null;
  }

  deleteSelected() {
    if (!this.feature || !this.selected) return false;
    this.feature.profiles = this.feature.profiles.filter((p) => p.id !== this.selected);
    cleanConstraints(this.feature);
    this.picks = [];
    this.selected = null;
    this.cb.onSelect(null, null);
    this.cb.onChange(true);
    this.render();
    return true;
  }

  private move(e: PointerEvent) {
    if (!this.feature) return;
    if (this.touchMove(e) || this.pinch) return;
    if (this.drag?.kind === "pan") {
      this.center = [this.drag.c[0] - (e.clientX - this.drag.sx) / this.zoom, this.drag.c[1] + (e.clientY - this.drag.sy) / this.zoom];
      this.render();
      return;
    }
    const m = this.snap(this.toModel(e), e);
    this.cursor = m;
    if (this.drag?.kind === "point") {
      const p = this.feature.profiles.find((q) => q.id === (this.drag as { pid: string }).pid);
      if (p) {
        this.movePoint(p, this.drag.key, m);
        if (p.kind === "poly") solveSketch(this.feature, this.cb.ev, new Set([`${p.id}:${this.drag.key.slice(1)}`]));
        this.drag.moved = true;
        this.cb.onChange(false);
      }
    } else if (this.drag?.kind === "move") {
      const d = this.drag;
      const dx = m[0] - d.start[0], dy = m[1] - d.start[1];
      if (!d.moved && Math.hypot(dx, dy) * this.zoom < 4) { this.render(); return; }
      const orig = JSON.parse(d.orig) as Profile;
      const idx = this.feature.profiles.findIndex((q) => q.id === d.pid);
      this.feature.profiles[idx] = this.translated(orig, dx, dy);
      const moved = this.feature.profiles[idx];
      if (moved.kind === "poly") solveSketch(this.feature, this.cb.ev, new Set(moved.pts.map((_, i) => `${moved.id}:${i}`)));
      d.moved = true;
      this.cb.onChange(false);
    }
    this.render();
  }

  private up(e: PointerEvent) {
    if (this.touchUp(e)) return;
    const d = this.drag;
    this.drag = null;
    if (d && d.kind !== "pan" && d.moved) this.cb.onChange(true);
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const before = this.toModel(e);
    const k = Math.exp(-e.deltaY * 0.0015);
    this.zoom = Math.max(0.05, Math.min(400, this.zoom * k));
    const after = this.toModel(e);
    this.center = [this.center[0] + before[0] - after[0], this.center[1] + before[1] - after[1]];
    this.render();
  }

  private movePoint(p: Profile, key: string, m: P2) {
    const ev = this.cb.ev;
    if (p.kind === "poly") {
      const i = Number(key.slice(1));
      p.pts[i] = { ...p.pts[i], x: fmt(m[0]), y: fmt(m[1]) };
    } else if (p.kind === "rect") {
      const x = ev(p.x), y = ev(p.y), w = ev(p.w), h = ev(p.h);
      const c: P2[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const i = Number(key.slice(1));
      const opp = c[(i + 2) % 4];
      p.x = fmt(Math.min(opp[0], m[0])); p.y = fmt(Math.min(opp[1], m[1]));
      p.w = fmt(Math.abs(m[0] - opp[0])); p.h = fmt(Math.abs(m[1] - opp[1]));
    } else {
      if (key === "c") { p.cx = fmt(m[0]); p.cy = fmt(m[1]); }
      else p.r = fmt(Math.max(0.01, Math.hypot(m[0] - ev(p.cx), m[1] - ev(p.cy))));
    }
  }

  private translated(p: Profile, dx: number, dy: number): Profile {
    const sh = (e: string, d: number) => (d ? fmt(this.cb.ev(e) + d) : e);
    if (p.kind === "poly") return { ...p, pts: p.pts.map((q) => ({ ...q, x: sh(q.x, dx), y: sh(q.y, dy) })) };
    if (p.kind === "rect") return { ...p, x: sh(p.x, dx), y: sh(p.y, dy) };
    return { ...p, cx: sh(p.cx, dx), cy: sh(p.cy, dy) };
  }

  // ---------- escribir una cota ----------
  private dbl(e: MouseEvent) {
    // con la captura del puntero, e.target puede ser el SVG entero: miramos qué hay debajo
    const t = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as Element;
    const pid = t.getAttribute("data-pid"), field = t.getAttribute("data-dim");
    if (!pid || !field || !this.feature) return;
    const p = this.feature.profiles.find((q) => q.id === pid);
    if (!p) return;
    const r = (t as SVGGraphicsElement).getBoundingClientRect();
    const hostR = this.host.getBoundingClientRect();
    const input = document.createElement("input");
    input.className = "dim-input";
    let cur = "";
    if (p.kind === "rect" && (field === "w" || field === "h")) cur = p[field];
    else if ((p.kind === "circle" || p.kind === "ngon") && field === "r") cur = fmt(2 * this.cb.ev(p.r));
    else if (p.kind === "poly") {
      const g = this.geo(p)!;
      cur = fmt(g.dims.find((d) => d.field === field)!.value);
    }
    input.value = cur;
    input.style.left = `${r.left - hostR.left + r.width / 2 - 45}px`;
    input.style.top = `${r.top - hostR.top - 4}px`;
    this.host.appendChild(input);
    input.focus();
    input.select();
    this.editing = input;
    const apply = () => {
      const v = input.value.trim();
      this.stopEditing();
      if (!v || v === cur) return;
      let num: number;
      try { num = this.cb.ev(v); } catch { return; }
      if (p.kind === "rect" && (field === "w" || field === "h")) {
        p[field] = v;
      } else if (p.kind === "circle" || p.kind === "ngon") {
        p.r = /^[\d.,\s]+$/.test(v) ? fmt(num / 2) : `(${v})/2`;
      } else if (p.kind === "poly") {
        const i = Number(field.slice(3));
        this.setSegLength(p, i, num);
        solveSketch(this.feature!, this.cb.ev, new Set([`${p.id}:${i}`, `${p.id}:${(i + 1) % p.pts.length}`]));
      }
      this.cb.onChange(true);
      this.render();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") apply();
      if (ev.key === "Escape") this.stopEditing();
      ev.stopPropagation();
    });
    input.addEventListener("blur", apply);
  }

  /** Cambia la longitud de un tramo moviendo su punto final (y los siguientes, sin tocar el primero). */
  private setSegLength(p: Extract<Profile, { kind: "poly" }>, i: number, L: number) {
    const ev = this.cb.ev;
    const n = p.pts.length;
    const j = (i + 1) % n;
    const a: P2 = [ev(p.pts[i].x), ev(p.pts[i].y)], b: P2 = [ev(p.pts[j].x), ev(p.pts[j].y)];
    const cur = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (cur < 1e-9 || L <= 0) return;
    const dx = ((b[0] - a[0]) / cur) * L - (b[0] - a[0]), dy = ((b[1] - a[1]) / cur) * L - (b[1] - a[1]);
    // mueve los puntos desde j hasta antes del 0 (si j == 0 solo se mueve ese)
    const last = j === 0 ? 0 : n - 1;
    for (let k = j; ; k++) {
      p.pts[k] = { ...p.pts[k], x: fmt(ev(p.pts[k].x) + dx), y: fmt(ev(p.pts[k].y) + dy) };
      if (k >= last) break;
    }
  }

  stopEditing() {
    const el = this.editing;
    this.editing = null;
    el?.remove();
  }
}

interface Dim { a: P2; b: P2; value: number; field: string; side: number; diameter?: boolean; label?: string }

const samePt = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

function inside(p: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
