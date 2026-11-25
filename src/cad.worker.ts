/// <reference lib="webworker" />
// Motor geométrico. Corre en segundo plano para no congelar la pantalla.
// Usa OpenCascade (el mismo núcleo que FreeCAD) a través de replicad.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as R from "replicad";
import { planeBasis, scale as vscale, type Basis } from "./geom";
import { buildModel3mf } from "./threemf";
import { SCREWS } from "./screws";
import type { Feature, Resolved, WorkerIn, WorkerOut, BodyMesh, Vec3, BuildResult } from "./types";

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
      else doExport(m);
    }
  } finally {
    busy = false;
  }
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
      if (pts.length < 3) throw new Error("un perfil cerrado necesita 3 puntos o más");
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

function sketchDrawing(s: RSketch): R.Drawing {
  const solids = s.profiles.filter((p) => !p.hole);
  const holes = s.profiles.filter((p) => p.hole);
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
  if (!f.edges.length) throw new Error("elige al menos una arista en la vista 3D");
  if (f.size <= 0) throw new Error("la medida debe ser mayor que 0");
  let found = 0;
  const lost: number[] = [];
  const picks = f.edges.map(() => ({ body: -1, edge: -1, d: Infinity }));
  bodies.forEach((b, bi) => {
    b.shape.edges.forEach((e, ei) => {
      f.edges.forEach((p, pi) => {
        const d = edgeDistance(e, p as Vec3);
        if (d < picks[pi].d) picks[pi] = { body: bi, edge: ei, d };
      });
    });
  });
  picks.forEach((k, i) => { if (k.d > EDGE_TOL) lost.push(i + 1); });
  if (lost.length === f.edges.length) throw new Error("no encuentro las aristas elegidas (¿cambió mucho la pieza?)");
  bodies.forEach((b, bi) => {
    const mine = new Set(picks.filter((k) => k.body === bi && k.d <= EDGE_TOL).map((k) => k.edge));
    if (!mine.size) return;
    const list = b.shape.edges.filter((_, ei) => mine.has(ei));
    found += list.length;
    const filter = (finder: R.EdgeFinder) => finder.when(({ element }) => list.some((e) => e.isSame(element)));
    b.shape = f.type === "fillet" ? b.shape.fillet(f.size, filter) : b.shape.chamfer(f.size, filter);
  });
  if (!found) throw new Error("no encuentro las aristas elegidas");
  if (lost.length) return `no encontré la arista ${lost.join(", ")}`;
  return null;
}


// ---------------------------------------------------------------
// Vaciado, agujeros, roscas y patrones

/** Cara de la pieza más cercana a un punto (y su distancia) */
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

function patternCopies(f: Extract<RF, { type: "pattern" }>, base: Shape): Shape[] {
  const out: Shape[] = [];
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
      try { if (!f.off) sketchDrawing(f); } catch (e) { errors[f.id] = msg(e); }
      if (i === features.length - 1) stepCache.push(snapshot(keys[i], { bodies, errors, bodiesBefore, sketches, tools, solidCount }));
      continue;
    }
    const tStep = performance.now();
    if (f.off) {
      if (i === features.length - 1) stepCache.push(snapshot(keys[i], { bodies, errors, bodiesBefore, sketches, tools, solidCount }));
      continue;
    }
    try {
      const label = `Cuerpo ${solidCount + 1}`;
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
        case "box":
          if (f.w <= 0 || f.d <= 0 || f.h <= 0) throw new Error("las medidas deben ser mayores que 0");
          shape = R.makeBox([f.x, f.y, f.z], [f.x + f.w, f.y + f.d, f.z + f.h]) as Shape;
          break;
        case "cylinder":
          if (f.r <= 0 || f.h <= 0) throw new Error("las medidas deben ser mayores que 0");
          shape = R.makeCylinder(f.r, f.h, [f.x, f.y, f.z], [0, 0, 1]) as Shape;
          break;
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
            const copies = patternCopies(f, b.shape);
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
          const copies = patternCopies(f, t.shape);
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
  return {
    id: b.id,
    name: b.name,
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    lines: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((g) => ({ start: g.start, count: g.count })),
    faceGroups: m.faceGroups.map((g) => ({ start: g.start, count: g.count })),
    volume: safeNum(() => R.measureVolume(b.shape)),
    area: safeNum(() => R.measureArea(b.shape)),
  };
}

function safeNum(fn: () => number) {
  try { return fn(); } catch { return 0; }
}

function doBuild(m: Extract<WorkerIn, { kind: "build" }>) {
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
        const mm = b.shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
        return { name: b.name, vertices: mm.vertices, triangles: mm.triangles };
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

