/// <reference lib="webworker" />
// Motor geométrico. Corre en segundo plano para no congelar la pantalla.
// Usa OpenCascade (el mismo núcleo que FreeCAD) a través de replicad.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as R from "replicad";
import { planeBasis, scale as vscale, smoothSegs, type Basis } from "./geom";
import { buildModel3mf } from "./threemf";
import { SCREWS } from "./screws";
import { gearOutline } from "./gear";
import { catalogPart, hexagon, type CatalogPart } from "./catalog";
import { logoParts, heightGrid, type Gray, type P2 } from "./relief";
/** pasos cuyo sólido conviene dibujar con menos detalle */
const coarseIds = new Set<string>();
import type { Feature, Resolved, WorkerIn, WorkerOut, BodyMesh, Vec3, BuildResult, TextFont, DrawingView, Clash, ComparePart } from "./types";
import interRegular from "./fonts/Inter-Regular.otf?url";
import interBold from "./fonts/Inter-Bold.otf?url";
import monoBold from "./fonts/JetBrainsMono-Bold.ttf?url";

type RF = Resolved<Feature>;
type RSketch = Extract<RF, { type: "sketch" }>;
type Shape = R.Shape3D;

const post = (m: WorkerOut, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(m, transfer);

let ready = false;
const queue: WorkerIn[] = [];

opencascade({ locateFile: () => wasmUrl })
  .then((oc: unknown) => {
    R.setOC(oc as never);
    ready = true;
    post({ kind: "ready" });
    pump();
  })
  .catch((e: Error) => post({ kind: "fatal", message: String(e?.message ?? e) }));

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  if (m.kind === "file") { loadFile(m); return; }
  if (m.kind === "gray") { grays.set(m.id, { w: m.w, h: m.h, data: m.data }); rerunLast(); return; }
  if (m.kind === "build") {
    // solo importa la última petición de reconstrucción
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === "build") queue.splice(i, 1);
  }
  queue.push(m);
  pump();
};

let busy = false;
function pump() {
  if (!ready || busy) return;
  busy = true;
  try {
    while (queue.length) {
      const m = queue.shift()!;
      if (m.kind === "build") doBuild(m);
      else if (m.kind === "export") doExport(m);
      else if (m.kind === "drawing") doDrawing(m);
      else if (m.kind === "collide") doCollide(m);
      else if (m.kind === "compare") doCompare(m);
    }
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------
// Cosas que llegan tarde (tipografías, archivos importados): cuando están listas
// se olvida lo calculado y se repite la última reconstrucción.

let lastBuild: Extract<WorkerIn, { kind: "build" }> | null = null;
function rerunLast() {
  stepCache = [];
  if (lastBuild && !queue.some((q) => q.kind === "build")) queue.push(lastBuild);
  pump();
}

const FONT_URL: Record<TextFont, string> = { sans: interRegular, "sans-bold": interBold, mono: monoBold };
const fontState = new Map<TextFont, "loading" | "ok" | string>();
/** true si la tipografía ya está cargada; si no, la pide y avisa al terminar */
function fontReady(font: TextFont): boolean {
  const st = fontState.get(font);
  if (st === "ok") return true;
  if (st && st !== "loading") throw new Error("no se pudo cargar la tipografía: " + st);
  if (!st) {
    fontState.set(font, "loading");
    fetch(FONT_URL[font])
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => R.loadFont(buf, font))
      .then(() => fontState.set(font, "ok"))
      .catch((e) => fontState.set(font, String(e?.message ?? e)))
      .finally(rerunLast);
  }
  return false;
}

/** Imágenes en grises para los relieves, por id de archivo */
const grays = new Map<string, Gray>();

/** Lo más fino que dejamos pedir: más puntos tardan demasiado */
const MAX_LOGO = 400, MAX_RELIEF = 160;

function reliefShape(f: Extract<RF, { type: "relief" }>): Shape {
  if (!f.file) throw new Error("elige una imagen");
  const img = grays.get(f.file);
  if (!img) throw new Error("leyendo la imagen…");
  if (!(f.width > 0)) throw new Error("el ancho tiene que ser mayor que 0");
  if (!(f.height > 0)) throw new Error(f.mode === "logo" ? "el alto tiene que ser mayor que 0" : "el relieve tiene que ser mayor que 0");
  const max = f.mode === "logo" ? MAX_LOGO : MAX_RELIEF;
  if (!(f.detail >= 10) || f.detail > max) throw new Error(`el detalle tiene que ir de 10 a ${max}`);
  const W = f.width, H = W * (img.h / img.w);
  // al grabar, el logo se hunde desde Z hacia abajo
  const engrave = f.op === "cut";
  if (f.mode === "logo") {
    if (f.threshold <= 0 || f.threshold >= 100) throw new Error("el umbral va de 1 a 99 %");
    const parts = logoParts(img, { detail: f.detail, threshold: f.threshold, invert: f.invert, widthMm: W });
    if (!parts.length) throw new Error("no sale ningún contorno: prueba a mover el umbral o «Invertir»");
    const wire = (pts: P2[]) => R.makePolygon(pts.map(([x, y]) => [x, y, 0] as Vec3)).outerWire();
    const solids: Shape[] = [];
    for (const p of parts) {
      try {
        const face = R.makeFace(wire(p.outer), p.holes.map(wire));
        solids.push(R.basicFaceExtrusion(face, new R.Vector([0, 0, f.height])) as unknown as Shape);
      } catch { /* un contorno raro (se cruza consigo mismo): fuera */ }
    }
    if (!solids.length) throw new Error("no se pudo hacer ningún contorno");
    const all = solids.length === 1 ? solids[0] : (R.makeCompound(solids) as unknown as Shape);
    return all.translate(f.x, f.y, f.z - (engrave ? f.height : 0)) as Shape;
  }
  // relieve: superficie suave que pasa por las alturas, cortada en una placa
  if (f.base < 0) throw new Error("la base no puede ser negativa");
  if (!engrave && f.base < 0.2) throw new Error("pon al menos 0,2 mm de base para que sea una sola pieza");
  // al grabar, lo oscuro va más hondo
  const g = heightGrid(img, { detail: f.detail, invert: engrave ? !f.invert : f.invert, base: engrave ? 0 : f.base, depth: f.height });
  const oc = R.getOC() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const dx = W / (g.w - 1), dy = H / (g.h - 1);
  const arr = new oc.NCollection_Array2_double(1, g.w + 2, 1, g.h + 2);
  // un borde extra a cada lado (valor repetido) para que el recorte no caiga justo en el borde de la superficie
  // la fila 0 de la imagen es la de arriba: Y más grande
  for (let i = 0; i < g.w + 2; i++) for (let j = 0; j < g.h + 2; j++) {
    const ii = Math.min(g.w - 1, Math.max(0, i - 1)), jj = Math.min(g.h - 1, Math.max(0, j - 1));
    arr.SetValue(i + 1, j + 1, g.z[(g.h - 1 - jj) * g.w + ii]);
  }
  const b = new oc.GeomAPI_PointsToBSplineSurface();
  b.Init(arr, -dx, dx, -dy, dy, 3, 3, oc.GeomAbs_Shape.GeomAbs_C2, 0.1);
  if (!b.IsDone()) throw new Error("no se pudo hacer la superficie (prueba con menos detalle)");
  const face = new oc.BRepBuilderAPI_MakeFace(b.Surface(), 1e-6).Face();
  const top = (engrave ? 0 : f.base) + f.height;
  const prism = new oc.BRepPrimAPI_MakePrism(face, new oc.gp_Vec(0, 0, -(top + 5)), false, true).Shape();
  let sh = (R.cast(prism) as Shape).intersect(R.makeBox([0, 0, 0], [W, H, top + 1]) as Shape) as Shape;
  // grabado: lo que queda por encima de la superficie es lo que se quita
  if (engrave) sh = (R.makeBox([0, 0, 0], [W, H, f.height]) as Shape).cut(sh) as Shape;
  sh = sh.translate(f.x - W / 2, f.y - H / 2, f.z - (engrave ? f.height : 0)) as Shape;
  for (const o of [b, arr]) o.delete(); // la superficie la guarda la cara; el prisma lo guarda replicad
  return sh;
}

/** Piezas importadas, ya convertidas a sólido, por id de archivo */
const imported = new Map<string, { shape?: Shape; error?: string }>();
const MAX_STL_TRIANGLES = 60000;

async function loadFile(m: Extract<WorkerIn, { kind: "file" }>) {
  if (imported.has(m.id)) return;
  imported.set(m.id, {});
  const until = () => new Promise<void>((res) => { const t = () => (ready ? res() : setTimeout(t, 100)); t(); });
  await until();
  try {
    let shape: Shape;
    let triangles: number | undefined;
    if (m.format === "step") {
      shape = (await R.importSTEP(new Blob([m.data]))) as Shape;
    } else {
      const tris = parseSTL(m.data);
      triangles = tris.length / 9;
      if (triangles > MAX_STL_TRIANGLES) throw new Error(`tiene ${triangles} triángulos; el máximo es ${MAX_STL_TRIANGLES}. Simplifícalo antes (por ejemplo en Bambu Studio o Blender)`);
      const faces: R.Face[] = [];
      for (let i = 0; i < tris.length; i += 9) {
        const a: Vec3 = [tris[i], tris[i + 1], tris[i + 2]], b: Vec3 = [tris[i + 3], tris[i + 4], tris[i + 5]], c: Vec3 = [tris[i + 6], tris[i + 7], tris[i + 8]];
        // triángulos degenerados (sin área) se saltan
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
        if (cr < 1e-10) continue;
        try { faces.push(R.makePolygon([a, b, c])); } catch { /* triángulo raro: fuera */ }
      }
      if (!faces.length) throw new Error("el STL no tiene triángulos");
      shape = R.makeSolid(faces) as unknown as Shape;
    }
    imported.set(m.id, { shape });
    post({ kind: "file", id: m.id, triangles });
  } catch (e) {
    const error = msg(e);
    imported.set(m.id, { error });
    post({ kind: "file", id: m.id, error });
  }
  rerunLast();
}

/** Lee un STL (binario o de texto) y devuelve los vértices de cada triángulo seguidos */
function parseSTL(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
      return out;
    }
  }
  const txt = new TextDecoder().decode(buf);
  const nums: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(txt))) nums.push(Number(mm[1]), Number(mm[2]), Number(mm[3]));
  if (nums.some((x) => !Number.isFinite(x))) throw new Error("el STL tiene números que no se entienden");
  return new Float32Array(nums.slice(0, nums.length - (nums.length % 9)));
}

// ---------------------------------------------------------------

interface Body { id: string; name: string; shape: Shape; /** tiene roscas: se dibuja con menos detalle */ coarse?: boolean }

function sketchBasis(s: RSketch): Basis {
  return planeBasis(s.plane as never);
}

function makePlane(b: Basis) {
  return new R.Plane(b.origin, b.x, b.n);
}

