import type { Doc, Feature, Expr, Resolved, Profile, PlaneDef } from "./types";
import { evaluate, resolveVariables } from "./expr";
import { uid } from "./geom";

// ---------- Documento nuevo ----------

export function emptyDoc(name = "Pieza sin nombre"): Doc {
  return { version: 1, name, variables: [], features: [] };
}

export function exampleDoc(): Doc {
  const sk = uid();
  const sk2 = uid();
  return {
    version: 1,
    name: "Ejemplo: soporte",
    variables: [
      { name: "ancho", value: "60" },
      { name: "fondo", value: "40" },
      { name: "grosor", value: "6" },
    ],
    features: [
      {
        id: sk, type: "sketch", name: "Boceto base",
        plane: { kind: "std", name: "XY", offset: "0" },
        profiles: [
          { id: uid(), kind: "rect", hole: false, x: "-ancho/2", y: "-fondo/2", w: "ancho", h: "fondo", r: "6" },
          { id: uid(), kind: "circle", hole: true, cx: "-ancho/2 + 10", cy: "0", r: "3" },
          { id: uid(), kind: "circle", hole: true, cx: "ancho/2 - 10", cy: "0", r: "3" },
        ],
      },
      { id: uid(), type: "extrude", name: "Base", sketch: sk, distance: "grosor", symmetric: false, reverse: false, op: "new" },
      {
        id: sk2, type: "sketch", name: "Boceto pared",
        plane: { kind: "std", name: "XZ", offset: "0" },
        profiles: [
          { id: uid(), kind: "poly", hole: false, pts: [
            { x: "-15", y: "grosor" }, { x: "15", y: "grosor" }, { x: "15", y: "30", s: "-15" }, { x: "-15", y: "30" },
          ] },
          { id: uid(), kind: "circle", hole: true, cx: "0", cy: "30", r: "5" },
        ],
      },
      { id: uid(), type: "extrude", name: "Pared", sketch: sk2, distance: "grosor", symmetric: true, reverse: false, op: "add" },
    ],
  };
}

export const FEATURE_LABEL: Record<Feature["type"], string> = {
  sketch: "Boceto",
  extrude: "Extrusión",
  revolve: "Revolución",
  box: "Caja",
  cylinder: "Cilindro",
  sphere: "Esfera",
  fillet: "Redondeo",
  chamfer: "Chaflán",
  shell: "Vaciado",
  pattern: "Patrón",
  hole: "Agujeros",
  rod: "Varilla roscada",
  text: "Texto",
  sweep: "Barrido",
  loft: "Transición",
  import: "Importado",
  layflat: "Apoyar para imprimir",
  component: "Pieza",
};

export const FEATURE_ICON: Record<Feature["type"], string> = {
  sketch: "✎", extrude: "⬆", revolve: "↻", box: "▣", cylinder: "◉", sphere: "●", fillet: "◜", chamfer: "◸",
  shell: "⬚", pattern: "⁂", hole: "⊚", rod: "⫶", text: "A", sweep: "➰", loft: "⏢", import: "⇩", layflat: "⤓", component: "❖",
};

