/// <reference lib="webworker" />
// Motor geométrico. Corre en segundo plano para no congelar la pantalla.
// Usa OpenCascade (el mismo núcleo que FreeCAD) a través de replicad.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as R from "replicad";
import { planeBasis, scale as vscale, type Basis } from "./geom";
import { buildModel3mf } from "./threemf";
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

interface Body { id: string; name: string; shape: Shape }

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

function runFeatures(features: RF[], upTo?: string) {
  const bodies: Body[] = [];
  const errors: Record<string, string> = {};
  const bodiesBefore: BuildResult["bodiesBefore"] = {};
  const sketches = new Map<string, RSketch>();
  let solidCount = 0;

  for (const f of features) {
    if (upTo && f.id === upTo) {
      bodiesBefore[f.id] = bodies.map((b) => ({ id: b.id, name: b.name }));
      break;
    }
    bodiesBefore[f.id] = bodies.map((b) => ({ id: b.id, name: b.name }));
    if (f.type === "sketch") {
      sketches.set(f.id, f);
      // validar el boceto ya, para avisar pronto
      try { if (!f.off) sketchDrawing(f); } catch (e) { errors[f.id] = msg(e); }
      continue;
    }
    if (f.off) continue;
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
      }
      if (shape) {
        if (isNew()) solidCount++;
        combine(bodies, f as never, shape, label);
      }
    } catch (e) {
      errors[f.id] = msg(e);
    }
  }
  return { bodies, errors, bodiesBefore };
}

function msg(e: unknown) {
  if (typeof e === "number") return "la operación no se pudo hacer (revisa medidas)";
  const m = (e as Error)?.message ?? String(e);
  return /^\d+$/.test(m) ? "la operación no se pudo hacer (revisa medidas)" : m;
}

function meshBody(b: Body, tol = 0.05): BodyMesh {
  const m = b.shape.mesh({ tolerance: tol, angularTolerance: 0.25 });
  const e = b.shape.meshEdges({ tolerance: tol, angularTolerance: 0.25 });
  return {
    id: b.id,
    name: b.name,
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    lines: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((g) => ({ start: g.start, count: g.count })),
  };
}

function doBuild(m: Extract<WorkerIn, { kind: "build" }>) {
  const t0 = performance.now();
  const { bodies, errors, bodiesBefore } = runFeatures(m.features, m.upTo);
  const meshes: BodyMesh[] = [];
  for (const b of bodies) {
    try { meshes.push(meshBody(b)); } catch (e) { errors[b.id] = "no se pudo dibujar: " + msg(e); }
  }
  const transfer: Transferable[] = [];
  for (const mm of meshes) transfer.push(mm.vertices.buffer, mm.normals.buffer, mm.triangles.buffer, mm.lines.buffer);
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