function profileDrawing(p: RSketch["profiles"][number]): R.Drawing {
  switch (p.kind) {
    case "rect": {
      const w = Math.abs(p.w), h = Math.abs(p.h);
      if (w < 1e-6 || h < 1e-6) throw new Error("rectángulo sin tamaño");
      const r = Math.min(Math.max(p.r || 0, 0), w / 2 - 1e-4, h / 2 - 1e-4);
      const d = r > 1e-4 ? R.drawRoundedRectangle(w, h, r) : R.drawRectangle(w, h);
      return d.translate(Math.min(p.x, p.x + p.w) + w / 2, Math.min(p.y, p.y + p.h) + h / 2);
    }
    case "circle":
      if (p.r <= 0) throw new Error("círculo con radio 0");
      return R.drawCircle(p.r).translate(p.cx, p.cy);
    case "ngon": {
      const n = Math.round(p.n);
      if (n < 3) throw new Error("un polígono necesita 3 lados o más");
      if (p.r <= 0) throw new Error("polígono con radio 0");
      return R.drawPolysides(p.r, n).translate(p.cx, p.cy);
    }
    case "poly": {
      const pts = p.pts;
      if (p.open) throw new Error("una línea abierta no encierra nada: úsala como camino de un barrido");
      if (pts.length < 3) throw new Error("un perfil cerrado necesita 3 puntos o más");
      if (p.smooth) return smoothPen(pts, true).close();
      let pen = R.draw([pts[0].x, pts[0].y]);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const s = a.s || 0;
        const last = i === pts.length - 1;
        if (last && !s) break; // close() hace el último tramo recto
        if (Math.abs(s) > 1e-6) pen = pen.sagittaArcTo([b.x, b.y], s);
        else pen = pen.lineTo([b.x, b.y]);
      }
      return pen.close();
    }
  }
}

/** Curva suave por todos los puntos (tramos de Bézier cúbica) */
function smoothPen(pts: { x: number; y: number }[], closed: boolean) {
  const segs = smoothSegs(pts.map((q) => [q.x, q.y] as [number, number]), closed);
  let pen = R.draw(segs[0][0]);
  for (const [, c1, c2, b] of segs) pen = pen.cubicBezierCurveTo(b, c1, c2);
  return pen;
}

/** El camino de un barrido: la primera línea abierta del boceto, o si no hay, su primer contorno */
function pathDrawing(s: RSketch): R.Drawing {
  const p = s.profiles.find((x) => x.kind === "poly" && x.open) ?? s.profiles[0];
  if (!p) throw new Error("el boceto del camino está vacío");
  if (p.kind !== "poly" || !p.open) return profileDrawing(p);
  if (p.pts.length < 2) throw new Error("el camino necesita 2 puntos o más");
  if (p.smooth) return smoothPen(p.pts, false).done();
  let pen = R.draw([p.pts[0].x, p.pts[0].y]);
  for (let i = 0; i < p.pts.length - 1; i++) {
    const a = p.pts[i], b = p.pts[i + 1];
    if (Math.abs(a.s || 0) > 1e-6) pen = pen.sagittaArcTo([b.x, b.y], a.s!);
    else pen = pen.lineTo([b.x, b.y]);
  }
  return pen.done();
}

function sketchDrawing(s: RSketch): R.Drawing {
  const closed = s.profiles.filter((p) => !(p.kind === "poly" && p.open));
  const solids = closed.filter((p) => !p.hole);
  const holes = closed.filter((p) => p.hole);
  if (!solids.length) throw new Error("el boceto no tiene ningún perfil (que no sea agujero)");
  let d: R.Drawing | null = null;
  for (const p of solids) {
    const pd = profileDrawing(p);
    d = d ? d.fuse(pd) : pd;
  }
  for (const p of holes) d = d!.cut(profileDrawing(p));
  return d!;
}

function sketchSolidSource(s: RSketch) {
  const basis = sketchBasis(s);
  const drawing = sketchDrawing(s);
  return { basis, sketch: () => drawing.sketchOnPlane(makePlane(basis)) as R.Sketch | R.Sketches };
}

function combine(bodies: Body[], f: RF & { op: string; target?: string }, shape: Shape, label: string) {
  if (f.op === "new" || !bodies.length) {
    if (f.op === "cut" || f.op === "intersect") throw new Error("no hay ningún cuerpo al que restar o intersecar");
    bodies.push({ id: f.id, name: label, shape });
    return;
  }
  const idx = f.target ? bodies.findIndex((b) => b.id === f.target) : bodies.length - 1;
  if (idx < 0) throw new Error("el cuerpo objetivo ya no existe");
  const b = bodies[idx];
  let out: Shape;
  if (f.op === "add") out = b.shape.fuse(shape);
  else if (f.op === "cut") out = b.shape.cut(shape);
  else out = b.shape.intersect(shape);
  bodies[idx] = { ...b, shape: out };
}

/** ¿Se solapan dos sólidos? (volumen de la intersección > 0) */
function touches(a: Shape, b: Shape) {
  try {
    return R.measureVolume(a.intersect(b)) > 1e-6;
  } catch {
    return true;
  }
}

function edgeDistance(edge: R.Edge, p: Vec3) {
  let best = Infinity;
  const N = 32;
  let prev: Vec3 | null = null;
  for (let i = 0; i <= N; i++) {
    const v = edge.pointAt(i / N);
    const q: Vec3 = [v.x, v.y, v.z];
    v.delete?.();
    if (prev) best = Math.min(best, segDist(p, prev, q));
    prev = q;
  }
  return best;
}