function nextName(doc: Doc, type: Feature["type"]) {
  const base = FEATURE_LABEL[type];
  let i = 1;
  while (doc.features.some((f) => f.name === `${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function lastSketchId(doc: Doc, before?: number) {
  const list = doc.features.slice(0, before ?? doc.features.length);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].type === "sketch") return list[i].id;
  return "";
}

export function newFeature(doc: Doc, type: Feature["type"], plane?: PlaneDef): Feature {
  const id = uid();
  const name = nextName(doc, type);
  const hasBody = doc.features.some((f) => f.type !== "sketch");
  const op = hasBody ? "add" : "new";
  switch (type) {
    case "sketch":
      return { id, name, type, plane: plane ?? { kind: "std", name: "XY", offset: "0" }, profiles: [] };
    case "extrude":
      return { id, name, type, sketch: lastSketchId(doc), distance: "10", symmetric: false, reverse: false, op };
    case "revolve":
      return { id, name, type, sketch: lastSketchId(doc), axis: "y", angle: "360", op };
    case "box":
      return { id, name, type, x: "0", y: "0", z: "0", w: "20", d: "20", h: "20", op };
    case "cylinder":
      return { id, name, type, x: "0", y: "0", z: "0", r: "10", h: "20", op };
    case "sphere":
      return { id, name, type, x: "0", y: "0", z: "0", r: "10", op };
    case "fillet":
      return { id, name, type, size: "2", edges: [] };
    case "chamfer":
      return { id, name, type, size: "1", edges: [] };
    case "shell":
      return { id, name, type, thickness: "2", faces: [] };
    case "pattern": {
      // por defecto, repetir el último paso que crea o quita volumen
      const src = [...doc.features].reverse().find((f) => ["extrude", "revolve", "box", "cylinder", "sphere", "hole", "rod", "text", "sweep", "loft", "import", "component"].includes(f.type));
      return {
        id, name, type, kind: "linear", source: src?.id ?? "",
        axis: "x", count: "3", spacing: "10", axis2: "y", count2: "1", spacing2: "10",
        cx: "0", cy: "0", cz: "0", angle: "360", offset: "0",
      };
    }
    case "hole":
      return { id, name, type, kind: "clearance", size: "M3", depth: "10", through: true, fit: "0.2", points: [] };
    case "rod":
      return { id, name, type, size: "M8", length: "15", fit: "0.2", points: [] };
    case "text":
      return { id, name, type, text: "Hola", font: "sans-bold", size: "8", depth: hasBody ? "0.6" : "2", angle: "0", points: [], op: hasBody ? "cut" : "new" };
    case "sweep": {
      const sk = doc.features.filter((f) => f.type === "sketch");
      return { id, name, type, sketch: sk[sk.length - 2]?.id ?? "", path: sk[sk.length - 1]?.id ?? "", op };
    }
    case "loft":
      return { id, name, type, sketches: doc.features.filter((f) => f.type === "sketch").slice(-2).map((f) => f.id), ruled: false, op };
    case "import":
      return { id, name, type, file: "", fileName: "", format: "step", x: "0", y: "0", z: "0", scale: "1", op };
    case "layflat":
      return { id, name, type, face: null };
    case "component":
      return { id, name, type, sourceId: "", source: { name: "", variables: [], features: [] }, params: {}, x: "0", y: "0", z: "0", rz: "0", op };
  }
}

// ---------- De texto a números ----------

const NUM_FIELDS: Record<string, string[]> = {
  extrude: ["distance"],
  revolve: ["angle"],
  box: ["x", "y", "z", "w", "d", "h"],
  cylinder: ["x", "y", "z", "r", "h"],
  sphere: ["x", "y", "z", "r"],
  fillet: ["size"],
  chamfer: ["size"],
  shell: ["thickness"],
  pattern: ["count", "spacing", "count2", "spacing2", "cx", "cy", "cz", "angle", "offset"],
  hole: ["depth", "fit"],
  rod: ["length", "fit"],
  text: ["size", "depth", "angle"],
  sweep: [],
  loft: [],
  import: ["x", "y", "z", "scale"],
  layflat: [],
  component: ["x", "y", "z", "rz"],
  rect: ["x", "y", "w", "h", "r"],
  circle: ["cx", "cy", "r"],
  ngon: ["cx", "cy", "r", "n"],
};

export interface ResolveOut {
  features: Resolved<Feature>[];
  /** errores por "idPaso" o "idPaso:campo" */
  fieldErrors: Record<string, string>;
  vars: Record<string, number>;
  varErrors: Record<string, string>;
}

export function resolveDoc(doc: Doc, depth = 0): ResolveOut {
  const { vars, errors: varErrors } = resolveVariables(doc.variables);
  const fieldErrors: Record<string, string> = {};
  const ev = (e: Expr | undefined, key: string, def = 0) => {
    if (e === undefined || e === "") return def;
    try {
      return evaluate(e, vars);
    } catch (err) {
      fieldErrors[key] = (err as Error).message;
      return def;
    }
  };
  const resolveProfile = (fid: string, p: Profile) => {
    const out: Record<string, unknown> = { ...p };
    if (p.kind === "poly") {
      out.pts = p.pts.map((pt, i) => ({
        x: ev(pt.x, `${fid}:${p.id}:${i}:x`),
        y: ev(pt.y, `${fid}:${p.id}:${i}:y`),
        s: ev(pt.s, `${fid}:${p.id}:${i}:s`),
      }));
    } else {
      for (const k of NUM_FIELDS[p.kind]) out[k] = ev((p as never)[k], `${fid}:${p.id}:${k}`);
    }
    return out;
  };
  const features = doc.features.map((f) => {
    const out: Record<string, unknown> = { ...f };
    if (f.type === "sketch") {
      out.plane = { ...f.plane, offset: ev(f.plane.offset, `${f.id}:offset`), tilt: ev(f.plane.tilt, `${f.id}:tilt`), turn: ev(f.plane.turn, `${f.id}:turn`) };
      out.profiles = f.profiles.map((p) => resolveProfile(f.id, p));
    } else {
      for (const k of NUM_FIELDS[f.type]) out[k] = ev((f as never)[k], `${f.id}:${k}`);
      if (f.type === "component") {
        // las variables de la pieza: las suyas, o el valor nuevo calculado con las variables de esta
        if (depth > 3) { fieldErrors[f.id] = "demasiadas piezas una dentro de otra"; out.resolved = []; return out as Resolved<Feature>; }
        const variables = f.source.variables.map((v) => {
          const e = f.params[v.name];
          if (e === undefined || e.trim() === "") return v;
          return { name: v.name, value: String(ev(e, `${f.id}:p:${v.name}`, 0)) as Expr };
        });
        const sub = resolveDoc({ version: 1, name: f.source.name, variables, features: f.source.features as Feature[] }, depth + 1);
        const nErr = Object.keys(sub.fieldErrors).length + Object.keys(sub.varErrors).length;
        if (nErr) fieldErrors[f.id] = `la pieza «${f.source.name}» tiene ${nErr} medida${nErr > 1 ? "s" : ""} que no se entiende${nErr > 1 ? "n" : ""}`;
        out.resolved = sub.features;
      }
      if (f.type === "fillet" || f.type === "chamfer") out.sizes = (f.sizes ?? []).map((e, i) => ev(e, `${f.id}:size${i}`, 0));
      if (f.type === "hole" || f.type === "rod" || f.type === "text") {
        out.points = f.points.map((pt, i) => ({
          x: ev(pt.x, `${f.id}:${i}:x`), y: ev(pt.y, `${f.id}:${i}:y`), z: ev(pt.z, `${f.id}:${i}:z`), n: pt.n,
        }));
      }
    }
    return out as Resolved<Feature>;
  });
  return { features, fieldErrors, vars, varErrors };
}

// ---------- Deshacer / rehacer ----------

export class History {
  private past: string[] = [];
  private future: string[] = [];
  constructor(private current: string) {}
  push(next: string) {
    if (next === this.current) return;
    this.past.push(this.current);
    if (this.past.length > 200) this.past.shift();
    this.current = next;
    this.future = [];
  }
  undo(): string | null {
    const p = this.past.pop();
    if (p === undefined) return null;
    this.future.push(this.current);
    this.current = p;
    return p;
  }
  redo(): string | null {
    const f = this.future.pop();
    if (f === undefined) return null;
    this.past.push(this.current);
    this.current = f;
    return f;
  }
  reset(s: string) { this.past = []; this.future = []; this.current = s; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

// ---------- Guardado en el navegador ----------

const KEY_LIST = "geometria:piezas";
const KEY_DOC = (id: string) => `geometria:pieza:${id}`;
const KEY_LAST = "geometria:ultima";

export interface SavedMeta { id: string; name: string; updated: number }

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export const storage = {
  list(): SavedMeta[] {
    return safe(() => JSON.parse(localStorage.getItem(KEY_LIST) || "[]") as SavedMeta[], []).sort((a, b) => b.updated - a.updated);
  },
  load(id: string): Doc | null {
    return safe(() => {
      const raw = localStorage.getItem(KEY_DOC(id));
      return raw ? (JSON.parse(raw) as Doc) : null;
    }, null);
  },
  save(id: string, doc: Doc) {
    safe(() => {
      localStorage.setItem(KEY_DOC(id), JSON.stringify(doc));
      const list = storage.list().filter((m) => m.id !== id);
      list.push({ id, name: doc.name, updated: Date.now() });
      localStorage.setItem(KEY_LIST, JSON.stringify(list));
      localStorage.setItem(KEY_LAST, id);
    }, undefined);
  },
  remove(id: string) {
    safe(() => {
      localStorage.removeItem(KEY_DOC(id));
      localStorage.setItem(KEY_LIST, JSON.stringify(storage.list().filter((m) => m.id !== id)));
    }, undefined);
  },
  last(): string | null {
    return safe(() => localStorage.getItem(KEY_LAST), null);
  },
};

export function isDoc(x: unknown): x is Doc {
  const d = x as Doc;
  return !!d && d.version === 1 && Array.isArray(d.features) && Array.isArray(d.variables) && (d.files === undefined || typeof d.files === "object");
}