function segDist(p: Vec3, a: Vec3, b: Vec3) {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = L ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

const EDGE_TOL = 0.6; // mm

function applyEdgeOp(bodies: Body[], f: Extract<RF, { type: "fillet" | "chamfer" }>) {
  const faces = f.faces ?? [];
  if (!f.edges.length && !faces.length) throw new Error("elige aristas (o caras) en la vista 3D");
  if (f.size <= 0) throw new Error("la medida debe ser mayor que 0");
  const sizes = f.sizes ?? [];
  if (sizes.some((x) => x < 0)) throw new Error("las medidas deben ser mayores que 0");
  const lost: string[] = [];
  const picks = f.edges.map(() => ({ body: -1, edge: -1, d: Infinity }));
  bodies.forEach((b, bi) => {
    b.shape.edges.forEach((e, ei) => {
      f.edges.forEach((p, pi) => {
        const d = edgeDistance(e, p as Vec3);
        if (d < picks[pi].d) picks[pi] = { body: bi, edge: ei, d };
      });
    });
  });
  picks.forEach((k, i) => { if (k.d > EDGE_TOL) lost.push(`arista ${i + 1}`); });
  // medida de cada arista, por cuerpo: índice de arista → medida
  const perBody = bodies.map(() => new Map<number, number>());
  // primero las caras (todas sus aristas con la medida general)…
  faces.forEach((p, fi) => {
    let best: { bi: number; face: R.Face; d: number } | null = null;
    bodies.forEach((b, bi) => {
      const nf = nearestFace(b.shape, p as Vec3);
      if (nf && (!best || nf.d < best.d)) best = { bi, face: nf.face, d: nf.d };
    });
    const bf = best as { bi: number; face: R.Face; d: number } | null;
    if (!bf || bf.d > EDGE_TOL) { lost.push(`cara ${fi + 1}`); return; }
    const all = bodies[bf.bi].shape.edges;
    for (const fe of bf.face.edges) {
      const ei = all.findIndex((e) => e.isSame(fe));
      if (ei >= 0) perBody[bf.bi].set(ei, f.size);
    }
  });
  // …y luego las aristas sueltas, que pueden llevar su propia medida
  picks.forEach((k, i) => {
    if (k.d <= EDGE_TOL) perBody[k.body].set(k.edge, sizes[i] > 0 ? sizes[i] : f.size);
  });
  if (perBody.every((m) => !m.size)) throw new Error("no encuentro las aristas elegidas (¿cambió mucho la pieza?)");
  bodies.forEach((b, bi) => {
    const mine = perBody[bi];
    if (!mine.size) return;
    const list = b.shape.edges.map((e, ei) => ({ e, r: mine.get(ei) })).filter((x) => x.r !== undefined) as { e: R.Edge; r: number }[];
    const radius = (edge: R.Edge) => list.find((x) => x.e.isSame(edge))?.r ?? null;
    b.shape = f.type === "fillet" ? b.shape.fillet(radius) : b.shape.chamfer(radius);
  });
  if (lost.length) return `no encontré: ${lost.join(", ")}`;
  return null;
}

function nearestFace(shape: Shape, p: Vec3) {
  const v = R.makeVertex(p);
  let best: { face: R.Face; d: number } | null = null;
  for (const face of shape.faces) {
    const d = R.measureDistanceBetween(face, v);
    if (!best || d < best.d) best = { face, d };
  }
  return best;
}

function applyShell(bodies: Body[], f: Extract<RF, { type: "shell" }>) {
  if (!f.faces.length) throw new Error("elige en la vista 3D la cara (o caras) que quedan abiertas");
  if (f.thickness <= 0) throw new Error("el grosor debe ser mayor que 0");
  const byBody = new Map<number, R.Face[]>();
  for (const p of f.faces) {
    let pick: { bi: number; face: R.Face; d: number } | null = null;
    bodies.forEach((b, bi) => {
      const n = nearestFace(b.shape, p as Vec3);
      if (n && (!pick || n.d < pick.d)) pick = { bi, face: n.face, d: n.d };
    });
    const k = pick as { bi: number; face: R.Face; d: number } | null;
    if (!k || k.d > 0.6) throw new Error("no encuentro una de las caras elegidas (¿cambió mucho la pieza?)");
    byBody.set(k.bi, [...(byBody.get(k.bi) ?? []), k.face]);
  }
  for (const [bi, faces] of byBody) {
    const b = bodies[bi];
    b.shape = b.shape.shell(f.thickness, (finder: R.FaceFinder) => finder.when(({ element }) => faces.some((x) => x.isSame(element))));
  }
}

/** Empuja (o hunde) una cara plana: extruye la cara y la suma o la resta de su cuerpo */
function pushPull(bodies: Body[], f: Extract<RF, { type: "pushpull" }>) {
  if (!f.face) throw new Error("haz clic en la cara plana que quieres empujar");
  if (!f.distance) throw new Error("la distancia no puede ser 0");
  let pick: { bi: number; face: R.Face; d: number } | null = null;
  bodies.forEach((b, bi) => {
    const n = nearestFace(b.shape, f.face as Vec3);
    if (n && (!pick || n.d < pick.d)) pick = { bi, face: n.face, d: n.d };
  });
  const k = pick as { bi: number; face: R.Face; d: number } | null;
  if (!k || k.d > EDGE_TOL) throw new Error("no encuentro esa cara: puede que un paso anterior la haya cambiado");
  if (k.face.geomType !== "PLANE") throw new Error("solo se pueden empujar caras planas");
  const nv = k.face.normalAt();
  let n: Vec3 = [nv.x, nv.y, nv.z];
  // la normal de OpenCascade puede venir al revés: manda la que se vio en pantalla (hacia fuera)
  if (n[0] * f.normal[0] + n[1] * f.normal[1] + n[2] * f.normal[2] < 0) n = [-n[0], -n[1], -n[2]];
  const b = bodies[k.bi];
  const tool = R.basicFaceExtrusion(k.face, new R.Vector(vscale(n, f.distance))) as unknown as Shape;
  b.shape = (f.distance > 0 ? b.shape.fuse(tool) : b.shape.cut(tool)) as Shape;
}

/** Gira una pieza construida a lo largo de +Z para que apunte en `dir` y la lleva a `at` */
function placeAlong(shape: Shape, dir: Vec3, at: Vec3): Shape {
  const z: Vec3 = [0, 0, 1];
  const d = norm3(dir);
  const c = d[2];
  let out = shape;
  if (c < -0.999999) out = out.rotate(180, [0, 0, 0], [1, 0, 0]);
  else if (c < 0.999999) {
    const axis: Vec3 = [z[1] * d[2] - z[2] * d[1], z[2] * d[0] - z[0] * d[2], z[0] * d[1] - z[1] * d[0]];
    out = out.rotate((Math.acos(c) * 180) / Math.PI, [0, 0, 0], axis);
  }
  return out.translate(at);
}

const norm3 = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Sólido de revolución alrededor de Z a partir de puntos (radio, z) */
function revolveProfile(pts: [number, number][]): Shape {
  let pen = R.draw(pts[0]);
  for (const q of pts.slice(1)) pen = pen.lineTo(q);
  return (pen.close().sketchOnPlane("XZ") as R.Sketch).revolve([0, 0, 1]) as Shape;
}

/**
 * Tornillo de diámetro D, paso P y largo L, a lo largo de +Z desde z=0 (rosca a derechas).
 * Se hace con una "extrusión retorcida" de la sección del tornillo: es mucho más fiable
 * que barrer un triángulo por una hélice.
 */
const screwCache = new Map<string, Shape>();
function makeScrew(D: number, P: number, L: number): Shape {
  const key = `${D}|${P}|${L}`;
  const hit = screwCache.get(key);
  if (hit) return hit.clone() as Shape;
  const out = buildScrew(D, P, L);
  if (screwCache.size > 20) screwCache.clear();
  screwCache.set(key, out);
  return out.clone() as Shape;
}

function buildScrew(D: number, P: number, L: number): Shape {
  const H = 0.866 * P;
  const rMin = D / 2 - 0.625 * H, rMaj = D / 2;
  // radio según la posición a lo largo del eje dentro de un paso (perfil ISO simplificado)
  const tooth = (t: number) => {
    const u = (((t % P) + P) % P) / P;
    if (u < 0.0625 || u > 0.9375) return rMin;
    if (u > 0.4375 && u < 0.5625) return rMaj;
    if (u < 0.5) return rMin + ((rMaj - rMin) * (u - 0.0625)) / 0.375;
    return rMaj - ((rMaj - rMin) * (u - 0.5625)) / 0.375;
  };
  // 48 tramos rectos por vuelta: suficiente para imprimir y la mitad de rápido que 96
  const N = 48;
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N;
    const r = tooth((th / (2 * Math.PI)) * P);
    pts.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  let pen = R.draw(pts[0]);
  for (const q of pts.slice(1)) pen = pen.lineTo(q);
  // Sin recorte final: cualquier operación booleana extra con la superficie retorcida
  // cuesta varios segundos. Los extremos ya salen planos.
  return (pen.close().sketchOnPlane("XY") as R.Sketch).extrude(L, { twistAngle: (360 * L) / P }) as Shape;
}

/** Gira todos los cuerpos para que la cara elegida (o la plana más grande) quede abajo, en Z = 0 */
function layFlat(bodies: Body[], p: Vec3 | null) {
  if (!bodies.length) throw new Error("primero crea un sólido");
  let face: R.Face | null = null;
  if (p) {
    let best = Infinity;
    for (const b of bodies) {
      const nf = nearestFace(b.shape, p);
      if (nf && nf.d < best) { best = nf.d; face = nf.face; }
    }
    if (!face || best > EDGE_TOL) throw new Error("no encuentro la cara elegida");
    if (face.geomType !== "PLANE") throw new Error("elige una cara plana");
  } else {
    let best = 0;
    for (const b of bodies) for (const fc of b.shape.faces) {
      if (fc.geomType !== "PLANE") continue;
      const a = R.measureArea(fc);
      if (a > best) { best = a; face = fc; }
    }
    if (!face) throw new Error("la pieza no tiene caras planas: elige una a mano");
  }
  const nv = face.normalAt();
  const n: Vec3 = [nv.x, nv.y, nv.z];
  // girar para que la normal (hacia fuera) apunte hacia abajo (-Z)
  const c = -n[2];
  let axis: Vec3 = [n[1], -n[0], 0]; // n × (0,0,-1)
  let ang = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  if (Math.hypot(...axis) < 1e-9) axis = [1, 0, 0];
  const rot = (sh: Shape) => (ang > 1e-6 ? (sh.rotate(ang, [0, 0, 0], axis) as Shape) : sh);
  const turned = bodies.map((b) => rot(b.shape));
  // bajar a Z = 0 y centrar en X e Y
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const sh of turned) {
    const [a, b] = sh.boundingBox.bounds;
    mn = mn.map((v, i) => Math.min(v, a[i])); mx = mx.map((v, i) => Math.max(v, b[i]));
  }
  const t: Vec3 = [-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2]];
  bodies.forEach((b, i) => { b.shape = turned[i].translate(...t) as Shape; });
  ang = 0;
}

/** Calcula una pieza guardada (sus pasos ya con números) y la junta en un solo sólido */
const compCache = new Map<string, Shape>();
function componentShape(features: RF[], name: string): Shape {
  if (!features?.length) throw new Error("elige una pieza guardada");
  const key = JSON.stringify(features);
  const hit = compCache.get(key);
  if (hit) return hit.clone() as Shape;
  // la pieza se calcula aparte, sin tocar la memoria de pasos de esta
  const saved = stepCache;
  stepCache = [];
  let res: ReturnType<typeof runFeatures>;
  try { res = runFeatures(features); } finally { stepCache = saved; }
  const errs = Object.values(res.errors);
  if (!res.bodies.length) throw new Error(`la pieza «${name}» no tiene sólidos${errs.length ? ": " + errs[0] : ""}`);
  let out = res.bodies[0].shape;
  for (const b of res.bodies.slice(1)) out = out.fuse(b.shape);
  if (compCache.size > 10) compCache.clear();
  compCache.set(key, out);
  return out.clone() as Shape;
}

/** Texto 3D colocado sobre una cara (o en el suelo si no hay punto) */
function textSolid(f: Extract<RF, { type: "text" }>): Shape {
  let d = R.drawText(f.text, { fontSize: f.size, fontFamily: f.font });
  // centrar el texto en el punto elegido
  const [[x0, y0], [x1, y1]] = d.boundingBox.bounds;
  d = d.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  if (f.angle) d = d.rotate(f.angle, [0, 0]);
  const p = f.points[f.points.length - 1];
  const at: Vec3 = p ? [p.x, p.y, p.z] : [0, 0, 0];
  const n: Vec3 = p ? (p.n as Vec3) : [0, 0, 1];
  // dirección de lectura: horizontal en las paredes, X en el suelo o el techo
  let xd: Vec3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [-n[1], n[0], 0];
  const L = Math.hypot(...xd);
  xd = [xd[0] / L, xd[1] / L, xd[2] / L];
  // relieve: empieza un poco dentro para que se una; grabado: entra `depth` y sobresale un poco
  const start = f.op === "cut" ? -f.depth : f.op === "add" ? -0.2 : 0;
  const len = f.op === "cut" ? f.depth + 0.3 : f.op === "add" ? f.depth + 0.2 : f.depth;
  const origin: Vec3 = [at[0] + n[0] * start, at[1] + n[1] * start, at[2] + n[2] * start];
  const sk = d.sketchOnPlane(new R.Plane(origin, xd, n) as never);
  return (sk as R.Sketch).extrude(len) as Shape;
}

/** Cilindro de la cara que hay en p (eje y radio), o null si esa cara no es cilíndrica */
function cylinderAt(shape: Shape, p: Vec3): { o: Vec3; a: Vec3; r: number } | null {
  const near = nearestFace(shape, p);
  if (!near || near.d > 0.5) return null;
  const oc = R.getOC() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ad = new oc.BRepAdaptor_Surface(near.face.wrapped, true);
  try {
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return null;
    const c = ad.Cylinder(), ax = c.Axis(), l = ax.Location(), d = ax.Direction();
    return { o: [l.X(), l.Y(), l.Z()], a: [d.X(), d.Y(), d.Z()], r: c.Radius() };
  } finally { ad.delete(); }
}

/** Texto que da la vuelta a un cilindro: cada letra plana, tangente a la cara y girada según su sitio */
function wrapTextSolid(f: Extract<RF, { type: "text" }>, body: Shape): Shape {
  const p = f.points[f.points.length - 1];
  const P: Vec3 = [p.x, p.y, p.z];
  const cy = cylinderAt(body, P);
  if (!cy) throw new Error("esa cara no es cilíndrica: haz clic en una cara redonda o quita «Seguir la curva»");
  const { o, a, r } = cy;
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const add = (...vs: Vec3[]): Vec3 => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0] as Vec3);
  const rel = sub(P, o);
  const h0 = dot(rel, a);
  const radial = sub(rel, vscale(a, h0));
  const rl = Math.hypot(...radial);
  if (rl < 1e-6) throw new Error("el punto está en el eje del cilindro");
  const u0 = vscale(radial, 1 / rl);
  // cara de fuera (se lee desde fuera) o de dentro (el interior de un vaso)
  const s = dot(p.n as Vec3, u0) >= 0 ? 1 : -1;
  const font = R.getFont(f.font);
  const adv = (t: string) => font.getAdvanceWidth(t, f.size);
  const total = adv(f.text);
  // alto: centrado como en el texto plano
  const [[, y0], [, y1]] = R.drawText(f.text, { fontSize: f.size, fontFamily: f.font }).boundingBox.bounds;
  const yMid = (y0 + y1) / 2;
  if (total / r > 2 * Math.PI * 0.95) throw new Error("el texto es más largo que la vuelta entera: hazlo más pequeño");
  const solids: Shape[] = [];
  const chars = [...f.text];
  let x = 0;
  for (const ch of chars) {
    const w = adv(ch);
    const mid = x + w / 2 - total / 2;
    x += w;
    if (!ch.trim()) continue;
    let d: R.Drawing;
    try { d = R.drawText(ch, { fontSize: f.size, fontFamily: f.font }); } catch { continue; }
    d = d.translate(-w / 2, -yMid);
    const phi = (s * mid) / r;
    const ui = add(vscale(u0, Math.cos(phi)), vscale(cross(a, u0), Math.sin(phi)));
    const N = vscale(ui, s);
    const t = cross(a, N);
    // una letra plana sobre una cara curva: se separa de la cara en los bordes (la flecha)
    const sag = r - Math.sqrt(Math.max(0, r * r - (w / 2) * (w / 2)));
    const start = f.op === "cut" ? -f.depth : f.op === "add" ? -0.2 - sag * 1.2 : 0;
    const len = f.op === "cut" ? f.depth + 0.3 + sag * 1.2 : f.op === "add" ? f.depth + 0.2 + sag * 1.2 : f.depth;
    const origin = add(o, vscale(a, h0), vscale(ui, r), vscale(N, start));
    solids.push((d.sketchOnPlane(new R.Plane(origin, t, N) as never) as R.Sketch).extrude(len) as Shape);
  }
  if (!solids.length) throw new Error("escribe algún texto");
  return solids.length === 1 ? solids[0] : (R.makeCompound(solids) as unknown as Shape);
}

function holeTool(f: Extract<RF, { type: "hole" }>, depth: number): Shape {
  const sc = SCREWS[f.size];
  if (!sc) throw new Error(`no conozco la medida ${f.size}`);
  const fit = Math.max(0, f.fit || 0);
  const up = 0.5; // empieza un poco por encima de la cara para cortar limpio
  const R0 = (sc.clearance + fit) / 2;
  switch (f.kind) {
    case "clearance":
      return revolveProfile([[0, -up], [R0, -up], [R0, depth], [0, depth]]);
    case "pilot": {
      const r = (sc.pilot + fit) / 2;
      return revolveProfile([[0, -up], [r, -up], [r, depth], [0, depth]]);
    }
    case "insert": {
      const r = sc.insert / 2; // sin holgura: el inserto tiene que agarrar
      return revolveProfile([[0, -up], [r, -up], [r, depth], [0, depth]]);
    }
    case "counterbore": {
      const rc = (sc.headCb + 0.6 + fit) / 2, hc = sc.headCbH + 0.3;
      if (depth <= hc) throw new Error(`con caja, la profundidad tiene que ser mayor que ${hc} mm`);
      return revolveProfile([[0, -up], [rc, -up], [rc, hc], [R0, hc], [R0, depth], [0, depth]]);
    }
    case "countersink": {
      const rs = (sc.headCs + fit) / 2;
      const hs = rs - R0;
      if (depth <= hs) throw new Error(`avellanado: la profundidad tiene que ser mayor que ${hs.toFixed(1)} mm`);
      return revolveProfile([[0, -up], [rs + up, -up], [R0, hs], [R0, depth], [0, depth]]);
    }
    case "nut": {
      const af = sc.nutAf + fit, h = sc.nutH + 0.3;
      const hex = (R.drawPolysides(af / Math.sqrt(3), 6).rotate(30).sketchOnPlane("XY", -up) as R.Sketch).extrude(h + up) as Shape;
      return hex.fuse(revolveProfile([[0, -up], [R0, -up], [R0, depth], [0, depth]]));
    }
    case "thread": {
      // la rosca y un pequeño avellanado de entrada (para que el tornillo entre bien),
      // juntos en un compuesto: fusionarlos costaría segundos por la superficie retorcida
      const screw = makeScrew(sc.d + fit, sc.pitch, depth);
      const rIn = (sc.d + fit) / 2 - 0.54 * sc.pitch, c = sc.pitch * 0.6;
      const mouth = revolveProfile([[0, -up], [rIn + c + up, -up], [rIn, c], [0, c]]);
      return R.makeCompound([screw, mouth]) as unknown as Shape;
    }
  }
}

function targetBody(bodies: Body[], target?: string) {
  if (!bodies.length) throw new Error("primero crea un sólido");
  const b = target ? bodies.find((x) => x.id === target) : bodies[bodies.length - 1];
  if (!b) throw new Error("el cuerpo objetivo ya no existe");
  return b;
}

function bodySize(b: Body) {
  const bb = b.shape.boundingBox.bounds;
  return Math.hypot(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]);
}

type Tool = { shape: Shape; op: string; target?: string };

const AXES: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Puntos y direcciones repartidos a la misma distancia a lo largo de un camino */
function pathStations(path: RSketch, n: number): { p: Vec3; t: Vec3 }[] {
  const wire = (pathDrawing(path).sketchOnPlane(makePlane(sketchBasis(path))) as R.Sketch).wire;
  // el parámetro de OpenCascade no avanza igual en rectas que en arcos: se mide con muestras
  const N = 600;
  const pts: Vec3[] = [], acc: number[] = [0];
  for (let i = 0; i <= N; i++) {
    const v = wire.pointAt(i / N);
    pts.push([v.x, v.y, v.z]);
    if (i) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  }
  const L = acc[N];
  if (L < 1e-6) throw new Error("el camino no tiene largo");
  const closed = Math.hypot(pts[0][0] - pts[N][0], pts[0][1] - pts[N][1], pts[0][2] - pts[N][2]) < 1e-4;
  const step = closed ? L / n : L / Math.max(1, n - 1);
  const out: { p: Vec3; t: Vec3 }[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = Math.min(L, k * step);
    while (j < N - 1 && acc[j + 1] < d) j++;
    const seg = acc[j + 1] - acc[j] || 1;
    const u = (d - acc[j]) / seg;
    const a = pts[j], b = pts[j + 1];
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    out.push({ p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], t: [t[0] / tl, t[1] / tl, t[2] / tl] });
  }
  return out;
}

function patternCopies(f: Extract<RF, { type: "pattern" }>, base: Shape, sketches?: Map<string, RSketch>): Shape[] {
  const out: Shape[] = [];
  if (f.kind === "path") {
    const path = f.path ? sketches?.get(f.path) : undefined;
    if (!path) throw new Error("elige el boceto con el camino");
    if (path.off) throw new Error("el boceto del camino está apagado");
    const n = Math.round(f.count);
    if (n < 2 || n > 200) throw new Error("el número de copias tiene que estar entre 2 y 200");
    const st = pathStations(path, n);
    const p0 = st[0].p, t0 = st[0].t;
    for (let i = 1; i < n; i++) {
      let c = base.clone() as Shape;
      if (f.align) {
        const t = st[i].t;
        const ax: Vec3 = [t0[1] * t[2] - t0[2] * t[1], t0[2] * t[0] - t0[0] * t[2], t0[0] * t[1] - t0[1] * t[0]];
        const sin = Math.hypot(...ax), cos = t0[0] * t[0] + t0[1] * t[1] + t0[2] * t[2];
        const ang = (Math.atan2(sin, cos) * 180) / Math.PI;
        if (sin > 1e-9) c = c.rotate(ang, p0, ax) as Shape;
        else if (cos < 0) c = c.rotate(180, p0, sketchBasis(path).n) as Shape;
      }
      out.push(c.translate([st[i].p[0] - p0[0], st[i].p[1] - p0[1], st[i].p[2] - p0[2]]) as Shape);
    }
    return out;
  }
  if (f.kind === "mirror") {
    out.push(base.clone().mirror(AXES[f.axis], vscale(AXES[f.axis], f.offset)) as Shape);
    return out;
  }
  const n1 = Math.round(f.count);
  if (n1 < 1 || n1 > 200) throw new Error("el número de copias tiene que estar entre 1 y 200");
  if (f.kind === "linear") {
    const n2 = Math.max(1, Math.round(f.count2 || 1));
    if (n1 * n2 > 400) throw new Error("demasiadas copias (máximo 400)");
    const a = AXES[f.axis], b = AXES[f.axis2];
    if (n2 > 1 && f.axis === f.axis2) throw new Error("las dos direcciones tienen que ser distintas");
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const t: Vec3 = [a[0] * f.spacing * i + b[0] * f.spacing2 * j, a[1] * f.spacing * i + b[1] * f.spacing2 * j, a[2] * f.spacing * i + b[2] * f.spacing2 * j];
      out.push(base.clone().translate(t) as Shape);
    }
  } else {
    const full = Math.abs(Math.abs(f.angle) - 360) < 1e-6;
    const step = f.angle / (full ? n1 : Math.max(1, n1 - 1));
    for (let i = 1; i < n1; i++) out.push(base.clone().rotate(step * i, [f.cx, f.cy, f.cz], AXES[f.axis]) as Shape);
  }
  return out;
}

// ---------------------------------------------------------------
// Memoria de pasos: si cambias el paso 7, los 6 primeros no se vuelven a calcular.

interface Snapshot {
  key: string;
  bodies: Body[];
  errors: Record<string, string>;
  bodiesBefore: BuildResult["bodiesBefore"];
  sketches: Map<string, RSketch>;
  tools: Map<string, Tool>;
  solidCount: number;
}
let stepCache: Snapshot[] = [];
// En la consola del navegador se avisa de los pasos lentos (más de medio segundo)
const SLOW_MS = 500;

function snapshot(key: string, st: Omit<Snapshot, "key">): Snapshot {
  return {
    key,
    bodies: st.bodies.map((b) => ({ ...b })),
    errors: { ...st.errors },
    bodiesBefore: { ...st.bodiesBefore },
    sketches: new Map(st.sketches),
    tools: new Map(st.tools),
    solidCount: st.solidCount,
  };
}

function runFeatures(features: RF[], upTo?: string) {
  // claves acumuladas: la del paso i incluye todos los anteriores
  const keys: string[] = [];
  let acc = "";
  for (const f of features) { acc += JSON.stringify(f) + "\n"; keys.push(acc); }
  // el último paso que ya tenemos calculado tal cual
  let start = 0;
  while (start < features.length && stepCache[start]?.key === keys[start]) start++;
  const base = start > 0 ? stepCache[start - 1] : null;
  stepCache = stepCache.slice(0, start);

  const bodies: Body[] = base ? base.bodies.map((b) => ({ ...b })) : [];
  const errors: Record<string, string> = base ? { ...base.errors } : {};
  const bodiesBefore: BuildResult["bodiesBefore"] = base ? { ...base.bodiesBefore } : {};
  const sketches = base ? new Map(base.sketches) : new Map<string, RSketch>();
  const tools = base ? new Map(base.tools) : new Map<string, Tool>();
  let solidCount = base?.solidCount ?? 0;

  // si el paso donde paramos ya estaba calculado, basta con la foto anterior
  const stopAt = upTo ? features.findIndex((f) => f.id === upTo) : -1;
  if (stopAt >= 0 && stopAt < start) {
    const snap = stopAt > 0 ? stepCache[stopAt - 1] : null;
    const bb = snap ? { ...snap.bodiesBefore } : {};
    bb[upTo!] = (snap?.bodies ?? []).map((b) => ({ id: b.id, name: b.name }));
    return { bodies: (snap?.bodies ?? []).map((b) => ({ ...b })), errors: snap ? { ...snap.errors } : {}, bodiesBefore: bb };
  }

  for (let i = start; i < features.length; i++) {
    const f = features[i];
    if (i > start) stepCache.push(snapshot(keys[i - 1], { bodies, errors, bodiesBefore, sketches, tools, solidCount }));
    if (upTo && f.id === upTo) {
      bodiesBefore[f.id] = bodies.map((b) => ({ id: b.id, name: b.name }));
      break;
    }
    bodiesBefore[f.id] = bodies.map((b) => ({ id: b.id, name: b.name }));
    if (f.type === "sketch") {
      sketches.set(f.id, f);
      // validar el boceto ya, para avisar pronto
      // (un boceto que solo tiene líneas abiertas es un camino: no se valida como contorno)
      const onlyPaths = f.profiles.length > 0 && f.profiles.every((p) => p.kind === "poly" && p.open);
      try { if (!f.off && !onlyPaths && f.profiles.length) sketchDrawing(f); } catch (e) { errors[f.id] = msg(e); }
      if (i === features.length - 1) stepCache.push(snapshot(keys[i], { bodies, errors, bodiesBefore, sketches, tools, solidCount }));
      continue;
    }
    const tStep = performance.now();
    if (f.off) {
      if (i === features.length - 1) stepCache.push(snapshot(keys[i], { bodies, errors, bodiesBefore, sketches, tools, solidCount }));
      continue;
    }
    try {
      // si le has puesto nombre propio al paso («Tapa»), el cuerpo se llama así
      const label = f.name && !/\s\d+$/.test(f.name.trim()) ? f.name.trim()
        : f.type === "catalog" ? catalogPart(f.part)?.name ?? `Cuerpo ${solidCount + 1}` : `Cuerpo ${solidCount + 1}`;
      const isNew = () => "op" in f && (f.op === "new" || !bodies.length);
      let shape: Shape | null = null;
      switch (f.type) {
        case "extrude": {
          const s = sketches.get(f.sketch);
          if (!s) throw new Error("elige un boceto");
          if (s.off) throw new Error("el boceto está apagado");
          if (!f.distance) throw new Error("la distancia no puede ser 0");
          const { basis, sketch } = sketchSolidSource(s);
          const make = (dist: number) => {
            let sh = (sketch() as R.Sketch).extrude(dist) as Shape;
            if (f.symmetric) sh = sh.translate(vscale(basis.n, -dist / 2));
            return sh;
          };
          const d = f.reverse ? -f.distance : f.distance;
          shape = make(d);
          // Al restar desde una cara, lo normal es querer ir "hacia dentro".
          // Si en un sentido no toca la pieza, probamos el contrario.
          if (f.op === "cut" && !f.symmetric && bodies.length) {
            const target = f.target ? bodies.find((b) => b.id === f.target) : bodies[bodies.length - 1];
            if (target && !touches(target.shape, shape)) {
              const other = make(-d);
              if (touches(target.shape, other)) shape = other;
            }
          }
          break;
        }
        case "revolve": {
          const s = sketches.get(f.sketch);
          if (!s) throw new Error("elige un boceto");
          if (s.off) throw new Error("el boceto está apagado");
          const { basis, sketch } = sketchSolidSource(s);
          const ax = f.axis === "x" ? basis.x : basis.y;
          const ang = Math.max(-360, Math.min(360, f.angle));
          if (!ang) throw new Error("el ángulo no puede ser 0");
          shape = (sketch() as R.Sketch).revolve(ax, { origin: basis.origin, angle: ang }) as Shape;
          break;
        }
        case "sweep": {
          const prof = sketches.get(f.sketch), path = sketches.get(f.path);
          if (!prof) throw new Error("elige el boceto con la forma");
          if (!path) throw new Error("elige el boceto con el camino");
          if (prof.id === path.id) throw new Error("la forma y el camino tienen que ser bocetos distintos");
          if (prof.off || path.off) throw new Error("uno de los bocetos está apagado");
          const shapeDrawing = sketchDrawing(prof);
          const pathSketch = pathDrawing(path).sketchOnPlane(makePlane(sketchBasis(path))) as R.Sketch;
          shape = pathSketch.sweepSketch((plane, origin) => shapeDrawing.sketchOnPlane(plane as never, origin) as R.Sketch, { transitionMode: "round" }) as Shape; // con esquinas redondeadas: con "frenet" algunos caminos con arcos dan sólidos que luego no se pueden sumar
          break;
        }
        case "loft": {
          const list = f.sketches.map((id) => sketches.get(id));
          if (list.length < 2 || list.some((x) => !x)) throw new Error("elige al menos dos bocetos, en orden");
          if (list.some((x) => x!.off)) throw new Error("uno de los bocetos está apagado");
          const sk = list.map((x) => {
            const d = sketchDrawing(x!).sketchOnPlane(makePlane(sketchBasis(x!)));
            if (!(d instanceof R.Sketch)) throw new Error(`«${x!.name}» tiene que ser un solo contorno sin agujeros`);
            return d;
          });
          shape = sk[0].loftWith(sk.slice(1), { ruled: f.ruled }) as Shape;
          break;
        }
        case "import": {
          if (!f.file) throw new Error("elige un archivo STEP o STL");
          const it = imported.get(f.file);
          if (!it) throw new Error("falta el archivo: vuelve a importarlo");
          if (it.error) throw new Error("no se pudo leer el archivo: " + it.error);
          if (!it.shape) throw new Error("leyendo el archivo…");
          if (!(f.scale > 0)) throw new Error("la escala debe ser mayor que 0");
          let sh = it.shape.clone() as Shape;
          if (f.scale !== 1) sh = sh.scale(f.scale, [0, 0, 0]) as Shape;
          shape = sh.translate(f.x, f.y, f.z) as Shape;
          break;
        }
        case "relief":
          shape = reliefShape(f);
          if (f.mode === "relief") coarseIds.add(f.id);
          break;
        case "layflat":
          layFlat(bodies, f.face as Vec3 | null);
          break;
        case "transform": {
          const idx = f.body ? bodies.findIndex((b) => b.id === f.body) : bodies.length - 1;
          if (idx < 0) throw new Error(bodies.length ? "ese cuerpo ya no existe" : "todavía no hay ningún cuerpo que mover");
          const b = bodies[idx];
          if (!(f.scale > 0)) throw new Error("la escala tiene que ser mayor que 0 (1 = igual)");
          let sh = b.shape.clone() as Shape;
          // gira y escala alrededor del centro del cuerpo, que es lo natural
          const c = sh.boundingBox.center as Vec3;
          if (Math.abs(f.scale - 1) > 1e-9) sh = sh.scale(f.scale, c) as Shape;
          if (f.rx) sh = sh.rotate(f.rx, c, [1, 0, 0]) as Shape;
          if (f.ry) sh = sh.rotate(f.ry, c, [0, 1, 0]) as Shape;
          if (f.rz) sh = sh.rotate(f.rz, c, [0, 0, 1]) as Shape;
          if (f.dx || f.dy || f.dz) sh = sh.translate([f.dx, f.dy, f.dz]) as Shape;
          if (f.copy) bodies.push({ id: f.id, name: `${b.name} (copia)`, shape: sh, coarse: b.coarse });
          else bodies[idx] = { ...b, shape: sh };
          break;
        }
        case "catalog": {
          const part = catalogPart(f.part);
          if (!part) throw new Error("elige una pieza del catálogo");
          if (f.fit < 0 || f.fit > 2) throw new Error("la holgura tiene que estar entre 0 y 2 mm");
          let sh = catalogShape(part, f.op === "cut", f.fit, f.length);
          if (f.rx) sh = sh.rotate(f.rx, [0, 0, 0], [1, 0, 0]) as Shape;
          if (f.rz) sh = sh.rotate(f.rz, [0, 0, 0], [0, 0, 1]) as Shape;
          shape = sh.translate([f.x, f.y, f.z]) as Shape;
          break;
        }
        case "split": {
          const idx = f.body ? bodies.findIndex((b) => b.id === f.body) : bodies.length - 1;
          if (idx < 0) throw new Error(bodies.length ? "ese cuerpo ya no existe" : "todavía no hay ningún cuerpo que partir");
          const res = splitBody(bodies[idx].shape, f);
          const b = bodies[idx];
          bodies[idx] = { ...b, name: `${b.name} (parte 1)`, shape: res.a };
          bodies.push({ id: f.id, name: `${b.name} (parte 2)`, shape: res.b, coarse: b.coarse });
          if (res.pins) bodies.push({ id: `${f.id}-espigas`, name: "Espigas", shape: res.pins });
          break;
        }
        case "joint": {
          if (!f.bodies.length) throw new Error("elige qué cuerpos se mueven con la unión");
          if (f.max < f.min) throw new Error("el máximo tiene que ser mayor que el mínimo");
          if (f.value < f.min - 1e-9 || f.value > f.max + 1e-9) throw new Error(`la posición (${f.value}) se sale de ${f.min} a ${f.max}`);
          const sign = f.axis.startsWith("-") ? -1 : 1;
          const ax = f.axis.replace("-", "");
          const dir: Vec3 = [ax === "x" ? sign : 0, ax === "y" ? sign : 0, ax === "z" ? sign : 0];
          for (const id of f.bodies) {
            const i = bodies.findIndex((b) => b.id === id);
            if (i < 0) throw new Error("uno de los cuerpos de la unión ya no existe");
            if (!f.value) continue;
            const sh = f.kind === "hinge"
              ? bodies[i].shape.clone().rotate(f.value, [f.x, f.y, f.z], dir)
              : bodies[i].shape.clone().translate([dir[0] * f.value, dir[1] * f.value, dir[2] * f.value]);
            bodies[i] = { ...bodies[i], shape: sh as Shape };
          }
          break;
        }
        case "combine": {
          const ti = bodies.findIndex((b) => b.id === f.target);
          if (ti < 0) throw new Error("elige el cuerpo que se queda con el resultado");
          const tools = f.tools.filter((id) => id !== f.target);
          if (!tools.length) throw new Error("elige al menos otro cuerpo para combinar");
          let sh = bodies[ti].shape;
          let coarse = bodies[ti].coarse;
          for (const id of tools) {
            const t = bodies.find((b) => b.id === id);
            if (!t) throw new Error("uno de los cuerpos elegidos ya no existe");
            sh = (f.op === "add" ? sh.fuse(t.shape) : f.op === "cut" ? sh.cut(t.shape) : sh.intersect(t.shape)) as Shape;
            coarse ||= t.coarse;
          }
          bodies[ti] = { ...bodies[ti], shape: sh, coarse };
          if (!f.keep) for (const id of tools) { const k = bodies.findIndex((b) => b.id === id); if (k >= 0) bodies.splice(k, 1); }
          break;
        }
        case "component": {
          shape = componentShape(f.resolved as RF[], f.source.name);
          if (f.rz) shape = shape.rotate(f.rz, [0, 0, 0], [0, 0, 1]) as Shape;
          shape = shape.translate(f.x, f.y, f.z) as Shape;
          break;
        }
        case "text": {
          if (!f.text.trim()) throw new Error("escribe algún texto");
          if (f.size <= 0 || f.depth <= 0) throw new Error("el alto y la profundidad deben ser mayores que 0");
          if (!fontReady(f.font)) throw new Error("cargando la tipografía…");
          shape = f.wrap && f.points.length ? wrapTextSolid(f, targetBody(bodies, (f as { target?: string }).target).shape) : textSolid(f);
          break;
        }
        case "box":
          if (f.w <= 0 || f.d <= 0 || f.h <= 0) throw new Error("las medidas deben ser mayores que 0");
          shape = R.makeBox([f.x, f.y, f.z], [f.x + f.w, f.y + f.d, f.z + f.h]) as Shape;
          break;
        case "cylinder":
          if (f.r <= 0 || f.h <= 0) throw new Error("las medidas deben ser mayores que 0");
          shape = R.makeCylinder(f.r, f.h, [f.x, f.y, f.z], [0, 0, 1]) as Shape;
          break;
        case "gear": {
          if (f.thickness <= 0) throw new Error("el grosor debe ser mayor que 0");
          const pts = gearOutline({ m: f.module, z: Math.round(f.teeth), fit: f.fit });
          let pen = R.draw(pts[0]);
          for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
          let d: R.Drawing = pen.close();
          if (f.bore > 0) {
            if (f.bore / 2 >= (f.module * f.teeth) / 2 - 1.5 * f.module) throw new Error("el agujero es más grande que la rueda");
            d = d.cut(R.drawCircle(f.bore / 2));
          }
          shape = d.sketchOnPlane("XY").extrude(f.thickness) as Shape;
          if (f.angle) shape = shape.rotate(f.angle, [0, 0, 0], [0, 0, 1]) as Shape;
          shape = shape.translate([f.x, f.y, f.z]) as Shape;
          break;
        }
        case "spring": {
          const Rm = (f.diameter - f.wire) / 2;
          if (f.wire <= 0 || Rm <= f.wire / 2) throw new Error("el diámetro tiene que ser mayor que dos hilos");
          if (f.pitch <= f.wire) throw new Error("la distancia entre vueltas tiene que ser mayor que el hilo (si no, se pegan)");
          if (f.turns <= 0 || f.turns > 60) throw new Error("las vueltas tienen que estar entre 0 y 60");
          const H = f.pitch * f.turns;
          const helix = R.makeHelix(f.pitch, H, Rm, [0, 0, 0], [0, 0, 1]);
          const t = helix.tangentAt(0);
          const circ = R.drawCircle(f.wire / 2).sketchOnPlane(new R.Plane([Rm, 0, 0], [1, 0, 0], [t.x, t.y, t.z])) as R.Sketch;
          let sp = R.genericSweep(circ.wire, helix, { frenet: true }, false) as Shape;
          if (f.flat) {
            // puntas planas: se recorta medio hilo arriba y abajo para que apoye
            sp = sp.intersect(R.makeBox([-f.diameter, -f.diameter, 0], [f.diameter, f.diameter, H]) as Shape) as Shape;
          } else sp = sp.translate([0, 0, f.wire / 2]) as Shape;
          shape = sp.translate([f.x, f.y, f.z]) as Shape;
          coarseIds.add(f.id);
          break;
        }
        case "sphere":
          if (f.r <= 0) throw new Error("el radio debe ser mayor que 0");
          shape = R.makeSphere(f.r).translate(f.x, f.y, f.z) as Shape;
          break;
        case "fillet":
        case "chamfer": {
          const warn = applyEdgeOp(bodies, f);
          if (warn) errors[f.id] = warn;
          break;
        }
        case "shell":
          applyShell(bodies, f);
          break;
        case "pushpull":
          pushPull(bodies, f);
          break;
        case "hole":
        case "rod": {
          if (!f.points.length) throw new Error("haz clic en una cara de la pieza para colocarlo");
          const b = targetBody(bodies, f.target);
          const pieces: Shape[] = [];
          if (f.type === "hole") {
            const depth = f.through ? bodySize(b) * 2 + 10 : f.depth;
            if (depth <= 0) throw new Error("la profundidad debe ser mayor que 0");
            const tool = holeTool(f, depth);
            for (const p of f.points) pieces.push(placeAlong(tool.clone() as Shape, [-p.n[0], -p.n[1], -p.n[2]], [p.x, p.y, p.z]));
          } else {
            const sc = SCREWS[f.size];
            if (!sc) throw new Error(`no conozco la medida ${f.size}`);
            if (f.length <= 0) throw new Error("el largo debe ser mayor que 0");
            const sink = 0.3; // se mete un poco en la pieza para que se una bien
            const screw = makeScrew(sc.d - Math.max(0, f.fit || 0), sc.pitch, f.length + sink).translate(0, 0, -sink) as Shape;
            for (const p of f.points) pieces.push(placeAlong(screw.clone() as Shape, p.n as Vec3, [p.x, p.y, p.z]));
          }
          const all = pieces.length === 1 ? pieces[0] : (R.makeCompound(pieces) as unknown as Shape);
          const op = f.type === "hole" ? "cut" : "add";
          const idx = bodies.indexOf(b);
          const coarse = b.coarse || f.type === "rod" || (f.type === "hole" && f.kind === "thread");
          bodies[idx] = { ...b, coarse, shape: op === "cut" ? b.shape.cut(all) : b.shape.fuse(all) };
          tools.set(f.id, { shape: all, op, target: b.id });
          break;
        }
        case "pattern": {
          if (!f.source) {
            const b = targetBody(bodies);
            const copies = patternCopies(f, b.shape, sketches);
            const idx = bodies.indexOf(b);
            let sh = b.shape;
            for (const c of copies) sh = sh.fuse(c);
            bodies[idx] = { ...b, shape: sh };
            break;
          }
          const t = tools.get(f.source);
          if (!t) {
            const src = features.find((x) => x.id === f.source);
            throw new Error(src ? (src.off ? "el paso a repetir está apagado" : "el paso a repetir tiene que ir antes y crear o quitar volumen") : "elige qué repetir");
          }
          const copies = patternCopies(f, t.shape, sketches);
          const all = copies.length === 1 ? copies[0] : (R.makeCompound(copies) as unknown as Shape);
          // si el original creó un cuerpo, las copias se suman a ese cuerpo
          combine(bodies, { id: f.id, op: t.op === "new" ? "add" : t.op, target: t.target } as never, all, "");
          tools.set(f.id, { shape: all, op: t.op, target: t.target });
          break;
        }
      }
      if (shape) {
        const op = (f as { op: string }).op;
        const tgt = op === "new" || !bodies.length ? f.id : (f as { target?: string }).target || bodies[bodies.length - 1]?.id;
        tools.set(f.id, { shape, op: op === "new" || !bodies.length ? "new" : op, target: tgt });
        if (isNew()) solidCount++;
        combine(bodies, f as never, shape, label);
        // los muelles tienen superficies retorcidas: se dibujan con menos detalle
        if (coarseIds.has(f.id)) {
          const tgt = op === "new" || bodies.length === 1 ? bodies.findIndex((b) => b.id === f.id) : (f as { target?: string }).target ? bodies.findIndex((b) => b.id === (f as { target?: string }).target) : bodies.length - 1;
          if (tgt >= 0) bodies[tgt] = { ...bodies[tgt], coarse: true };
        }
      }
    } catch (e) {
      errors[f.id] = msg(e);
    }
    const ms = performance.now() - tStep;
    if (ms > SLOW_MS) console.log(`[geo] paso lento «${f.name}»: ${Math.round(ms)} ms`);
    if (i === features.length - 1) stepCache.push(snapshot(keys[i], { bodies, errors, bodiesBefore, sketches, tools, solidCount }));
  }
  return { bodies, errors, bodiesBefore };
}

function msg(e: unknown) {
  if (typeof e === "number") return "la operación no se pudo hacer (revisa medidas)";
  // los fallos internos de OpenCascade llegan como WebAssembly.Exception, sin texto útil
  if (!(e instanceof Error)) return "la operación no se pudo hacer (revisa medidas)";
  const m = (e as Error)?.message ?? String(e);
  return /^\d+$/.test(m) ? "la operación no se pudo hacer (revisa medidas)" : m;
}

function meshBody(b: Body): BodyMesh {
  // las roscas tienen superficies retorcidas: con detalle normal saldrían 400.000 triángulos
  const tol = b.coarse ? 0.1 : 0.05, ang = b.coarse ? 0.5 : 0.25;
  const m = b.shape.mesh({ tolerance: tol, angularTolerance: ang });
  const e = b.shape.meshEdges({ tolerance: tol, angularTolerance: ang });
  let lines = new Float32Array(e.lines);
  let edgeGroups = e.edgeGroups.map((g) => ({ start: g.start, count: g.count }));
  if (b.coarse) ({ lines, edgeGroups } = threadEdges(m.vertices, m.normals, m.triangles, m.faceGroups, lines, edgeGroups));
  return {
    id: b.id,
    name: b.name,
    vertices: new Float32Array(m.vertices),
    // en las roscas, las normales de OpenCascade salen a trozos (la rosca se ve moteada): mejor sacarlas de los triángulos
    normals: b.coarse ? triangleNormals(m.vertices, m.triangles) : new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    lines,
    edgeGroups,
    faceGroups: m.faceGroups.map((g) => ({ start: g.start, count: g.count })),
    volume: safeNum(() => R.measureVolume(b.shape)),
    area: safeNum(() => R.measureArea(b.shape)),
  };
}

/**
 * Piezas con rosca: la rosca está hecha de muchas caras curvas, y cada unión entre ellas es una
 * arista (en espiral). Dibujarlas todas deja la rosca casi negra. Se quitan las aristas entre dos
 * caras curvas; quedan las que tocan una cara plana (el hexágono, las puntas, los cortes).
 * Los grupos de aristas van en puntos (como los da replicad).
 */
function threadEdges(V: ArrayLike<number>, N: ArrayLike<number>, T: ArrayLike<number>, faces: { start: number; count: number }[], lines: Float32Array<ArrayBuffer>, groups: { start: number; count: number }[]) {
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const faceOf = new Int32Array(V.length / 3).fill(-1);
  faces.forEach((f, fi) => { for (let t = f.start; t < f.start + f.count; t++) faceOf[T[t]] = fi; });
  // ¿cara plana? todas sus normales iguales
  const flat = faces.map((f) => {
    const i0 = T[f.start];
    for (let t = f.start; t < f.start + f.count; t++) {
      const i = T[t];
      if (N[i * 3] * N[i0 * 3] + N[i * 3 + 1] * N[i0 * 3 + 1] + N[i * 3 + 2] * N[i0 * 3 + 2] < 0.9998) return false;
    }
    return true;
  });
  const facesAt = new Map<string, Set<number>>();
  for (let i = 0; i < V.length / 3; i++) {
    const k = key(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]);
    let set = facesAt.get(k);
    if (!set) facesAt.set(k, (set = new Set()));
    set.add(faceOf[i]);
  }
  const at = (p: number) => facesAt.get(key(lines[p * 3], lines[p * 3 + 1], lines[p * 3 + 2]));
  const keep = groups.filter((g) => {
    const a = at(g.start), z = at(g.start + g.count - 1);
    if (!a || !z) return true;
    const both = [...a].filter((f) => f >= 0 && z.has(f));
    if (both.length < 2) return true; // no se sabe: se deja
    return both.some((f) => flat[f]);
  });
  if (keep.length === groups.length) return { lines, edgeGroups: groups };
  const out = new Float32Array(keep.reduce((n, g) => n + g.count * 3, 0));
  const edgeGroups: { start: number; count: number }[] = [];
  let o = 0;
  for (const g of keep) {
    out.set(lines.subarray(g.start * 3, (g.start + g.count) * 3), o * 3);
    edgeGroups.push({ start: o, count: g.count });
    o += g.count;
  }
  return { lines: out, edgeGroups };
}

/** Normales de cada vértice a partir de sus triángulos (las caras grandes pesan más) */
function triangleNormals(V: ArrayLike<number>, T: ArrayLike<number>): Float32Array {
  const N = new Float32Array(V.length);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { N[i] += nx; N[i + 1] += ny; N[i + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
  return N;
}

function safeNum(fn: () => number) {
  try { return fn(); } catch { return 0; }
}

function doBuild(m: Extract<WorkerIn, { kind: "build" }>) {
  lastBuild = m;
  const t0 = performance.now();
  const { bodies, errors, bodiesBefore } = runFeatures(m.features, m.upTo);
  const tSteps = performance.now() - t0;
  const meshes: BodyMesh[] = [];
  for (const b of bodies) {
    try { meshes.push(meshBody(b)); } catch (e) { errors[b.id] = "no se pudo dibujar: " + msg(e); }
  }
  const transfer: Transferable[] = [];
  for (const mm of meshes) transfer.push(mm.vertices.buffer, mm.normals.buffer, mm.triangles.buffer, mm.lines.buffer);
  if (performance.now() - t0 > SLOW_MS) console.log(`[geo] pasos ${Math.round(tSteps)} ms, dibujo ${Math.round(performance.now() - t0 - tSteps)} ms`);
  post({ kind: "built", seq: m.seq, bodies: meshes, errors, bodiesBefore, ms: Math.round(performance.now() - t0) }, transfer);
}

async function doExport(m: Extract<WorkerIn, { kind: "export" }>) {
  try {
    const { bodies } = runFeatures(m.features);
    if (!bodies.length) throw new Error("no hay nada que exportar");
    let data: ArrayBuffer;
    if (m.format === "3mf") {
      const objs = bodies.map((b) => {
        // con roscas, la malla fina sería enorme: basta con 0,02 mm
        const mm = b.shape.mesh(b.coarse ? { tolerance: 0.02, angularTolerance: 0.2 } : { tolerance: 0.01, angularTolerance: 0.1 });
        return { name: b.name, vertices: mm.vertices, triangles: mm.triangles, color: m.colors?.[b.id] };
      });
      data = buildModel3mf(objs);
    } else {
      const all = bodies.length === 1 ? bodies[0].shape : (R.makeCompound(bodies.map((b) => b.shape)) as unknown as Shape);
      const blob = m.format === "stl"
        ? all.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 })
        : all.blobSTEP();
      data = await blob.arrayBuffer();
    }
    post({ kind: "exported", seq: m.seq, format: m.format, data }, [data]);
  } catch (e) {
    post({ kind: "exported", seq: m.seq, format: m.format, data: null, error: msg(e) });
  }
}


/**
 * Sección A-A: corta la pieza por un plano y la mira de frente (axis «y») o de lado (axis «x»),
 * quitando la mitad que queda delante. La cara cortada sale aparte, en triángulos, para rayarla.
 */
function sectionView(all: Shape, sec: { axis: "x" | "y"; at?: number }, flat: (d: R.Drawing) => string[]): DrawingView {
  const [[x0, y0, z0], [x1, y1, z1]] = all.boundingBox.bounds as [number[], number[]];
  const ax = sec.axis === "y" ? 1 : 0;
  const lo = ax === 1 ? y0 : x0, hi = ax === 1 ? y1 : x1;
  const at = sec.at ?? (lo + hi) / 2;
  if (!(at > lo + 1e-6 && at < hi - 1e-6)) throw new Error("el corte de la sección queda fuera de la pieza");
  const pad = 1;
  // se quita lo que está entre quien mira y el plano: de frente se mira hacia +Y, de lado hacia +X
  const cutter = ax === 1
    ? R.makeBox([x0 - pad, y0 - pad, z0 - pad], [x1 + pad, at, z1 + pad])
    : R.makeBox([x0 - pad, y0 - pad, z0 - pad], [at, y1 + pad, z1 + pad]);
  const half = all.cut(cutter as Shape) as Shape;
  const { visible } = R.drawProjection(half, ax === 1 ? "front" : "right");
  const vis = flat(visible);
  const [[u0, v0], [u1, v1]] = visible.boundingBox.bounds;
  // cara cortada: los triángulos de la malla que están sobre el plano. De frente u = X, de lado u = −Y; v = Z
  const mm = half.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
  const V = mm.vertices, T = mm.triangles;
  const on = (i: number) => Math.abs(V[i * 3 + ax] - at) < 1e-4;
  const uv = (i: number) => {
    const u = ax === 1 ? V[i * 3] : -V[i * 3 + 1];
    return `${u.toFixed(3)} ${(-V[i * 3 + 2]).toFixed(3)}`;
  };
  const tri: string[] = [];
  for (let t = 0; t < T.length; t += 3) {
    if (on(T[t]) && on(T[t + 1]) && on(T[t + 2])) tri.push(`M${uv(T[t])}L${uv(T[t + 1])}L${uv(T[t + 2])}Z`);
  }
  return { name: "section", visible: vis, hidden: [], hatch: tri.join(""), box: [u0, -v1, u1, -v0], cut: { axis: sec.axis, at } };
}

/** Plano 2D: vistas de frente, arriba, derecha y 3D, con las líneas ocultas aparte */
function doDrawing(m: Extract<WorkerIn, { kind: "drawing" }>) {
  try {
    const { bodies } = runFeatures(m.features);
    if (!bodies.length) throw new Error("no hay ninguna pieza que dibujar");
    const all = bodies.length === 1 ? bodies[0].shape : (R.makeCompound(bodies.map((b) => b.shape)) as unknown as Shape);
    const cams: [DrawingView["name"], R.ProjectionPlane | R.ProjectionCamera][] = [
      ["front", "front"], ["top", "top"], ["right", "right"],
      ["iso", new R.ProjectionCamera([0, 0, 0], [1, -1, 1], [1, 1, 0])],
    ];
    const flat = (d: R.Drawing) => {
      const p = d.toSVGPaths() as unknown as (string | string[])[];
      return p.flat();
    };
    const views: DrawingView[] = [];
    for (const [name, cam] of cams) {
      const { visible, hidden } = R.drawProjection(all, cam);
      const vis = flat(visible);
      if (!vis.length) continue;
      const bb = visible.boundingBox;
      const [[x0, y0], [x1, y1]] = bb.bounds;
      // el SVG tiene la Y hacia abajo: replicad ya la da la vuelta
      views.push({ name, visible: vis, hidden: name === "iso" ? [] : flat(hidden), box: [x0, -y1, x1, -y0] });
    }
    let error: string | undefined;
    if (m.section) {
      try { views.push(sectionView(all, m.section, flat)); } catch (e) { error = "sin sección: " + msg(e); }
    }
    post({ kind: "drawing", seq: m.seq, views, error });
  } catch (e) {
    post({ kind: "drawing", seq: m.seq, error: msg(e) });
  }
}

/** Busca cuerpos que se meten unos en otros (choques de un ensamblaje) */
function doCollide(m: Extract<WorkerIn, { kind: "collide" }>) {
  try {
    const { bodies } = runFeatures(m.features);
    const clashes: Clash[] = [];
    const boxes = bodies.map((b) => b.shape.boundingBox.bounds as [Vec3, Vec3]);
    const overlap = (p: [Vec3, Vec3], q: [Vec3, Vec3]) => [0, 1, 2].every((k) => p[0][k] < q[1][k] - 1e-6 && q[0][k] < p[1][k] - 1e-6);
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        if (!overlap(boxes[i], boxes[j])) continue;
        let common: Shape;
        try { common = bodies[i].shape.intersect(bodies[j].shape) as Shape; } catch { continue; }
        const volume = safeNum(() => R.measureVolume(common));
        // tocarse (caras en contacto) no es chocar
        if (!(volume > 0.01)) continue;
        const c: Clash = { a: bodies[i].id, b: bodies[j].id, nameA: bodies[i].name, nameB: bodies[j].name, volume };
        if (m.mesh) {
          try {
            const mm = common.mesh({ tolerance: 0.1, angularTolerance: 0.5 });
            const t = new Float32Array(mm.triangles.length * 3);
            mm.triangles.forEach((vi, k) => { t[k * 3] = mm.vertices[vi * 3]; t[k * 3 + 1] = mm.vertices[vi * 3 + 1]; t[k * 3 + 2] = mm.vertices[vi * 3 + 2]; });
            c.tris = t;
          } catch { /* sin dibujo, pero el aviso vale */ }
        }
        clashes.push(c);
      }
    }
    post({ kind: "collide", seq: m.seq, clashes }, clashes.flatMap((c) => (c.tris ? [c.tris.buffer] : [])));
  } catch (e) {
    post({ kind: "collide", seq: m.seq, clashes: [], error: msg(e) });
  }
}

/**
 * Compara dos versiones: lo que tienen en común, lo que ha crecido (está en B y no en A)
 * y lo que ha desaparecido (estaba en A y ya no está en B).
 */
function doCompare(m: Extract<WorkerIn, { kind: "compare" }>) {
  try {
    const solid = (features: RF[]): Shape | null => {
      const { bodies } = runFeatures(features);
      return bodies.length ? fuseAll(bodies.map((b) => b.shape)) : null;
    };
    const A = solid(m.a), B = solid(m.b);
    if (!A && !B) throw new Error("las dos versiones están vacías");
    const empty: ComparePart = { vertices: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0), volume: 0 };
    const part = (s: Shape | null): ComparePart => {
      if (!s) return empty;
      const volume = safeNum(() => R.measureVolume(s));
      if (!(volume > 1e-3)) return empty;
      const mm = s.mesh({ tolerance: 0.05, angularTolerance: 0.25 });
      return { vertices: new Float32Array(mm.vertices), normals: new Float32Array(mm.normals), triangles: new Uint32Array(mm.triangles), volume };
    };
    const parts = {
      same: part(A && B ? (A.intersect(B) as Shape) : null),
      added: part(!A ? B : B ? (B.cut(A) as Shape) : null),
      removed: part(!B ? A : A ? (A.cut(B) as Shape) : null),
    };
    const transfer = Object.values(parts).flatMap((p) => [p.vertices.buffer, p.normals.buffer, p.triangles.buffer]);
    post({ kind: "compare", seq: m.seq, parts }, transfer);
  } catch (e) {
    post({ kind: "compare", seq: m.seq, error: msg(e) });
  } finally {
    // la próxima reconstrucción normal no debe aprovechar pasos de otra versión
    stepCache = [];
  }
}

// ---------------------------------------------------------------
// Piezas de catálogo: la pieza real, o el hueco para meterla (con holgura)

function cyl(r: number, z0: number, z1: number, x = 0, y = 0): Shape {
  return R.makeCylinder(r, z1 - z0, [x, y, z0], [0, 0, 1]) as Shape;
}
function boxC(w: number, d: number, z0: number, z1: number, x = 0, y = 0): Shape {
  return R.makeBox([x - w / 2, y - d / 2, z0], [x + w / 2, y + d / 2, z1]) as Shape;
}
const fuseAll = (list: Shape[]) => list.slice(1).reduce((a, b) => a.fuse(b) as Shape, list[0]);

function catalogShape(p: CatalogPart, pocket: boolean, fit: number, length: number): Shape {
  // el origen es la boca del hueco: el hueco sale 1 mm por fuera para no dejar una piel
  const z0 = pocket ? -1 : 0;
  switch (p.kind) {
    case "bearing": {
      if (pocket) return cyl((p.d! + fit) / 2, z0, p.h! + fit / 2);
      return cyl(p.d! / 2, 0, p.h!).cut(cyl(p.id2! / 2, -1, p.h! + 1)) as Shape;
    }
    case "magnet":
      return pocket ? cyl((p.d! + fit) / 2, z0, p.h! + fit / 2) : cyl(p.d! / 2, 0, p.h!);
    case "insert":
      // el agujero de un inserto va SIN holgura: se funde el plástico al meterlo
      return pocket ? cyl(p.hole! / 2, z0, p.h! + 1) : cyl(p.d! / 2, 0, p.h!).cut(cyl((p.d! * 0.55) / 2, -1, p.h! + 1)) as Shape;
    case "nut": {
      const pts = hexagon(p.d! + (pocket ? fit : 0));
      let pen = R.draw(pts[0]);
      for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
      let d: R.Drawing = pen.close();
      if (!pocket) d = d.cut(R.drawCircle(p.id2! / 2));
      const hh = p.h! + (pocket ? fit / 2 + 1 : 0);
      const sh = d.sketchOnPlane("XY").extrude(hh) as Shape;
      return pocket ? sh.translate([0, 0, -1]) as Shape : sh;
    }
    case "profile": {
      if (!(length > 0)) throw new Error("pon el largo del perfil");
      if (pocket) return boxC(20 + fit, 20 + fit, z0, length + fit / 2);
      // sección simplificada: cuadrado de 20 con una ranura de 6 en cada cara y agujero central
      let s: R.Drawing = R.drawRectangle(20, 20);
      for (const [x, y, w, hgt] of [[0, 8.25, 6, 3.5], [0, -8.25, 6, 3.5], [8.25, 0, 3.5, 6], [-8.25, 0, 3.5, 6]] as const) s = s.cut(R.drawRectangle(w, hgt).translate(x, y));
      s = s.cut(R.drawCircle(2.1));
      return s.sketchOnPlane("XY").extrude(length) as Shape;
    }
    case "servo": {
      // SG90: el origen es la base de las orejetas, en el centro
      if (pocket) return fuseAll([boxC(22.5 + fit, 11.8 + fit, -30, 0.5), cyl(0.9, -10, 0.5, 13.9, 0), cyl(0.9, -10, 0.5, -13.9, 0)]);
      return fuseAll([
        boxC(22.5, 11.8, -15.9, 6.8),
        boxC(32.2, 11.8, 0, 2.5).cut(cyl(1, -1, 4, 13.9, 0)).cut(cyl(1, -1, 4, -13.9, 0)) as Shape,
        cyl(5.9, 6.8, 10.8, 5.35, 0),
        cyl(2.4, 10.8, 14, 5.35, 0),
      ]);
    }
    case "stepper": {
      // NEMA 17: el origen es la cara de montaje; el cuerpo va hacia abajo
      const holes = [[15.5, 15.5], [-15.5, 15.5], [15.5, -15.5], [-15.5, -15.5]];
      if (pocket) return fuseAll([cyl((22 + fit) / 2, -1, 40), ...holes.map(([x, y]) => cyl(1.7, -1, 40, x, y))]);
      let body = boxC(42.3, 42.3, -40, 0);
      for (const [x, y] of holes) body = body.cut(cyl(1.5, -4.5, 1, x, y)) as Shape;
      return fuseAll([body, cyl(11, 0, 2), cyl(2.5, 0, 24)]);
    }
  }
}

// ---------------------------------------------------------------
// Partir un cuerpo por un plano, con espigas para volver a unirlo

function splitBody(shape: Shape, f: Resolved<Extract<Feature, { type: "split" }>>) {
  const ax = f.axis === "x" ? 0 : f.axis === "y" ? 1 : 2;
  const [lo, hi] = shape.boundingBox.bounds as [Vec3, Vec3];
  if (!(f.at > lo[ax] + 0.5 && f.at < hi[ax] - 0.5)) throw new Error(`el corte tiene que caer dentro de la pieza (entre ${round1(lo[ax])} y ${round1(hi[ax])} mm en ${f.axis.toUpperCase()})`);
  const big = (from: number, to: number) => {
    const a: Vec3 = [lo[0] - 10, lo[1] - 10, lo[2] - 10], b: Vec3 = [hi[0] + 10, hi[1] + 10, hi[2] + 10];
    a[ax] = from; b[ax] = to;
    return R.makeBox(a, b) as Shape;
  };
  let a = shape.intersect(big(lo[ax] - 10, f.at)) as Shape;
  let b = shape.intersect(big(f.at, hi[ax] + 10)) as Shape;
  let pins: Shape | null = null;
  const dir: Vec3 = [0, 0, 0]; dir[ax] = 1;
  if (f.pins !== "none") {
    if (!(f.pinD > 0) || !(f.pinL > 2)) throw new Error("las espigas necesitan diámetro y un largo de más de 2 mm");
    const n = Math.max(1, Math.min(8, Math.round(f.count)));
    const pts = pinSpots(shape, ax, f.at, f.pinD / 2 + 1.2, f.pinL / 2 + 1, n);
    if (!pts.length) throw new Error("no caben espigas en el corte: prueba más finas, más cortas o sin espigas");
    const holeR = (f.pinD + f.fit) / 2, depth = f.pinL / 2 + 0.5;
    const at = (p: Vec3, off: number): Vec3 => { const q: Vec3 = [...p]; q[ax] += off; return q; };
    for (const p of pts) {
      if (f.pins === "loose") {
        // agujero en las dos mitades y espigas sueltas (se imprimen tumbadas o de pie)
        a = a.cut(R.makeCylinder(holeR, depth, at(p, -depth), dir) as Shape) as Shape;
        b = b.cut(R.makeCylinder(holeR, depth, p, dir) as Shape) as Shape;
        const pin = R.makeCylinder(f.pinD / 2, f.pinL - 0.6, at(p, -(f.pinL - 0.6) / 2), dir) as Shape;
        pins = pins ? pins.fuse(pin) as Shape : pin;
      } else {
        // espiga pegada a la parte 1, agujero en la parte 2
        a = a.fuse(R.makeCylinder(f.pinD / 2, f.pinL / 2 - 0.3, p, dir) as Shape) as Shape;
        b = b.cut(R.makeCylinder(holeR, depth, p, dir) as Shape) as Shape;
      }
    }
  }
  if (f.gap) {
    const t: Vec3 = [0, 0, 0]; t[ax] = f.gap;
    b = b.translate(t) as Shape;
    if (pins) { const t2: Vec3 = [0, 0, 0]; t2[ax] = f.gap / 2; pins = pins.translate(t2) as Shape; }
  }
  return { a, b, pins };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Sitios del corte donde cabe una espiga de radio r (con pared) y medio largo hl a cada lado */
function pinSpots(shape: Shape, ax: number, at: number, r: number, hl: number, n: number): Vec3[] {
  const [lo, hi] = shape.boundingBox.bounds as [Vec3, Vec3];
  const [u, v] = [0, 1, 2].filter((k) => k !== ax);
  const solidQ = new R.DistanceQuery(shape);
  const facesQ = new R.DistanceQuery(R.makeCompound(shape.faces) as unknown as Shape);
  const ok = (cu: number, cv: number) => {
    for (const off of [-hl, 0, hl]) {
      const p: Vec3 = [0, 0, 0]; p[ax] = at + off; p[u] = cu; p[v] = cv;
      const vx = R.makeVertex(p);
      if (solidQ.distanceTo(vx) > 1e-6) return false; // fuera de la pieza
      if (facesQ.distanceTo(vx) < r) return false; // demasiado cerca de una pared
    }
    return true;
  };
  const N = 9, cand: [number, number][] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const cu = lo[u] + ((hi[u] - lo[u]) * (i + 0.5)) / N, cv = lo[v] + ((hi[v] - lo[v]) * (j + 0.5)) / N;
    if (ok(cu, cv)) cand.push([cu, cv]);
  }
  if (!cand.length) return [];
  // la primera, la más cercana al centro; luego, siempre la más lejana de las ya elegidas
  const mid: [number, number] = [(lo[u] + hi[u]) / 2, (lo[v] + hi[v]) / 2];
  const dist = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const chosen: [number, number][] = [];
  if (n === 1) chosen.push(cand.reduce((b, c) => (dist(c, mid) < dist(b, mid) ? c : b)));
  else {
    // dos o más: empieza por las dos más separadas
    let best: [[number, number], [number, number]] = [cand[0], cand[0]];
    for (const p of cand) for (const q of cand) if (dist(p, q) > dist(best[0], best[1])) best = [p, q];
    chosen.push(best[0]);
    if (best[1] !== best[0]) chosen.push(best[1]);
    while (chosen.length < n) {
      let far: [number, number] | null = null, fd = 2 * r;
      for (const c of cand) { const d = Math.min(...chosen.map((x) => dist(x, c))); if (d > fd) { fd = d; far = c; } }
      if (!far) break;
      chosen.push(far);
    }
  }
  solidQ.delete?.(); facesQ.delete?.();
  return chosen.map(([cu, cv]) => { const p: Vec3 = [0, 0, 0]; p[ax] = at; p[u] = cu; p[v] = cv; return p; });
}
