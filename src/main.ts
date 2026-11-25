import "./style.css";
import type {
  Doc, Feature, SketchFeature, EdgeFeature, BuildResult, WorkerOut, Profile, StdPlane, Vec3, Resolved,
  PatternFeature, PatternKind, Axis, HoleFeature, RodFeature, HoleKind,
  TextFeature, TextFont, SweepFeature, GearFeature, LoftFeature, ImportFeature, LayFlatFeature, ComponentFeature, DrawingView,
} from "./types";
import { checkPrint, DEFAULT_PRINT, type PrintSettings } from "./printcheck";
import { TEMPLATES } from "./templates";
import { files, fileId, toBase64, fromBase64 } from "./files";
import { readSvg, svgToProfiles } from "./svgimport";
import { solveSketch, cleanConstraints, CONSTRAINT_GLYPH, CONSTRAINT_NAME } from "./constraints";
import { Viewport, type ViewName } from "./viewport";
import { SCREWS, SCREW_NAMES, HOLE_KIND_LABEL } from "./screws";
import { SketchEditor, TOOL_HINT, type SketchTool } from "./sketcher";
import { evaluate, fmt, VAR_NAME } from "./expr";
import { planeBasis, planeFromHit, profileLoop, toWorld, uid } from "./geom";
import {
  emptyDoc, exampleDoc, newFeature, resolveDoc, History, storage, isDoc,
  FEATURE_LABEL, FEATURE_ICON, type ResolveOut,
} from "./state";

// ======================================================================
// Estado
// ======================================================================

let docId = storage.last() ?? uid();
let doc: Doc = storage.load(docId) ?? exampleDoc();
const history = new History(JSON.stringify(doc));
let active: string | null = null; // paso que se está editando
let pickingFace = false;
/** en redondeo/chaflán: true = se eligen caras enteras en vez de aristas */
let pickFacesForEdges = false;
let resolved: ResolveOut = resolveDoc(doc);
let build: BuildResult | null = null;
let engineReady = false;
let seq = 0;
let lastBodiesKey = "";
/** móvil: panel abierto abajo (añadir, pasos, props, vars) */
let sheet: string | null = null;
const isMobile = () => matchMedia("(max-width: 700px)").matches;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else if (k === "checked") (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
};

// ======================================================================
// Maquetación
// ======================================================================

const LOGO = `<svg viewBox="0 0 32 32"><path d="M16 3 28 10v12L16 29 4 22V10z" fill="var(--accent)"/><path d="M16 3v26M4 10l12 7 12-7" stroke="#fff" stroke-width="2" fill="none"/></svg>`;

$("#app").innerHTML = `
<header class="top">
  <div class="brand">${LOGO}<span>Geometría</span></div>
  <input class="docname" id="docname" title="Nombre de la pieza" />
  <button class="btn" id="undo" title="Deshacer (Ctrl+Z)">↶</button>
  <button class="btn" id="redo" title="Rehacer (Ctrl+Y)">↷</button>
  <div class="spacer"></div>
  <div class="menu" id="m-file"><button class="btn">Archivo ▾</button><div class="menu-list">
    <button data-a="new">Pieza nueva</button>
    <button data-a="open">Abrir pieza guardada…</button>
    <button data-a="example">Abrir el ejemplo</button>
    <button data-a="templates">Plantillas…<small>Caja, bisagra, engranajes, muelle, clip, tornillo</small></button>
    <button data-a="dup">Duplicar esta pieza</button>
    <button data-a="save-file">Descargar proyecto (.json)<small>Para guardarlo o pasarlo a otro equipo</small></button>
    <button data-a="load-file">Cargar proyecto (.json)…</button>
  </div></div>
  <div class="menu" id="m-export"><button class="btn primary">Exportar ▾</button><div class="menu-list">
    <button data-f="3mf">3MF<small>Para Bambu Studio, Orca, Prusa (recomendado)</small></button>
    <button data-f="stl">STL<small>Para cualquier programa de impresión</small></button>
    <button data-f="step">STEP<small>Para Rhino, Fusion, FreeCAD…</small></button>
  </div></div>
</header>
<div class="main">
  <aside class="side">
    <div class="section" id="sec-add"><h3>Añadir</h3><div class="tools" id="tools"></div></div>
    <div class="section grow" id="sec-steps"><h3>Pasos <span class="empty" id="buildtime"></span></h3><ul class="tree" id="tree"></ul></div>
    <div class="section vars" id="sec-vars"><h3>Variables <button class="btn small" id="addvar">+ Añadir</button></h3><div id="vars"></div></div>
  </aside>
  <section class="view" id="view">
    <div class="viewbar">
      <div class="vb-tools">
        <button class="btn small rbtn" id="measure" title="Medir distancias entre dos puntos"><i>📏</i><span>Medir</span></button>
        <button class="btn small rbtn" id="section" title="Cortar la pieza con un plano para ver el interior"><i>✂</i><span>Corte</span></button>
        <button class="btn small rbtn" id="drawing" title="Plano 2D con medidas, para imprimir o guardar en PDF"><i>📐</i><span>Plano</span></button>
      </div>
      <span class="sep"></span>
      <div class="vb-views">
        <button class="btn small rbtn" data-v="fit" title="Encajar la pieza en la pantalla"><i>⛶</i><span>Encajar</span></button>
        <button class="btn small rbtn" data-v="iso" title="Vista 3D"><i>◈</i><span>3D</span></button>
        <button class="btn small rbtn" id="persp" title="Cambia la vista 3D entre perspectiva e isométrica (paralela)"><i>⟁</i><span id="persp-label">Perspectiva</span></button>
        <label class="btn small rbtn mobile-only viewpick" title="Vistas"><i>⊞</i><span>Vistas</span>
          <select id="viewsel" aria-label="Vistas">
            <option value="">Vista…</option><option value="top">Arriba</option><option value="bottom">Abajo</option><option value="front">Frente</option>
            <option value="back">Detrás</option><option value="left">Izquierda</option><option value="right">Derecha</option>
          </select></label>
        <span class="desk-only views"><span class="sep"></span><button class="btn small" data-v="top">Arriba</button>
        <button class="btn small" data-v="bottom">Abajo</button>
        <button class="btn small" data-v="front">Frente</button>
        <button class="btn small" data-v="back">Detrás</button>
        <button class="btn small" data-v="left">Izquierda</button>
        <button class="btn small" data-v="right">Derecha</button></span>
      </div>
    </div>
    <div class="undo-float"><button class="btn" id="undo-m" title="Deshacer">↶</button><button class="btn" id="redo-m" title="Rehacer">↷</button></div>
    <div class="banner" id="banner" hidden></div>
    <div class="secpanel" id="secpanel" hidden></div>
    <div class="sketch" id="sketch">
      <div class="sketchbar" id="sketchbar"></div>
      <div class="sketchhint" id="sketchhint"></div>
    </div>
    <div class="loading" id="loading">Cargando el motor geométrico…</div>
  </section>
  <aside class="side right"><div class="props-in" id="props"></div></aside>
</div>
<nav class="dock" id="dock" aria-label="Paneles">
  <button data-sheet="add"><i>＋</i><span>Añadir</span></button>
  <button data-sheet="steps"><i>☰</i><span>Pasos</span></button>
  <button data-sheet="props"><i>✎</i><span id="dock-props">Tu pieza</span></button>
  <button data-sheet="vars"><i>𝑥</i><span>Variables</span></button>
</nav>
<footer class="status"><span id="st-engine">Motor: cargando</span><span id="st-msg"></span><span class="spacer"></span><span>Unidades: mm</span></footer>
<dialog id="dlg"></dialog>
<input type="file" id="file" accept=".json,application/json" hidden />
<input type="file" id="file3d" accept=".step,.stp,.stl" hidden />
<input type="file" id="filesvg" accept=".svg,image/svg+xml" hidden />
<div id="printarea"></div>
`;

const viewport = new Viewport($("#view"));
const sketcher = new SketchEditor($("#sketch"), {
  onChange: (commit) => changed(commit),
  onSelect: () => { renderProps(); renderSketchBar(); },
  ev: (e) => evaluate(e, resolved.vars),
});

// ======================================================================
// Motor (trabajador en segundo plano)
// ======================================================================

const worker = new Worker(new URL("./cad.worker.ts", import.meta.url), { type: "module" });
const exportWaiters = new Map<number, (m: Extract<WorkerOut, { kind: "exported" }>) => void>();
const drawingWaiters = new Map<number, (m: Extract<WorkerOut, { kind: "drawing" }>) => void>();

worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data;
  if (m.kind === "ready") {
    engineReady = true;
    $("#loading").remove();
    $("#st-engine").textContent = "Motor: listo";
    rebuild();
  } else if (m.kind === "fatal") {
    $("#loading").textContent = "No se pudo cargar el motor: " + m.message;
  } else if (m.kind === "built") {
    if (m.seq !== seq) return;
    build = m;
    const key = active ? JSON.stringify(m.bodiesBefore[active] ?? []) : "";
    if (key !== lastBodiesKey) {
      lastBodiesKey = key;
      // la lista de cuerpos cambió: rehacer el panel si no estás escribiendo en él
      if (!$("#props").contains(document.activeElement)) renderProps();
    }
    viewport.setBodies(m.bodies, doc.colors ?? {});
    if (section) viewport.setSection(section);
    renderPieceInfo();
    $("#buildtime").textContent = `${m.ms} ms`;
    renderTree();
    renderMarks();
    renderFeatureError();
    sendSketchReference(m);
    const nErr = Object.keys(m.errors).length + Object.keys(resolved.fieldErrors).length;
    const st = $("#st-msg");
    st.textContent = nErr ? `${nErr} aviso${nErr > 1 ? "s" : ""}: revisa los pasos en rojo` : `${m.bodies.length} cuerpo${m.bodies.length === 1 ? "" : "s"}`;
    st.className = nErr ? "bad" : "";
  } else if (m.kind === "file") {
    if (m.error) toast("No se pudo leer el archivo: " + m.error);
    else if (m.triangles) toast(`Archivo leído (${m.triangles} triángulos)`);
  } else if (m.kind === "drawing") {
    drawingWaiters.get(m.seq)?.(m);
    drawingWaiters.delete(m.seq);
  } else if (m.kind === "exported") {
    exportWaiters.get(m.seq)?.(m);
    exportWaiters.delete(m.seq);
  }
};

/** Pasos que, mientras los editas, muestran la pieza como estaba antes de ellos */
const BEFORE_TYPES = new Set<Feature["type"]>(["fillet", "chamfer", "sketch", "shell", "hole", "rod", "text", "layflat"]);
const FACE_PICK_TYPES = new Set<Feature["type"]>(["shell", "hole", "rod", "text", "layflat"]);

/** Archivos importados que el motor ya tiene */
const sentFiles = new Set<string>();
async function sendFiles() {
  for (const f of doc.features) {
    if (f.type !== "import" || !f.file || sentFiles.has(f.file)) continue;
    sentFiles.add(f.file);
    const st = await files.get(f.file);
    if (!st) { sentFiles.delete(f.file); continue; }
    worker.postMessage({ kind: "file", id: f.file, format: st.format, data: st.data });
  }
}

let rebuildTimer = 0;
function rebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    resolved = resolveDoc(doc);
    renderSketchLines();
    if (!engineReady) return;
    void sendFiles();
    const f = doc.features.find((x) => x.id === active);
    // al editar un boceto o un redondeo se ve la pieza como estaba antes de ese paso
    const upTo = f && BEFORE_TYPES.has(f.type) ? f.id : undefined;
    worker.postMessage({ kind: "build", seq: ++seq, features: resolved.features, upTo });
  }, 90);
}

// ======================================================================
// Cambios, deshacer y guardado
// ======================================================================

let saveTimer = 0;
function changed(commit = true, structural = false) {
  rebuild();
  if (structural) { renderTree(); renderProps(); }
  if (commit) {
    history.push(JSON.stringify(doc));
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => storage.save(docId, doc), 300);
    renderUndo();
  }
  const af = doc.features.find((f) => f.id === active);
  if (af?.type === "sketch") {
    // cualquier cambio (también desde el panel) vuelve a cumplir las restricciones
    if (af.constraints?.length && !solveSketch(af, (e) => evaluate(e, resolved.vars))) toast("Hay restricciones que no se pueden cumplir: quita alguna (clic en su símbolo)");
    sketcher.render();
    // al soltar un punto, que el panel muestre los números nuevos (si no estás escribiendo en él)
    if (commit && !$("#props").contains(document.activeElement)) renderProps();
  }
}

function setDoc(d: Doc, id = docId, resetHistory = true) {
  doc = d;
  docId = id;
  active = null;
  resolved = resolveDoc(doc);
  sketcher.close();
  if (resetHistory) history.reset(JSON.stringify(doc));
  storage.save(docId, doc);
  viewport.refit();
  renderAll();
  rebuild();
}

function undoRedo(which: "undo" | "redo") {
  const s = which === "undo" ? history.undo() : history.redo();
  if (!s) return;
  doc = JSON.parse(s);
  resolved = resolveDoc(doc);
  if (active && !doc.features.some((f) => f.id === active)) active = null;
  storage.save(docId, doc);
  renderAll();
  rebuild();
}

function renderUndo() {
  ($("#undo") as HTMLButtonElement).disabled = !history.canUndo;
  ($("#redo") as HTMLButtonElement).disabled = !history.canRedo;
  ($("#undo-m") as HTMLButtonElement).disabled = !history.canUndo;
  ($("#redo-m") as HTMLButtonElement).disabled = !history.canRedo;
}

// ======================================================================
// Panel izquierdo: añadir, pasos, variables
// ======================================================================

const ADD: { type: Feature["type"]; key?: string }[] = [
  { type: "sketch" }, { type: "extrude" }, { type: "revolve" }, { type: "fillet" },
  { type: "box" }, { type: "cylinder" }, { type: "sphere" }, { type: "chamfer" },
  { type: "gear" }, { type: "spring" },
  { type: "shell" }, { type: "pattern" }, { type: "hole" }, { type: "rod" },
  { type: "sweep" }, { type: "loft" }, { type: "text" }, { type: "import" },
  { type: "component" }, { type: "layflat" },
];
const ADD_LABEL: Partial<Record<Feature["type"], string>> = {
  extrude: "Extruir", revolve: "Revolución", hole: "Agujeros", rod: "Varilla", loft: "Transición", import: "Importar",
  component: "Pieza", layflat: "Apoyar",
};
const ADD_TITLE: Partial<Record<Feature["type"], string>> = {
  sweep: "Un perfil que recorre un camino (tubos, asas, muelles…)",
  loft: "Transición suave entre dos o más bocetos (de cuadrado a círculo…)",
  text: "Letras en relieve o grabadas",
  import: "Traer una pieza STEP o STL de otro programa",
  component: "Meter aquí una de tus piezas guardadas, con sus medidas cambiables",
  layflat: "Girar la pieza para apoyarla sobre una cara al imprimir",
  gear: "Rueda dentada recta: eliges el módulo y los dientes",
  spring: "Muelle de compresión: diámetro, hilo, paso y vueltas",
};

function renderTools() {
  const box = $("#tools");
  box.innerHTML = "";
  const hasSketch = doc.features.some((f) => f.type === "sketch");
  const hasBody = !!build?.bodies.length;
  for (const t of ADD) {
    const needSketch = t.type === "extrude" || t.type === "revolve" || t.type === "sweep" || t.type === "loft";
    const needBody = ["fillet", "chamfer", "shell", "pattern", "hole", "rod", "layflat"].includes(t.type);
    box.append(h("button", {
      class: "tool",
      disabled: (needSketch && !hasSketch) || (needBody && !hasBody),
      title: needSketch && !hasSketch ? "Primero haz un boceto" : needBody && !hasBody ? "Primero crea un sólido" : ADD_TITLE[t.type] ?? "",
      onclick: () => (t.type === "import" ? $("#file3d").click() : t.type === "component" ? componentDialog() : addFeature(t.type)),
    }, h("b", {}, FEATURE_ICON[t.type]), ADD_LABEL[t.type] ?? FEATURE_LABEL[t.type]));
  }
}

function addFeature(type: Feature["type"]) {
  const f = newFeature(doc, type);
  doc.features.push(f);
  setActive(f.id);
  changed(true, true);
}

function setActive(id: string | null) {
  active = id;
  pickingFace = false;
  const f = doc.features.find((x) => x.id === id);
  if (f?.type === "sketch") {
    $("#sketch").classList.add("on");
    sketcher.open(f);
    renderSketchBar();
  } else {
    $("#sketch").classList.remove("on");
    sketcher.close();
  }
  if (measuring) stopMeasure();
  viewport.pickMode = f?.type === "fillet" || f?.type === "chamfer" ? (pickFacesForEdges ? "face" : "edge") : f && FACE_PICK_TYPES.has(f.type) ? "face" : "none";
  renderTree();
  renderProps();
  renderBanner();
  rebuild();
  // en el móvil: al editar un paso se abre su panel; en un boceto, la pantalla entera para dibujar
  document.body.classList.toggle("sketching", f?.type === "sketch");
  $("#dock-props").textContent = f ? "Editar" : "Tu pieza";
  if (isMobile()) {
    if (f?.type === "sketch") setSheet(null);
    else if (f) setSheet("props");
    else if (sheet === "props") setSheet(null);
  }
}

// ---------- móvil: paneles que suben desde abajo ----------
function setSheet(name: string | null) {
  sheet = name;
  for (const n of ["add", "steps", "props", "vars"]) document.body.classList.toggle(`sheet-${n}`, n === name);
  document.body.classList.toggle("sheet-open", !!name);
  document.querySelectorAll<HTMLElement>("#dock [data-sheet]").forEach((b) => b.classList.toggle("on", b.dataset.sheet === name));
  if (name) {
    (name === "props" ? $("#props") : $(`#sec-${name}`)).scrollTop = 0;
  }
}
document.querySelectorAll<HTMLElement>("#dock [data-sheet]").forEach((b) => b.addEventListener("click", () => setSheet(sheet === b.dataset.sheet ? null : b.dataset.sheet!)));

function renderTree() {
  renderTools();
  const ul = $("#tree");
  ul.innerHTML = "";
  if (!doc.features.length) {
    ul.append(h("li", { class: "empty" }, "Empieza con un boceto o una caja."));
    return;
  }
  doc.features.forEach((f, i) => {
    const err = build?.errors[f.id] || Object.keys(resolved.fieldErrors).some((k) => k.startsWith(f.id + ":"));
    const li = h("li", {
      class: `${f.id === active ? "active" : ""} ${f.off ? "off" : ""}`,
      title: typeof err === "string" ? err : err ? "Hay una medida que no se entiende" : "",
      onclick: () => setActive(f.id === active ? null : f.id),
    },
      h("span", { class: "ic" }, FEATURE_ICON[f.type]),
      h("span", { class: "nm" }, f.name),
      err ? h("span", { class: "err" }, "!") : null,
      h("button", { class: "act", title: "Subir", onclick: (e: Event) => { e.stopPropagation(); move(i, -1); } }, "↑"),
      h("button", { class: "act", title: f.off ? "Encender" : "Apagar (saltar este paso)", onclick: (e: Event) => { e.stopPropagation(); f.off = !f.off; changed(true, true); } }, f.off ? "◌" : "◉"),
      h("button", { class: "act", title: "Borrar", onclick: (e: Event) => { e.stopPropagation(); removeFeature(f.id); } }, "✕"),
    );
    ul.append(li);
  });
}

function move(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= doc.features.length) return;
  const [f] = doc.features.splice(i, 1);
  doc.features.splice(j, 0, f);
  changed(true, true);
}

function removeFeature(id: string) {
  const users = doc.features.filter((f) => sketchUses(f).includes(id));
  if (users.length && !confirmInline(`Este boceto lo usa «${users.map((u) => u.name).join(", ")}». ¿Borrarlo igualmente?`)) return;
  doc.features = doc.features.filter((f) => f.id !== id);
  if (active === id) setActive(null);
  changed(true, true);
}

/** Bocetos que usa un paso */
function sketchUses(f: Feature): string[] {
  if (f.type === "extrude" || f.type === "revolve") return [f.sketch];
  if (f.type === "sweep") return [f.sketch, f.path];
  if (f.type === "loft") return f.sketches;
  return [];
}

// confirm() del navegador es suficiente aquí y se puede deshacer con Ctrl+Z
const confirmInline = (q: string) => window.confirm(q);

function renderVars() {
  const box = $("#vars");
  box.innerHTML = "";
  if (!doc.variables.length) box.append(h("div", { class: "empty" }, "Ponle nombre a una medida (p. ej. grosor = 3) y úsala en cualquier campo."));
  doc.variables.forEach((v, i) => {
    const err = resolved.varErrors[v.name];
    const nameIn = h("input", { value: v.name, placeholder: "nombre", class: VAR_NAME.test(v.name) ? "" : "bad" }) as HTMLInputElement;
    const valIn = h("input", { value: v.value, placeholder: "valor", class: err ? "bad" : "" }) as HTMLInputElement;
    nameIn.addEventListener("change", () => {
      const old = v.name;
      v.name = nameIn.value.trim();
      if (old && VAR_NAME.test(v.name)) renameVarUses(old, v.name);
      changed(true);
      renderVars();
    });
    valIn.addEventListener("input", () => { v.value = valIn.value; changed(false); });
    valIn.addEventListener("change", () => { changed(true); renderVars(); renderProps(); });
    const row = h("div", { class: "var" }, nameIn, valIn,
      h("button", { class: "btn small", title: "Quitar", onclick: () => { doc.variables.splice(i, 1); changed(true); renderVars(); } }, "✕"),
      h("div", { class: "eq" }, err ? `⚠ ${err}` : `= ${fmt(resolved.vars[v.name] ?? 0)} mm`));
    box.append(row);
  });
}

/** Si cambias el nombre de una variable, se cambia en todas las medidas que la usan */
function renameVarUses(old: string, nu: string) {
  const re = new RegExp(`(?<![\\wáéíóúñÁÉÍÓÚÑ])${old}(?![\\wáéíóúñÁÉÍÓÚÑ])`, "g");
  const walk = (o: unknown): unknown => {
    if (typeof o === "string") return o.replace(re, nu);
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) out[k] = ["id", "name", "type", "sketch", "target", "path", "sketches", "text", "file", "fileName", "source", "sourceId", "resolved"].includes(k) ? v : walk(v);
      return out;
    }
    return o;
  };
  doc.features = walk(doc.features) as Feature[];
  doc.variables = doc.variables.map((v) => ({ ...v, value: v.value.replace(re, nu) }));
}

// ======================================================================
// Panel derecho: propiedades
// ======================================================================

function exprField(label: string, get: () => string, set: (v: string) => void, errKey: string, opts: { unit?: string; hint?: string } = {}) {
  const input = h("input", { value: get(), spellcheck: "false" }) as HTMLInputElement;
  const val = h("div", { class: "val" });
  const show = () => {
    try {
      const n = evaluate(input.value, resolved.vars);
      input.classList.remove("bad");
      val.className = "val";
      val.textContent = /^-?[\d.,]+$/.test(input.value.trim()) ? (opts.hint ?? "") : `= ${fmt(n)}${opts.unit ?? " mm"}`;
    } catch (e) {
      input.classList.add("bad");
      val.className = "val bad";
      val.textContent = (e as Error).message;
    }
  };
  input.addEventListener("input", () => { set(input.value); show(); changed(false); });
  input.addEventListener("change", () => changed(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // flechas: sube o baja 1 (con Mayús, 10)
      try {
        const n = evaluate(input.value, resolved.vars) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
        input.value = fmt(n); set(input.value); show(); changed(true);
        e.preventDefault();
      } catch { /* nada */ }
    }
  });
  show();
  void errKey;
  return h("div", { class: "field" }, h("label", {}, label), input, val);
}

function selectField(label: string, value: string, options: [string, string][], set: (v: string) => void) {
  const sel = h("select", {}, ...options.map(([v, t]) => h("option", { value: v, ...(v === value ? { selected: true } : {}) }, t))) as HTMLSelectElement;
  sel.value = value;
  sel.addEventListener("change", () => { set(sel.value); changed(true, true); });
  return h("div", { class: "field" }, h("label", {}, label), sel);
}

function checkField(label: string, value: boolean, set: (v: boolean) => void) {
  const c = h("input", { type: "checkbox", checked: value }) as HTMLInputElement;
  c.addEventListener("change", () => { set(c.checked); changed(true, true); });
  return h("label", { class: "check" }, c, label);
}

function textField(label: string, value: string, set: (v: string) => void) {
  const input = h("input", { value }) as HTMLInputElement;
  input.addEventListener("change", () => { set(input.value.trim() || value); changed(true, true); });
  return h("div", { class: "field" }, h("label", {}, label), input);
}

function opFields(f: Extract<Feature, { op: string }>) {
  const idx = doc.features.indexOf(f);
  const before = build?.bodiesBefore[f.id] ?? [];
  const els: HTMLElement[] = [
    selectField("Resultado", f.op, [["new", "Cuerpo nuevo"], ["add", "Sumar"], ["cut", "Restar"], ["intersect", "Intersecar"]], (v) => (f.op = v as never)),
  ];
  if (f.op !== "new" && before.length > 1) {
    els.push(selectField("Sobre", f.target ?? "", [["", "El último cuerpo"], ...before.map((b) => [b.id, b.name] as [string, string])], (v) => (f.target = v || undefined)));
  }
  void idx;
  return els;
}

const fmtEs = (n: number, d = 1) => n.toLocaleString("es-ES", { maximumFractionDigits: d, minimumFractionDigits: d });

/** Volumen, tamaño, peso y filamento de la pieza (se ve cuando no hay ningún paso elegido) */
function renderPieceInfo() {
  const box = document.getElementById("piece-info");
  if (!box) { viewport.setCheck(null); return; }
  box.innerHTML = "";
  box.append(h("h3", {}, "Tu pieza"));
  const bodies = build?.bodies ?? [];
  if (!bodies.length) { box.append(h("div", { class: "empty" }, "Todavía no hay ningún sólido.")); return; }
  let vol = 0, area = 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    vol += b.volume || 0; area += b.area || 0;
    const v = b.vertices;
    for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[i + k]); mx[k] = Math.max(mx[k], v[i + k]); }
  }
  const cm3 = vol / 1000;
  const row = (label: string, value: string) => h("div", { class: "info-row" }, h("span", {}, label), h("b", {}, value));
  box.append(
    row("Tamaño", `${fmtEs(mx[0] - mn[0])} × ${fmtEs(mx[1] - mn[1])} × ${fmtEs(mx[2] - mn[2])} mm`),
    row("Volumen", `${fmtEs(cm3, 2)} cm³`),
    row("Superficie", `${fmtEs(area / 100, 1)} cm²`),
    row("Peso en PLA", `${fmtEs(cm3 * 1.24)} g`),
    row("Peso en PETG", `${fmtEs(cm3 * 1.27)} g`),
    // filamento de 1,75 mm: sección de 2,405 mm²
    row("Filamento 1,75 mm", `${fmtEs(vol / 2.405 / 1000, 2)} m`),
    h("div", { class: "empty" }, "Calculado como si se imprimiera maciza (100 % de relleno). Con el relleno normal de tu laminador gastará bastante menos."),
  );
  if (bodies.length > 1) box.append(h("div", { class: "empty" }, `Suma de ${bodies.length} cuerpos.`));
  renderColors(box, bodies);
  renderPrintCheck(box);
}

// ---------- colores por cuerpo ----------
const DEFAULT_COLOR = "#9aa7b8";
const PALETTE = ["#e8743b", "#3b7dd8", "#4cae4c", "#d9b43b", "#8a4fd8", "#22201c", "#f4f2ee", "#c8402f"];
function renderColors(box: HTMLElement, bodies: { id: string; name: string }[]) {
  box.append(h("h3", { class: "mt" }, "Colores",
    doc.colors && Object.keys(doc.colors).length ? h("button", { class: "btn small", onclick: () => { delete doc.colors; changed(true); renderPieceInfo(); } }, "Quitar") : null));
  bodies.forEach((b, i) => {
    const input = h("input", { type: "color", value: doc.colors?.[b.id] ?? DEFAULT_COLOR, title: "Color de este cuerpo" }) as HTMLInputElement;
    input.addEventListener("input", () => {
      (doc.colors ??= {})[b.id] = input.value;
      viewport.setBodies(build?.bodies ?? [], doc.colors);
      if (section) viewport.setSection(section);
    });
    input.addEventListener("change", () => changed(true));
    const quick = h("button", { class: "btn small", title: "Poner un color distinto", onclick: () => {
      (doc.colors ??= {})[b.id] = PALETTE[i % PALETTE.length];
      changed(true); renderPieceInfo();
    } }, "↻");
    box.append(h("div", { class: "color-row" }, input, h("span", { class: "grow" }, b.name), quick));
  });
  box.append(h("div", { class: "empty" }, "Cada cuerpo sale como un objeto aparte en el 3MF, con su color. En Bambu Studio u Orca asígnale después el filamento del AMS a cada objeto (el color guardado sirve de guía; no todos los laminadores lo leen)."));
}

// ---------- vista de corte ----------
let section: { axis: 0 | 1 | 2; at: number; flip: boolean } | null = null;
function renderSection() {
  const p = $("#secpanel");
  $("#section").classList.toggle("on", !!section);
  p.hidden = !section;
  p.innerHTML = "";
  if (!section) { viewport.setSection(null); return; }
  const s = section;
  const axBtn = (ax: 0 | 1 | 2, label: string) => h("button", { class: `btn small ${s.axis === ax ? "on" : ""}`, onclick: () => { s.axis = ax; renderSection(); } }, label);
  const range = h("input", { type: "range", min: "0", max: "1000", value: String(Math.round(s.at * 1000)), title: "Dónde corta" }) as HTMLInputElement;
  range.addEventListener("input", () => { s.at = Number(range.value) / 1000; viewport.setSection(s); });
  p.append(
    h("b", {}, "Corte"), axBtn(0, "X"), axBtn(1, "Y"), axBtn(2, "Z"), range,
    h("button", { class: "btn small", title: "Ver el otro lado", onclick: () => { s.flip = !s.flip; renderSection(); } }, "⇄"),
    h("button", { class: "btn small", title: "Quitar el corte", onclick: () => { section = null; renderSection(); } }, "✕"),
  );
  viewport.setSection(s);
}
$("#section").addEventListener("click", () => { section = section ? null : { axis: 1, at: 0.5, flip: true }; renderSection(); });

// ---------- comprobación para imprimir ----------
const PRINT_KEY = "geometria:impresion";
let printOn = false;
let printSt: PrintSettings = { ...DEFAULT_PRINT };
try { printSt = { ...DEFAULT_PRINT, ...JSON.parse(localStorage.getItem(PRINT_KEY) || "{}") }; } catch { /* sin almacenamiento */ }

function renderPrintCheck(box: HTMLElement) {
  box.append(h("h3", { class: "mt" }, "Para imprimir",
    h("button", { class: `btn small ${printOn ? "on" : ""}`, onclick: () => { printOn = !printOn; renderPieceInfo(); } }, printOn ? "Ocultar" : "Comprobar")));
  const bodies = build?.bodies ?? [];
  if (!printOn || !bodies.length) { viewport.setCheck(null); return; }
  const r = checkPrint(bodies, printSt);
  const ok = (good: boolean, text: string) => h("div", { class: `msg ${good ? "info" : "err"}` }, (good ? "✓ " : "⚠ ") + text);
  box.append(ok(r.fits, r.fits
    ? `Cabe en la cama (${printSt.bedX} × ${printSt.bedY} × ${printSt.bedZ} mm).`
    : r.fitsRotated ? "No cabe así, pero sí girándola 90° en la cama." : `No cabe en la cama de ${printSt.bedX} × ${printSt.bedY} × ${printSt.bedZ} mm.`));
  if (Math.abs(r.floating) > 0.01) box.append(ok(false, `La parte más baja está en Z = ${fmtEs(r.floating, 2)}, no en la cama. El laminador la bajará, pero usa «Apoyar» para elegir la cara.`));
  box.append(ok(r.overhangArea < 1, r.overhangArea < 1
    ? `Sin voladizos de más de ${printSt.maxOverhang}°.`
    : `Voladizos de más de ${printSt.maxOverhang}° (en rojo): ${fmtEs(r.overhangArea / 100, 1)} cm². Necesitarán soportes o girar la pieza.`));
  box.append(ok(r.thinArea < 0.5, r.thinArea < 0.5
    ? `Sin paredes de menos de ${fmtEs(printSt.minWall, 1)} mm${r.sampled ? " (mirado en una muestra)" : ""}.`
    : `Paredes de menos de ${fmtEs(printSt.minWall, 1)} mm (en morado): ${fmtEs(r.thinArea, 0)} mm². Pueden salir huecas o romperse.`));
  if (!doc.features.some((x) => x.type === "layflat")) {
    box.append(h("button", { class: "btn small", onclick: () => { const f = newFeature(doc, "layflat"); doc.features.push(f); changed(true, true); toast("Apoyada sobre su cara más grande"); } }, "⤓ Apoyar sobre la cara más grande"));
  }
  // ajustes de la impresora
  const num = (label: string, key: keyof PrintSettings, unit: string) => {
    const i = h("input", { value: String(printSt[key]), inputmode: "decimal" }) as HTMLInputElement;
    i.addEventListener("change", () => {
      const v = Number(i.value.replace(",", "."));
      if (!(v > 0)) { i.classList.add("bad"); return; }
      printSt = { ...printSt, [key]: v };
      try { localStorage.setItem(PRINT_KEY, JSON.stringify(printSt)); } catch { /* nada */ }
      renderPieceInfo();
    });
    return h("div", { class: "field" }, h("label", {}, `${label} (${unit})`), i);
  };
  const det = h("details", { class: "mt" }, h("summary", {}, "Ajustes de tu impresora"),
    num("Cama X", "bedX", "mm"), num("Cama Y", "bedY", "mm"), num("Alto", "bedZ", "mm"),
    num("Pared mínima", "minWall", "mm"), num("Voladizo máx.", "maxOverhang", "°"),
    h("div", { class: "empty" }, "Por defecto, la cama de 256 mm de las Bambu A1, P1 y X1. Pon la de tu impresora."));
  box.append(det);
  viewport.setCheck({
    layers: [{ tris: r.overhangTris, color: "#d9452b" }, { tris: r.thinTris, color: "#8a4fd8" }],
    bed: [printSt.bedX, printSt.bedY, printSt.bedZ],
  });
}

function renderProps() {
  const box = $("#props");
  box.innerHTML = "";
  const f = doc.features.find((x) => x.id === active);
  if (!f) {
    box.append(h("div", { class: "section", id: "piece-info" }));
    renderPieceInfo();
    box.append(h("div", { class: "section" },
      h("h3", {}, "Cómo se usa"),
      h("div", { class: "msg info" }, "1. Haz un ", h("b", {}, "Boceto"), " (dibujo 2D con medidas)."),
      h("div", { class: "msg info" }, "2. Conviértelo en sólido con ", h("b", {}, "Extruir"), " o ", h("b", {}, "Revolución"), "."),
      h("div", { class: "msg info" }, "3. Suma o resta piezas, redondea aristas y exporta a 3MF para imprimir."),
      h("div", { class: "msg info" }, "Cada paso queda en la lista: haz clic en uno para cambiar sus medidas y todo se recalcula."),
      ...(sketcher.coarse
        ? [h("h3", { class: "mt" }, "Con el dedo"), h("div", { class: "empty" }, "Un dedo: girar · dos dedos: zoom y desplazar · abajo tienes Añadir, Pasos, Editar y Variables")]
        : [h("h3", { class: "mt" }, "Ratón"), h("div", { class: "empty" }, "Botón izquierdo: girar · derecho: desplazar · rueda: zoom")]),
    ));
    return;
  }
  const sec = h("div", { class: "section" }, h("h3", {}, `${FEATURE_ICON[f.type]} ${FEATURE_LABEL[f.type]}`));
  box.append(sec);
  sec.append(h("div", { id: "feat-err" }));
  renderFeatureError();
  sec.append(textField("Nombre", f.name, (v) => (f.name = v)));

  const k = (field: string) => `${f.id}:${field}`;
  switch (f.type) {
    case "sketch": renderSketchProps(sec, f); break;
    case "extrude":
    case "revolve": {
      const sketches = doc.features.slice(0, doc.features.indexOf(f)).filter((x): x is SketchFeature => x.type === "sketch");
      sec.append(selectField("Boceto", f.sketch, [["", "— elige —"], ...sketches.map((s) => [s.id, s.name] as [string, string])], (v) => (f.sketch = v)));
      if (f.type === "extrude") {
        sec.append(exprField("Distancia", () => f.distance, (v) => (f.distance = v), k("distance")));
        sec.append(checkField("Hacia el otro lado", f.reverse, (v) => (f.reverse = v)));
        sec.append(checkField("Simétrica (mitad a cada lado)", f.symmetric, (v) => (f.symmetric = v)));
      } else {
        sec.append(selectField("Eje", f.axis, [["y", "Eje vertical del boceto (Y)"], ["x", "Eje horizontal del boceto (X)"]], (v) => (f.axis = v as "x" | "y")));
        sec.append(exprField("Ángulo", () => f.angle, (v) => (f.angle = v), k("angle"), { unit: "°" }));
        sec.append(h("div", { class: "empty" }, "Gira el boceto alrededor de su eje X o Y (las líneas roja y verde del boceto)."));
      }
      sec.append(...opFields(f));
      break;
    }
    case "box":
    case "cylinder":
    case "sphere": {
      if (f.type === "box") {
        sec.append(exprField("Ancho (X)", () => f.w, (v) => (f.w = v), k("w")));
        sec.append(exprField("Fondo (Y)", () => f.d, (v) => (f.d = v), k("d")));
        sec.append(exprField("Alto (Z)", () => f.h, (v) => (f.h = v), k("h")));
      } else {
        sec.append(exprField("Radio", () => f.r, (v) => (f.r = v), k("r")));
        if (f.type === "cylinder") sec.append(exprField("Alto (Z)", () => f.h, (v) => (f.h = v), k("h")));
      }
      sec.append(h("h3", { class: "mt" }, f.type === "box" ? "Esquina" : "Centro de la base"));
      sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x")));
      sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
      sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z")));
      sec.append(...opFields(f));
      break;
    }
    case "gear": {
      sec.append(exprField("Dientes", () => f.teeth, (v) => (f.teeth = v), k("teeth")));
      sec.append(exprField("Módulo", () => f.module, (v) => (f.module = v), k("module"), { hint: "tamaño del diente; dos ruedas engranan si tienen el mismo" }));
      sec.append(exprField("Grosor", () => f.thickness, (v) => (f.thickness = v), k("thickness")));
      sec.append(exprField("Agujero del eje", () => f.bore, (v) => (f.bore = v), k("bore"), { hint: "diámetro; 0 = sin agujero" }));
      sec.append(exprField("Holgura", () => f.fit, (v) => (f.fit = v), k("fit"), { hint: "juego entre dientes; 0,2 va bien impreso" }));
      sec.append(exprField("Giro", () => f.angle, (v) => (f.angle = v), k("angle"), { unit: "°" }));
      const r = resolved.features.find((x) => x.id === f.id) as Resolved<GearFeature> | undefined;
      if (r && r.module > 0 && r.teeth > 0) sec.append(h("div", { class: "msg info" },
        `Diámetro primitivo ${fmtEs(r.module * r.teeth, 2)} mm · exterior ${fmtEs(r.module * (r.teeth + 2), 2)} mm. Para que engrane con otra rueda de N dientes, sepáralas ${fmtEs(r.module / 2, 2)} × (${r.teeth} + N) mm entre centros.`));
      sec.append(h("h3", { class: "mt" }, "Centro de la base"));
      sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x")));
      sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
      sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z")));
      sec.append(...opFields(f));
      break;
    }
    case "spring": {
      sec.append(exprField("Diámetro exterior", () => f.diameter, (v) => (f.diameter = v), k("diameter")));
      sec.append(exprField("Hilo", () => f.wire, (v) => (f.wire = v), k("wire"), { hint: "grosor del alambre; impreso, 1,2 mm o más" }));
      sec.append(exprField("Paso", () => f.pitch, (v) => (f.pitch = v), k("pitch"), { hint: "distancia entre vueltas" }));
      sec.append(exprField("Vueltas", () => f.turns, (v) => (f.turns = v), k("turns")));
      sec.append(checkField("Puntas planas (apoya bien)", f.flat, (v) => (f.flat = v)));
      sec.append(h("h3", { class: "mt" }, "Centro de la base"));
      sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x")));
      sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
      sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z")));
      sec.append(...opFields(f));
      break;
    }
    case "fillet":
    case "chamfer": {
      sec.append(exprField(f.type === "fillet" ? "Radio" : "Distancia", () => f.size, (v) => (f.size = v), k("size")));
      sec.append(h("div", { class: "seg-btns" },
        h("button", { class: `btn small ${pickFacesForEdges ? "" : "on"}`, onclick: () => { pickFacesForEdges = false; setActive(f.id); } }, "Elegir aristas"),
        h("button", { class: `btn small ${pickFacesForEdges ? "on" : ""}`, onclick: () => { pickFacesForEdges = true; setActive(f.id); } }, "Elegir caras enteras"),
      ));
      sec.append(h("div", { class: "msg info" }, pickFacesForEdges
        ? `Clic en una cara: se ${f.type === "fillet" ? "redondean" : "achaflanan"} todas sus aristas (otro clic la quita). Caras: ${f.faces?.length ?? 0}.`
        : `Haz clic en las aristas de la vista 3D para elegirlas (otro clic la quita). Aristas: ${f.edges.length}.`));
      if (f.edges.length || f.faces?.length) sec.append(h("button", { class: "btn small", onclick: () => { f.edges = []; delete f.sizes; delete f.faces; changed(true, true); renderMarks(); } }, "Quitar todas"));
      if (f.edges.length) {
        sec.append(h("h3", { class: "mt" }, "Medida de cada arista"));
        sec.append(h("div", { class: "empty" }, "Vacío = la medida general. Así puedes poner radios distintos."));
        f.edges.forEach((_, i) => {
          const inp = exprInline(() => f.sizes?.[i] ?? "", (v) => { const a = (f.sizes ??= []); while (a.length < f.edges.length) a.push(""); a[i] = v; });
          inp.placeholder = f.size;
          sec.append(h("div", { class: "field" }, h("label", {}, `Arista ${i + 1}`),
            h("div", { class: "row-pt" }, inp, h("span"),
              h("button", { class: "btn small", title: "Quitar", onclick: () => { f.edges.splice(i, 1); f.sizes?.splice(i, 1); changed(true, true); renderMarks(); } }, "✕"))));
        });
      }
      sec.append(h("div", { class: "empty mt" }, "Mientras editas este paso ves la pieza como estaba antes de él. Pulsa «Hecho» para ver el resultado."));
      break;
    }
    case "shell": {
      sec.append(exprField("Grosor pared", () => f.thickness, (v) => (f.thickness = v), k("thickness")));
      sec.append(h("div", { class: "msg info" }, `Haz clic en la cara (o caras) que quedan abiertas; otro clic la quita. Elegidas: ${f.faces.length}.`));
      if (f.faces.length) sec.append(h("button", { class: "btn small", onclick: () => { f.faces = []; changed(true, true); } }, "Quitar todas"));
      sec.append(h("div", { class: "empty mt" }, "Las paredes crecen hacia dentro, así que la medida de fuera no cambia."));
      break;
    }
    case "pattern": renderPatternProps(sec, f); break;
    case "hole":
    case "rod": renderHoleProps(sec, f); break;
    case "text": renderTextProps(sec, f); break;
    case "sweep": renderSweepProps(sec, f); break;
    case "loft": renderLoftProps(sec, f); break;
    case "import": renderImportProps(sec, f); break;
    case "layflat": renderLayFlatProps(sec, f); break;
    case "component": renderComponentProps(sec, f); break;
  }
  sec.append(h("div", { class: "actions" },
    h("button", { class: "btn primary", onclick: () => setActive(null) }, "Hecho"),
  ));
}

function renderPatternProps(sec: HTMLElement, f: PatternFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  const idx = doc.features.indexOf(f);
  const sources = doc.features.slice(0, idx).filter((x) => ["extrude", "revolve", "box", "cylinder", "sphere", "gear", "spring", "hole", "rod", "pattern", "text", "sweep", "loft", "import"].includes(x.type));
  sec.append(selectField("Tipo", f.kind, [["linear", "En fila / rejilla"], ["circular", "En círculo"], ["path", "A lo largo de un camino"], ["mirror", "Simetría (espejo)"]], (v) => (f.kind = v as PatternKind)));
  sec.append(selectField("Repetir", f.source, [["", "El cuerpo entero"], ...sources.map((s) => [s.id, s.name] as [string, string])], (v) => (f.source = v)));
  const axes: [string, string][] = [["x", "X (rojo)"], ["y", "Y (verde)"], ["z", "Z (azul)"]];
  if (f.kind === "linear") {
    sec.append(selectField("Dirección", f.axis, axes, (v) => (f.axis = v as Axis)));
    sec.append(exprField("Cantidad", () => f.count, (v) => (f.count = v), k("count"), { unit: " en total" }));
    sec.append(exprField("Separación", () => f.spacing, (v) => (f.spacing = v), k("spacing"), { hint: "negativa = hacia el otro lado" }));
    sec.append(h("h3", { class: "mt" }, "Segunda dirección (rejilla)"));
    sec.append(selectField("Dirección 2", f.axis2, axes, (v) => (f.axis2 = v as Axis)));
    sec.append(exprField("Cantidad 2", () => f.count2, (v) => (f.count2 = v), k("count2"), { unit: " (1 = sin rejilla)" }));
    sec.append(exprField("Separación 2", () => f.spacing2, (v) => (f.spacing2 = v), k("spacing2")));
  } else if (f.kind === "circular") {
    sec.append(selectField("Eje de giro", f.axis, axes, (v) => (f.axis = v as Axis)));
    sec.append(exprField("Cantidad", () => f.count, (v) => (f.count = v), k("count"), { unit: " en total" }));
    sec.append(exprField("Ángulo total", () => f.angle, (v) => (f.angle = v), k("angle"), { unit: "°", hint: "360 = vuelta completa" }));
    sec.append(h("h3", { class: "mt" }, "Centro del giro"));
    sec.append(exprField("X", () => f.cx, (v) => (f.cx = v), k("cx")));
    sec.append(exprField("Y", () => f.cy, (v) => (f.cy = v), k("cy")));
    sec.append(exprField("Z", () => f.cz, (v) => (f.cz = v), k("cz")));
  } else if (f.kind === "path") {
    const paths = doc.features.slice(0, idx).filter((x) => x.type === "sketch");
    sec.append(selectField("Camino", f.path ?? "", [["", "Elige un boceto…"], ...paths.map((s) => [s.id, s.name] as [string, string])], (v) => (f.path = v)));
    sec.append(exprField("Cantidad", () => f.count, (v) => (f.count = v), k("count"), { unit: " en total", hint: "repartidas a la misma distancia, de punta a punta" }));
    sec.append(checkField("Girar con el camino", !!f.align, (v) => (f.align = v)));
    sec.append(h("div", { class: "empty" }, "El camino es la primera línea abierta del boceto (herramienta «Camino», W) o, si no hay, su primer contorno. La primera copia es el original: ponlo al principio del camino."));
  } else {
    sec.append(selectField("Espejo", f.axis, [["x", "Plano YZ (refleja en X)"], ["y", "Plano XZ (refleja en Y)"], ["z", "Plano XY (refleja en Z)"]], (v) => (f.axis = v as Axis)));
    sec.append(exprField("Posición", () => f.offset, (v) => (f.offset = v), k("offset"), { hint: "dónde está el espejo en ese eje" }));
  }
  sec.append(h("div", { class: "empty mt" }, f.source
    ? "Las copias hacen lo mismo que el original: si era un agujero, restan; si sumaba, suman."
    : "Copia el último cuerpo entero y lo une con las copias."));
}

function renderHoleProps(sec: HTMLElement, f: HoleFeature | RodFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  sec.append(selectField("Métrica", f.size, SCREW_NAMES.map((n) => [n, n] as [string, string]), (v) => (f.size = v)));
  const sc = SCREWS[f.size];
  if (f.type === "hole") {
    sec.append(selectField("Tipo", f.kind, Object.entries(HOLE_KIND_LABEL) as [string, string][], (v) => (f.kind = v as HoleKind)));
    sec.append(checkField("Pasante (atraviesa toda la pieza)", f.through, (v) => (f.through = v)));
    if (!f.through) sec.append(exprField("Profundidad", () => f.depth, (v) => (f.depth = v), k("depth")));
    if (f.kind !== "insert") sec.append(exprField("Holgura", () => f.fit, (v) => (f.fit = v), k("fit"), { hint: "se suma al diámetro; 0,2 va bien en la Bambu" }));
    if (sc) {
      const fit = Number(f.fit.replace(",", ".")) || 0;
      const info: Record<HoleKind, string> = {
        clearance: `Agujero de ${fmt(sc.clearance + fit)} mm.`,
        pilot: `Agujero de ${fmt(sc.pilot + fit)} mm: el tornillo abre su propia rosca en el plástico.`,
        insert: `Agujero de ${fmt(sc.insert)} mm. Profundidad recomendada: ${fmt(sc.insertDepth + 1)} mm.`,
        counterbore: `Paso de ${fmt(sc.clearance + fit)} mm y caja de ${fmt(sc.headCb + 0.6 + fit)} × ${fmt(sc.headCbH + 0.3)} mm.`,
        countersink: `Paso de ${fmt(sc.clearance + fit)} mm y avellanado a 90° de ${fmt(sc.headCs + fit)} mm.`,
        nut: `Hexágono de ${fmt(sc.nutAf + fit)} mm entre caras y ${fmt(sc.nutH + 0.3)} mm de alto, más agujero de paso.`,
        thread: `Rosca ${f.size}×${sc.pitch}. Imprimirla bien pide M6 o más grande; por debajo, mejor inserto o atornillar directo.`,
      };
      sec.append(h("div", { class: "msg info" }, info[f.kind]));
    }
  } else {
    sec.append(exprField("Largo", () => f.length, (v) => (f.length = v), k("length")));
    sec.append(exprField("Holgura", () => f.fit, (v) => (f.fit = v), k("fit"), { hint: "se resta al diámetro" }));
    if (sc) sec.append(h("div", { class: "msg info" }, `Rosca ${f.size}×${sc.pitch}. Para que la tuerca entre bien, M6 o más grande.`));
  }
  const before = build?.bodiesBefore[f.id] ?? [];
  if (before.length > 1) sec.append(selectField("Sobre", f.target ?? "", [["", "El último cuerpo"], ...before.map((b) => [b.id, b.name] as [string, string])], (v) => (f.target = v || undefined)));

  sec.append(h("h3", { class: "mt" }, `Posiciones (${f.points.length})`));
  if (!f.points.length) sec.append(h("div", { class: "msg info" }, "Haz clic en una cara plana de la pieza para colocar cada uno. Luego puedes ajustar la posición exacta aquí."));
  f.points.forEach((pt, i) => {
    sec.append(h("div", { class: "field" }, h("label", {}, `${i + 1}  (X Y Z)`),
      h("div", { class: "row-pt3" },
        exprInline(() => pt.x, (v) => (pt.x = v)),
        exprInline(() => pt.y, (v) => (pt.y = v)),
        exprInline(() => pt.z, (v) => (pt.z = v)),
        h("button", { class: "btn small", title: "Quitar", onclick: () => { f.points.splice(i, 1); changed(true, true); } }, "✕"),
      )));
  });
}

function sketchOptions(f: Feature): [string, string][] {
  return doc.features.slice(0, doc.features.indexOf(f)).filter((x): x is SketchFeature => x.type === "sketch").map((s) => [s.id, s.name]);
}

function renderTextProps(sec: HTMLElement, f: TextFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  const ta = h("textarea", { rows: "2", spellcheck: "false" }) as HTMLTextAreaElement;
  ta.value = f.text;
  ta.addEventListener("input", () => { f.text = ta.value; changed(false); });
  ta.addEventListener("change", () => changed(true));
  sec.append(h("div", { class: "field" }, h("label", {}, "Texto"), ta));
  const fonts: [TextFont, string][] = [["sans-bold", "Inter negrita (recomendada)"], ["sans", "Inter normal"], ["mono", "JetBrains Mono (letras del mismo ancho)"]];
  sec.append(selectField("Letra", f.font, fonts, (v) => (f.font = v as TextFont)));
  sec.append(exprField("Alto de letra", () => f.size, (v) => (f.size = v), k("size")));
  sec.append(exprField(f.op === "cut" ? "Profundidad" : "Grosor", () => f.depth, (v) => (f.depth = v), k("depth")));
  sec.append(exprField("Giro", () => f.angle, (v) => (f.angle = v), k("angle"), { unit: "°" }));
  sec.append(selectField("Resultado", f.op, [["cut", "Grabado (restar)"], ["add", "En relieve (sumar)"], ["new", "Cuerpo nuevo"]], (v) => (f.op = v as never)));
  const before = build?.bodiesBefore[f.id] ?? [];
  if (f.op !== "new" && before.length > 1) sec.append(selectField("Sobre", f.target ?? "", [["", "El último cuerpo"], ...before.map((b) => [b.id, b.name] as [string, string])], (v) => (f.target = v || undefined)));
  const p = f.points[f.points.length - 1];
  sec.append(h("h3", { class: "mt" }, "Posición"));
  if (!p) sec.append(h("div", { class: "msg info" }, "Haz clic en una cara de la pieza para poner ahí el centro del texto. Sin clic, va en el suelo, en el origen."));
  else {
    sec.append(h("div", { class: "field" }, h("label", {}, "Centro (X Y Z)"),
      h("div", { class: "row-pt3" },
        exprInline(() => p.x, (v) => (p.x = v)),
        exprInline(() => p.y, (v) => (p.y = v)),
        exprInline(() => p.z, (v) => (p.z = v)),
        h("button", { class: "btn small", title: "Quitar", onclick: () => { f.points = []; changed(true, true); } }, "✕"),
      )));
  }
  sec.append(h("div", { class: "empty mt" }, "Para imprimir bien: letras de 5 mm o más y grabado de 0,4–1 mm. Otro clic en una cara mueve el texto."));
}

function renderSweepProps(sec: HTMLElement, f: SweepFeature) {
  const opts = sketchOptions(f);
  sec.append(selectField("Forma (perfil)", f.sketch, [["", "— elige —"], ...opts], (v) => (f.sketch = v)));
  sec.append(selectField("Camino", f.path, [["", "— elige —"], ...opts], (v) => (f.path = v)));
  sec.append(h("div", { class: "msg info" },
    "La forma se coloca al principio del camino, de pie, centrada en el origen (0, 0) de su boceto. ",
    "Para el camino usa la herramienta ", h("b", {}, "〰 Camino"), " del boceto (línea abierta), o un contorno cerrado para hacer un aro."));
  sec.append(...opFields(f));
}

function renderLoftProps(sec: HTMLElement, f: LoftFeature) {
  const opts = sketchOptions(f);
  sec.append(h("div", { class: "msg info" }, "Elige los bocetos en orden: la pieza pasa de la forma del primero a la del último. Cada boceto, un solo contorno sin agujeros, en planos distintos (usa «Desfase»)."));
  f.sketches.forEach((id, i) => {
    const row = selectField(`Boceto ${i + 1}`, id, [["", "— elige —"], ...opts], (v) => (f.sketches[i] = v));
    if (f.sketches.length > 2) row.append(h("button", { class: "btn small", onclick: () => { f.sketches.splice(i, 1); changed(true, true); } }, "Quitar"));
    sec.append(row);
  });
  sec.append(h("button", { class: "btn small", onclick: () => { f.sketches.push(""); changed(true, true); } }, "+ Otro boceto"));
  sec.append(checkField("Caras rectas entre bocetos", f.ruled, (v) => (f.ruled = v)));
  sec.append(...opFields(f));
}

function renderImportProps(sec: HTMLElement, f: ImportFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  sec.append(h("div", { class: "msg info" }, `Archivo: ${f.fileName || "ninguno"} (${f.format.toUpperCase()})`));
  sec.append(h("button", { class: "btn small", onclick: () => { replacingImport = f.id; $("#file3d").click(); } }, "Cambiar archivo…"));
  sec.append(exprField("Escala", () => f.scale, (v) => (f.scale = v), k("scale"), { unit: " ×", hint: "1 = tamaño real; 25,4 si viene en pulgadas" }));
  sec.append(h("h3", { class: "mt" }, "Mover"));
  sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x")));
  sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
  sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z")));
  sec.append(...opFields(f));
  sec.append(h("div", { class: "empty mt" }, f.format === "stl"
    ? "Un STL es una malla de triángulos: se puede sumar y restar, pero cada cara es un triángulo y no se pueden redondear sus aristas. Si puedes, usa STEP."
    : "El STEP conserva las caras reales: puedes redondear, vaciar y hacer agujeros sobre él."));
}

// SVG → perfiles del boceto activo
$("#filesvg").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const f = doc.features.find((x) => x.id === active);
  if (!file || f?.type !== "sketch") return;
  if (file.size > 5 * 1024 * 1024) return toast("El SVG pasa de 5 MB");
  let shapes;
  try { shapes = readSvg(await file.text()); } catch (err) { return toast("No se pudo leer el SVG: " + (err as Error).message); }
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const w = h("input", { value: fmt(Math.round(shapes.width * 10) / 10) }) as HTMLInputElement;
  const go = () => {
    let width: number;
    try { width = evaluate(w.value, resolved.vars); } catch { w.classList.add("bad"); return; }
    if (!(width > 0)) { w.classList.add("bad"); return; }
    const { profiles, points } = svgToProfiles(shapes, width);
    f.profiles.push(...profiles);
    dlg.close();
    changed(true, true);
    sketcher.fitView();
    toast(`${profiles.length} contorno${profiles.length === 1 ? "" : "s"} importado${profiles.length === 1 ? "" : "s"} (${points} puntos)`);
  };
  w.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); });
  dlg.append(
    h("h2", {}, "Importar SVG"),
    h("p", { class: "empty" }, `${file.name}: ${shapes.loops.length} contornos, ${fmtEs(shapes.width)} × ${fmtEs(shapes.height)} mm. Se centra en el origen del boceto. Las curvas se pasan a tramos rectos muy cortos.`),
    h("div", { class: "field" }, h("label", {}, "Ancho final (mm)"), w),
    h("div", { class: "t-right" },
      h("button", { class: "btn", onclick: () => dlg.close() }, "Cancelar"), " ",
      h("button", { class: "btn primary", onclick: go }, "Importar")),
  );
  dlg.showModal();
  w.select();
});

function renderLayFlatProps(sec: HTMLElement, f: LayFlatFeature) {
  sec.append(h("div", { class: "msg info" }, f.face
    ? "La pieza se apoya sobre la cara que elegiste. Otro clic en una cara la cambia."
    : "La pieza se apoya sobre su cara plana más grande. Si prefieres otra, haz clic en ella."));
  if (f.face) sec.append(h("button", { class: "btn small", onclick: () => { f.face = null; changed(true, true); } }, "Usar la cara más grande"));
  sec.append(h("div", { class: "empty mt" }, "Gira todos los cuerpos, los baja a la cama (Z = 0) y los centra. Déjalo como último paso: los pasos de después verían la pieza ya girada. Mientras lo editas ves la pieza sin girar."));
}

function renderComponentProps(sec: HTMLElement, f: ComponentFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  sec.append(h("div", { class: "msg info" }, `Copia de «${f.source.name}» (${f.source.features.length} pasos).`));
  sec.append(h("button", { class: "btn small", title: "Vuelve a copiar la pieza guardada, por si la cambiaste", onclick: () => {
    const d = storage.load(f.sourceId);
    if (!d) return toast("Esa pieza ya no está guardada en este navegador");
    f.source = { name: d.name, variables: d.variables, features: d.features };
    changed(true, true);
    toast("Pieza actualizada");
  } }, "Actualizar desde la pieza guardada"));
  if (f.source.variables.length) {
    sec.append(h("h3", { class: "mt" }, "Medidas de la pieza"));
    sec.append(h("div", { class: "empty" }, "Vacío = la suya. Puedes usar las variables de esta pieza."));
    for (const v of f.source.variables) {
      const inp = exprInline(() => f.params[v.name] ?? "", (val) => { if (val.trim()) f.params[v.name] = val; else delete f.params[v.name]; });
      inp.placeholder = v.value;
      sec.append(h("div", { class: "field" }, h("label", {}, v.name), inp));
    }
  }
  sec.append(h("h3", { class: "mt" }, "Colocar"));
  sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x")));
  sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
  sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z")));
  sec.append(exprField("Giro (Z)", () => f.rz, (v) => (f.rz = v), k("rz"), { unit: "°" }));
  sec.append(...opFields(f));
}

/** Elegir una pieza guardada para meterla dentro de esta */
function componentDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const list = storage.list().filter((m) => m.id !== docId);
  dlg.append(h("h2", {}, "Meter una pieza guardada"));
  dlg.append(h("p", { class: "empty" }, "Se mete una copia, con sus variables cambiables. Si luego cambias la original, pulsa «Actualizar» en el paso."));
  const box = h("div", { class: "list" });
  if (!list.length) box.append(h("div", { class: "empty" }, "No hay otras piezas guardadas. Haz una, y aparecerá aquí."));
  for (const m of list) {
    box.append(h("div", { class: "it" },
      h("span", { onclick: () => {
        const d = storage.load(m.id);
        dlg.close();
        if (!d) return;
        const f = newFeature(doc, "component") as ComponentFeature;
        Object.assign(f, { name: d.name, sourceId: m.id, source: { name: d.name, variables: d.variables, features: d.features } });
        doc.features.push(f);
        setActive(f.id);
        changed(true, true);
      } }, m.name, " ", h("small", {}, `${d_count(m.id)} pasos`)),
    ));
  }
  dlg.append(box, h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cancelar")));
  dlg.showModal();
}
const d_count = (id: string) => storage.load(id)?.features.length ?? 0;

function templatesDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  dlg.append(h("h2", {}, "Plantillas"));
  dlg.append(h("p", { class: "empty" }, "Cada una se abre como pieza nueva, con variables para cambiar medidas y holguras."));
  const box = h("div", { class: "list" });
  for (const t of TEMPLATES) {
    box.append(h("div", { class: "it" },
      h("span", { onclick: () => { dlg.close(); setDoc(t.make(), uid()); toast(`Plantilla «${t.name}» abierta`); } }, t.name, h("small", { class: "block" }, t.info)),
    ));
  }
  dlg.append(box, h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
  dlg.showModal();
}

let replacingImport: string | null = null;
$("#file3d").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const ext = file.name.toLowerCase().split(".").pop();
  const format = ext === "stl" ? "stl" : ext === "step" || ext === "stp" ? "step" : null;
  if (!format) return toast("Solo STEP (.step, .stp) o STL");
  if (file.size > 40 * 1024 * 1024) return toast("El archivo pasa de 40 MB: es demasiado grande");
  const data = await file.arrayBuffer();
  const id = await fileId(data);
  try { await files.put(id, { name: file.name, format, data }); } catch { return toast("No se pudo guardar el archivo en este navegador"); }
  const old = replacingImport ? doc.features.find((x) => x.id === replacingImport) : undefined;
  replacingImport = null;
  toast("Leyendo el archivo…");
  if (old?.type === "import") {
    Object.assign(old, { file: id, fileName: file.name, format });
    changed(true, true);
    return;
  }
  const f = newFeature(doc, "import") as ImportFeature;
  Object.assign(f, { file: id, fileName: file.name, format, name: file.name.replace(/\.[^.]+$/, "") });
  doc.features.push(f);
  setActive(f.id);
  changed(true, true);
});

/** Solo actualiza el aviso del paso activo (sin rehacer el panel, para no perder lo que escribes) */
function renderFeatureError() {
  const box = document.getElementById("feat-err");
  if (!box) return;
  const err = active ? build?.errors[active] : undefined;
  box.className = err ? "msg err" : "";
  box.textContent = err ?? "";
}

function renderSketchProps(sec: HTMLElement, f: SketchFeature) {
  const pl = f.plane;
  const planeOpts: [string, string][] = [["XY", "Suelo (XY)"], ["XZ", "Frente (XZ)"], ["YZ", "Lado (YZ)"]];
  if (pl.kind === "face") planeOpts.push(["face", "Cara elegida"]);
  sec.append(selectField("Plano", pl.kind === "std" ? pl.name : "face", planeOpts, (v) => {
    if (v !== "face") f.plane = { kind: "std", name: v as StdPlane, offset: f.plane.offset, tilt: f.plane.tilt, turn: f.plane.turn };
  }));
  sec.append(exprField("Desfase", () => f.plane.offset, (v) => (f.plane.offset = v), `${f.id}:offset`, { hint: "separa el plano en su normal" }));
  sec.append(exprField("Inclinación", () => f.plane.tilt ?? "0", (v) => (f.plane.tilt = v), `${f.id}:tilt`, { unit: "°", hint: "gira el plano sobre su eje X (rojo)" }));
  sec.append(exprField("Giro", () => f.plane.turn ?? "0", (v) => (f.plane.turn = v), `${f.id}:turn`, { unit: "°", hint: "gira el dibujo dentro del plano" }));
  sec.append(h("div", { class: "seg-btns" },
    h("button", { class: "btn small", onclick: startFacePick }, "Dibujar sobre una cara de la pieza…"),
    h("button", { class: "btn small", title: "Traer un dibujo de Inkscape, Illustrator, Figma…", onclick: () => $("#filesvg").click() }, "Importar SVG…"),
  ));

  if (f.constraints?.length) {
    sec.append(h("div", { class: "msg info" }, `Restricciones: ${f.constraints.length}. Clic en su símbolo del dibujo para quitar una.`,
      " ", h("button", { class: "btn small", onclick: () => { delete f.constraints; changed(true, true); } }, "Quitar todas")));
  }
  // perfil seleccionado
  const p = f.profiles.find((x) => x.id === sketcher.selected);
  const ps = h("div", { class: "subsection" });
  sec.append(ps);
  if (!p) {
    ps.append(h("h3", {}, `Perfiles (${f.profiles.length})`));
    ps.append(h("div", { class: "empty" }, f.profiles.length
      ? "Haz clic en un perfil para ver y cambiar sus medidas."
      : "Usa las herramientas de arriba para dibujar. Los perfiles que quedan dentro de otro se marcan como agujero."));
    return;
  }
  const names: Record<Profile["kind"], string> = { rect: "Rectángulo", circle: "Círculo", ngon: "Polígono", poly: "Polilínea" };
  ps.append(h("h3", {}, names[p.kind], h("button", { class: "btn small", onclick: () => sketcher.deleteSelected() }, "Borrar")));
  const isOpen = p.kind === "poly" && !!p.open;
  if (!isOpen) ps.append(checkField("Es un agujero", p.hole, (v) => (p.hole = v)));
  if (p.kind === "poly") ps.append(checkField("Línea abierta (camino para un barrido)", isOpen, (v) => { if (v) p.open = true; else delete p.open; }));
  const k = (fl: string) => `${f.id}:${p.id}:${fl}`;
  const E = (label: string, key: string, unit?: string) =>
    exprField(label, () => (p as never)[key], (v) => ((p as unknown as Record<string, unknown>)[key] = v), k(key), unit ? { unit } : {});
  if (p.kind === "rect") {
    ps.append(E("Ancho", "w"), E("Alto", "h"), E("Esquina X", "x"), E("Esquina Y", "y"), E("Redondeo", "r"));
    ps.append(h("div", { class: "seg-btns" },
      h("button", { class: "btn small", onclick: () => { const w = p.w, hh = p.h; p.x = `-(${w})/2`; p.y = `-(${hh})/2`; changed(true, true); } }, "Centrar en el origen"),
    ));
  } else if (p.kind === "circle" || p.kind === "ngon") {
    ps.append(E("Radio", "r"), E("Centro X", "cx"), E("Centro Y", "cy"));
    if (p.kind === "ngon") ps.append(E("Lados", "n", " lados"));
  } else {
    const seg = sketcher.selSeg;
    if (seg !== null && p.pts[seg]) {
      const pt = p.pts[seg];
      ps.append(h("div", { class: "msg info" }, `Tramo ${seg + 1}: ponle curvatura para convertirlo en arco (positivo = hacia la izquierda, negativo = hacia la derecha).`));
      ps.append(exprField("Curvatura", () => pt.s ?? "0", (v) => (pt.s = v), k(`${seg}:s`)));
    } else {
      ps.append(h("div", { class: "empty" }, "Clic en un tramo para convertirlo en arco. Doble clic en una cota para escribir su largo."));
    }
    p.pts.forEach((pt, i) => {
      ps.append(h("div", { class: "field" }, h("label", {}, `Punto ${i + 1}`),
        h("div", { class: "row-pt" },
          exprInline(() => pt.x, (v) => (pt.x = v)),
          exprInline(() => pt.y, (v) => (pt.y = v)),
          p.pts.length > 3 ? h("button", { class: "btn small", title: "Quitar punto", onclick: () => { p.pts.splice(i, 1); f.constraints = f.constraints?.filter((c) => c.s.p !== p.id && !("t" in c && c.t.p === p.id)); cleanConstraints(f); changed(true, true); } }, "✕") : h("span"),
        )));
    });
  }
}

function exprInline(get: () => string, set: (v: string) => void) {
  const input = h("input", { value: get(), spellcheck: "false" }) as HTMLInputElement;
  const check = () => { try { evaluate(input.value, resolved.vars); input.classList.remove("bad"); } catch { input.classList.add("bad"); } };
  input.addEventListener("input", () => { set(input.value); check(); changed(false); });
  input.addEventListener("change", () => changed(true));
  check();
  return input;
}

// ======================================================================
// Boceto: barra de herramientas
// ======================================================================

const SK_TOOLS: [SketchTool, string, string][] = [
  ["select", "↖ Elegir", "S"], ["poly", "╱ Líneas", "L"], ["rect", "▭ Rectángulo", "R"],
  ["circle", "◯ Círculo", "C"], ["ngon", "⬡ Polígono", "P"], ["path", "〰 Camino", "W"],
];

function renderSketchBar() {
  const bar = $("#sketchbar");
  bar.innerHTML = "";
  for (const [t, label, key] of SK_TOOLS) {
    bar.append(h("button", { class: `btn small ${sketcher.tool === t ? "on" : ""}`, title: `Atajo: ${key}`, onclick: () => { sketcher.setTool(t); renderSketchBar(); } }, label));
  }
  // restricciones para los tramos elegidos
  const n = sketcher.picks.length;
  const kinds = n === 1 ? (["h", "v"] as const) : n === 2 ? (["equal", "parallel", "perp"] as const) : [];
  if (kinds.length) {
    bar.append(h("span", { class: "sep" }));
    for (const kd of kinds) {
      bar.append(h("button", { class: "btn small", title: CONSTRAINT_NAME[kd], onclick: () => {
        const err = sketcher.addConstraint(kd);
        if (err) toast(err);
        renderSketchBar();
      } }, `${CONSTRAINT_GLYPH[kd]} ${CONSTRAINT_NAME[kd]}`));
    }
  }
  const snap = h("button", { class: `btn small ${sketcher.snapOn ? "on" : ""}`, title: "Ajustar a la rejilla (Mayús lo suspende)", onclick: () => { sketcher.snapOn = !sketcher.snapOn; renderSketchBar(); } }, "# Rejilla");
  bar.append(snap, h("button", { class: "btn small", onclick: () => sketcher.fitView() }, "Encajar"));
  if (sketcher.tool === "poly" || sketcher.tool === "path") bar.append(h("button", { class: "btn small", title: "Igual que Intro o doble clic", onclick: () => sketcher.finishPoly() }, "↵ Acabar línea"));
  bar.append(h("span", { class: "spacer" }));
  bar.append(h("button", { class: "btn small primary", onclick: () => setActive(null) }, "✓ Terminar boceto"));
  const consHint = sketcher.tool === "select" ? (n === 1 ? " · Mayús+clic en otro tramo para elegir dos" : n === 0 ? " · Clic en un tramo de unas líneas para ponerle restricciones" : "") : "";
  const nav = sketcher.coarse ? " · Dos dedos: zoom y mover" : " · Rueda: zoom · Botón derecho o central: desplazar";
  const hint = sketcher.coarse ? consHint.replace("Mayús+clic en otro tramo", "toca otro tramo") : consHint;
  $("#sketchhint").textContent = `${TOOL_HINT[sketcher.tool]}${hint}${nav}`;
}

/** Pasa al editor 2D las aristas de la pieza vistas desde el plano del boceto */
function sendSketchReference(m: BuildResult) {
  const f = doc.features.find((x) => x.id === active);
  if (f?.type !== "sketch") return;
  const rf = resolveDoc(doc).features.find((x) => x.id === f.id) as Resolved<SketchFeature> | undefined;
  if (!rf) return;
  const b = planeBasis(rf.plane as never);
  const inP: number[] = [], outP: number[] = [];
  const tol = 0.01;
  for (const body of m.bodies) {
    const L = body.lines;
    for (let i = 0; i < L.length; i += 6) {
      const p1: Vec3 = [L[i] - b.origin[0], L[i + 1] - b.origin[1], L[i + 2] - b.origin[2]];
      const p2: Vec3 = [L[i + 3] - b.origin[0], L[i + 4] - b.origin[1], L[i + 5] - b.origin[2]];
      const d1 = p1[0] * b.n[0] + p1[1] * b.n[1] + p1[2] * b.n[2];
      const d2 = p2[0] * b.n[0] + p2[1] * b.n[1] + p2[2] * b.n[2];
      const u1 = p1[0] * b.x[0] + p1[1] * b.x[1] + p1[2] * b.x[2], v1 = p1[0] * b.y[0] + p1[1] * b.y[1] + p1[2] * b.y[2];
      const u2 = p2[0] * b.x[0] + p2[1] * b.x[1] + p2[2] * b.x[2], v2 = p2[0] * b.y[0] + p2[1] * b.y[1] + p2[2] * b.y[2];
      if (Math.hypot(u2 - u1, v2 - v1) < 1e-6) continue; // arista vista de punta
      (Math.abs(d1) < tol && Math.abs(d2) < tol ? inP : outP).push(u1, v1, u2, v2);
    }
  }
  sketcher.setReference(inP, outP);
}

function startFacePick() {
  pickingFace = true;
  $("#sketch").classList.remove("on");
  viewport.pickMode = "face";
  renderBanner();
}

viewport.events.onFacePick = (point, normal) => {
  const f = doc.features.find((x) => x.id === active);
  if (f?.type === "layflat") {
    f.face = point.map((c) => Math.round(c * 1000) / 1000) as Vec3;
    changed(true, true);
    return;
  }
  if (f?.type === "fillet" || f?.type === "chamfer") {
    const list = (f.faces ??= []);
    const near = list.findIndex((q) => Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]) < 3);
    if (near >= 0) list.splice(near, 1);
    else list.push(point.map((c) => Math.round(c * 1000) / 1000) as Vec3);
    if (!list.length) delete f.faces;
    changed(true, true);
    return;
  }
  if (f?.type === "shell") {
    // otro clic cerca de un punto ya elegido lo quita
    const near = f.faces.findIndex((q) => Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]) < 3);
    if (near >= 0) f.faces.splice(near, 1);
    else f.faces.push(point.map((c) => Math.round(c * 1000) / 1000) as Vec3);
    changed(true, true);
    return;
  }
  if (f?.type === "hole" || f?.type === "rod" || f?.type === "text") {
    const n = normal.map((c) => Math.round(c * 1e6) / 1e6) as Vec3;
    // redondeo a 0,5 mm y vuelta al plano de la cara, para que las medidas salgan limpias
    let q = point.map((c) => Math.round(c * 2) / 2) as Vec3;
    const d = (point[0] - q[0]) * n[0] + (point[1] - q[1]) * n[1] + (point[2] - q[2]) * n[2];
    q = [q[0] + n[0] * d, q[1] + n[1] * d, q[2] + n[2] * d].map((c) => Math.round(c * 1000) / 1000) as Vec3;
    const fp = { x: fmt(q[0]), y: fmt(q[1]), z: fmt(q[2]), n };
    if (f.type === "text") f.points = [fp]; // el texto va en un solo sitio
    else f.points.push(fp);
    changed(true, true);
    return;
  }
  if (!pickingFace) return;
  if (f?.type !== "sketch") return;
  const pl = planeFromHit(point, normal);
  f.plane = { kind: "face", ...pl, offset: "0" };
  pickingFace = false;
  viewport.pickMode = "none";
  $("#sketch").classList.add("on");
  sketcher.open(f);
  sketcher.refitSoon();
  renderBanner();
  changed(true, true);
};

viewport.events.onEdgePick = (p) => {
  const f = doc.features.find((x) => x.id === active) as EdgeFeature | undefined;
  if (!f || (f.type !== "fillet" && f.type !== "chamfer")) return;
  // si ya estaba elegida (punto muy cerca de la misma arista), quitarla
  const near = f.edges.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 2);
  const round = (v: Vec3) => v.map((c) => Math.round(c * 1000) / 1000) as Vec3;
  if (near >= 0) { f.edges.splice(near, 1); f.sizes?.splice(near, 1); }
  else f.edges.push(round(p));
  changed(true, true);
  renderMarks();
};

function renderBanner() {
  const b = $("#banner");
  const f = doc.features.find((x) => x.id === active);
  if (pickingFace) {
    b.hidden = false;
    b.innerHTML = "";
    b.append("Haz clic en una cara plana de la pieza", h("button", { class: "btn small", onclick: () => { pickingFace = false; viewport.pickMode = "none"; $("#sketch").classList.add("on"); renderBanner(); } }, "Cancelar"));
  } else if (measuring) {
    b.hidden = false;
    b.innerHTML = "";
    const pts = viewport.measurePts;
    let txt = "Medir: haz clic en dos puntos (vértices, aristas o caras)";
    if (pts.length === 1) txt = "Ahora el segundo punto";
    if (pts.length === 2) {
      const [a, c] = pts;
      const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
      txt = `Distancia ${fmt(Math.hypot(dx, dy, dz))} mm  ·  X ${fmt(Math.abs(dx))}  Y ${fmt(Math.abs(dy))}  Z ${fmt(Math.abs(dz))}`;
    }
    b.append(txt, h("button", { class: "btn small", onclick: stopMeasure }, "Terminar"));
  } else if (f && (f.type === "fillet" || f.type === "chamfer")) {
    b.hidden = false;
    b.textContent = pickFacesForEdges ? `${f.name}: elige caras con un clic` : `${f.name}: elige aristas con un clic`;
  } else if (f?.type === "shell") {
    b.hidden = false;
    b.textContent = `${f.name}: clic en la cara que queda abierta`;
  } else if (f?.type === "hole" || f?.type === "rod") {
    b.hidden = false;
    b.textContent = `${f.name}: clic en una cara para colocar cada uno`;
  } else if (f?.type === "layflat") {
    b.hidden = false;
    b.textContent = `${f.name}: clic en la cara que irá sobre la cama`;
  } else if (f?.type === "text") {
    b.hidden = false;
    b.textContent = `${f.name}: clic en una cara para colocar el texto`;
  } else b.hidden = true;
}

function renderMarks() {
  const f = doc.features.find((x) => x.id === active);
  let plane = null;
  if (f?.type === "sketch") {
    const rf = resolved.features.find((x) => x.id === f.id) as Resolved<SketchFeature> | undefined;
    if (rf) plane = planeBasis(rf.plane as never);
  }
  const pins = f && (f.type === "hole" || f.type === "rod" || f.type === "text")
    ? ((resolved.features.find((x) => x.id === f.id) as Resolved<HoleFeature> | undefined)?.points ?? []).map((p) => ({ p: [p.x, p.y, p.z] as Vec3, n: p.n as Vec3 }))
    : [];
  viewport.setMarks({
    edges: f && (f.type === "fillet" || f.type === "chamfer") ? f.edges : [],
    faces: f?.type === "shell" ? f.faces : f && (f.type === "fillet" || f.type === "chamfer") ? f.faces ?? [] : f?.type === "layflat" && f.face ? [f.face] : [],
    pins,
    plane: pickingFace ? null : plane,
  });
}

/** Dibuja en 3D los bocetos que aún no se han usado (y el activo) */
function renderSketchLines() {
  const used = new Set(doc.features.flatMap((f) => (f.off ? [] : sketchUses(f))));
  const out: { pts: Vec3[][]; active: boolean }[] = [];
  for (const f of resolved.features) {
    if (f.type !== "sketch" || f.off) continue;
    const isActive = f.id === active;
    if (used.has(f.id) && !isActive) continue;
    const b = planeBasis(f.plane as never);
    const loops = f.profiles.map((p) => profileLoop(p as never).map(([u, v]) => toWorld(b, u, v)));
    out.push({ pts: loops, active: isActive });
  }
  viewport.setSketchLines(out);
  renderMarks();
}

// ======================================================================
// Archivo y exportar
// ======================================================================

function toast(text: string) {
  const t = h("div", { class: "toast" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h("a", { href: url, download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = () => (doc.name || "pieza").replace(/[^\wáéíóúñÁÉÍÓÚÑ\- ]+/g, "").trim().replace(/\s+/g, "-") || "pieza";

function doExport(format: "stl" | "step" | "3mf") {
  if (!engineReady) return toast("El motor aún está cargando");
  const s = ++seq;
  toast("Preparando el archivo…");
  exportWaiters.set(s, (m) => {
    if (!m.data) return toast("No se pudo exportar: " + (m.error ?? ""));
    const mime = { stl: "model/stl", step: "model/step", "3mf": "model/3mf" }[format];
    download(m.data, `${safeName()}.${format}`, mime);
    rebuild();
  });
  worker.postMessage({ kind: "export", seq: s, features: resolveDoc(doc).features, format, colors: doc.colors });
}

// ---------- plano 2D con medidas ----------
const VIEW_LABEL: Record<DrawingView["name"], string> = { front: "Frente", top: "Arriba", right: "Derecha", iso: "3D" };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Hoja A4 apaisada (en mm) con las vistas, las medidas generales y el cajetín */
function drawingSheet(views: DrawingView[]): string {
  const W = 297, H = 210, M = 10;
  const cellW = (W - 2 * M - 10) / 2, cellH = (H - 2 * M - 34) / 2;
  const by = Object.fromEntries(views.map((v) => [v.name, v])) as Partial<Record<DrawingView["name"], DrawingView>>;
  const size = (v: DrawingView) => [v.box[2] - v.box[0], v.box[3] - v.box[1]];
  // misma escala en las tres vistas (para que se puedan medir con regla), con un número redondo
  let need = Infinity;
  for (const v of views) if (v.name !== "iso") { const [w, hh] = size(v); need = Math.min(need, (cellW - 30) / Math.max(w, 1e-3), (cellH - 22) / Math.max(hh, 1e-3)); }
  const NICE = [20, 10, 5, 4, 2, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.02, 0.01];
  const sc = NICE.find((n) => n <= need) ?? 0.01;
  const scaleTxt = sc >= 1 ? `${sc}:1` : `1:${Math.round(1 / sc)}`;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" font-family="Inter, system-ui, sans-serif">`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);
  out.push(`<rect x="${M / 2}" y="${M / 2}" width="${W - M}" height="${H - M}" fill="none" stroke="#000" stroke-width="0.5"/>`);
  const cells: [DrawingView["name"], number, number][] = [["front", M, M], ["right", M + cellW + 10, M], ["top", M, M + cellH], ["iso", M + cellW + 10, M + cellH]];
  const dim = (x1: number, y1: number, x2: number, y2: number, txt: string, vertical: boolean) => {
    const a = 1.6;
    const parts = [`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="0.18"/>`];
    // flechas
    if (vertical) parts.push(`<path d="M${x1} ${y1} l${-a / 3} ${a} h${(2 * a) / 3} Z M${x2} ${y2} l${-a / 3} ${-a} h${(2 * a) / 3} Z" fill="#000"/>`);
    else parts.push(`<path d="M${x1} ${y1} l${a} ${-a / 3} v${(2 * a) / 3} Z M${x2} ${y2} l${-a} ${-a / 3} v${(2 * a) / 3} Z" fill="#000"/>`);
    const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2;
    parts.push(vertical
      ? `<text x="${tx - 1.2}" y="${ty}" font-size="3" text-anchor="middle" transform="rotate(-90 ${tx - 1.2} ${ty})">${txt}</text>`
      : `<text x="${tx}" y="${ty - 1.2}" font-size="3" text-anchor="middle">${txt}</text>`);
    return parts.join("");
  };
  const ext = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="0.13"/>`;
  const n = (v: number) => fmtEs(v, Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2);
  for (const [name, cx, cy] of cells) {
    const v = by[name];
    out.push(`<text x="${cx + 2}" y="${cy + 5}" font-size="3.4" font-weight="700">${VIEW_LABEL[name]}</text>`);
    if (!v) continue;
    const [w, hh] = size(v);
    const k = name === "iso" ? Math.min((cellW - 12) / Math.max(w, 1e-3), (cellH - 14) / Math.max(hh, 1e-3)) : sc;
    const ox = cx + (cellW - w * k) / 2 - v.box[0] * k, oy = cy + 6 + (cellH - 6 - hh * k) / 2 - v.box[1] * k;
    const tr = `translate(${ox.toFixed(3)} ${oy.toFixed(3)}) scale(${k})`;
    out.push(`<g transform="${tr}" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">`);
    for (const d of v.hidden) out.push(`<path d="${d}" stroke-width="${0.18 / k}" stroke-dasharray="${1.2 / k} ${0.8 / k}" stroke="#555"/>`);
    for (const d of v.visible) out.push(`<path d="${d}" stroke-width="${0.35 / k}"/>`);
    out.push(`</g>`);
    if (name === "iso") continue;
    // medidas generales: ancho abajo, alto a la derecha
    const x0 = ox + v.box[0] * k, x1 = ox + v.box[2] * k, y0 = oy + v.box[1] * k, y1 = oy + v.box[3] * k;
    const gy = y1 + 6, gx = x1 + 6;
    out.push(ext(x0, y1 + 1, x0, gy + 1), ext(x1, y1 + 1, x1, gy + 1), dim(x0, gy, x1, gy, n(w), false));
    if (name !== "right") out.push(ext(x1 + 1, y0, gx + 1, y0), ext(x1 + 1, y1, gx + 1, y1), dim(gx, y0, gx, y1, n(hh), true));
  }
  // cajetín
  const ty = H - M / 2 - 24, tx = W - M / 2 - 110;
  const today = new Date().toLocaleDateString("es-ES");
  out.push(`<g font-size="3.2"><rect x="${tx}" y="${ty}" width="110" height="24" fill="none" stroke="#000" stroke-width="0.4"/>`,
    `<line x1="${tx}" y1="${ty + 10}" x2="${tx + 110}" y2="${ty + 10}" stroke="#000" stroke-width="0.25"/>`,
    `<line x1="${tx + 55}" y1="${ty + 10}" x2="${tx + 55}" y2="${ty + 24}" stroke="#000" stroke-width="0.25"/>`,
    `<text x="${tx + 3}" y="${ty + 7}" font-size="5" font-weight="700">${esc(doc.name || "Pieza")}</text>`,
    `<text x="${tx + 3}" y="${ty + 16}">Escala ${scaleTxt}</text><text x="${tx + 3}" y="${ty + 21}">Medidas en mm</text>`,
    `<text x="${tx + 58}" y="${ty + 16}">${today}</text><text x="${tx + 58}" y="${ty + 21}">Hecho con Geometría</text></g>`);
  out.push(`<text x="${M}" y="${H - M / 2 - 2}" font-size="2.6" fill="#555">Líneas discontinuas: aristas ocultas. Las vistas 2D están a la misma escala; la 3D, no.</text>`);
  out.push("</svg>");
  return out.join("");
}

function drawingDialog() {
  if (!engineReady) return toast("El motor aún está cargando");
  if (!build?.bodies.length) return toast("Todavía no hay ninguna pieza que dibujar");
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const preview = h("div", { class: "sheet" }, h("div", { class: "empty" }, "Dibujando las vistas…"));
  const actions = h("div", { class: "actions" });
  dlg.append(h("h2", {}, "Plano con medidas"), preview, actions);
  if (!dlg.open) dlg.showModal();
  const s = ++seq;
  drawingWaiters.set(s, (m) => {
    rebuild();
    if (!m.views?.length) { preview.innerHTML = ""; preview.append(h("div", { class: "msg err" }, "No se pudo dibujar: " + (m.error ?? "sin vistas"))); return; }
    const svg = drawingSheet(m.views);
    preview.innerHTML = svg;
    actions.append(
      h("button", { class: "btn primary", onclick: () => {
        $("#printarea").innerHTML = svg;
        dlg.close();
        // el navegador ofrece «Guardar como PDF» en el diálogo de imprimir
        setTimeout(() => window.print(), 50);
      } }, "Imprimir o guardar PDF"),
      h("button", { class: "btn", onclick: () => download(svg, `${safeName()}-plano.svg`, "image/svg+xml") }, "Descargar SVG"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar"),
    );
  });
  worker.postMessage({ kind: "drawing", seq: s, features: resolveDoc(doc).features });
}
$("#drawing").addEventListener("click", drawingDialog);
window.addEventListener("afterprint", () => { $("#printarea").innerHTML = ""; });

function openDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const list = storage.list();
  dlg.append(h("h2", {}, "Piezas guardadas en este navegador"));
  const box = h("div", { class: "list" });
  if (!list.length) box.append(h("div", { class: "empty" }, "Todavía no hay ninguna."));
  for (const m of list) {
    box.append(h("div", { class: "it" },
      h("span", { onclick: () => { const d = storage.load(m.id); if (d) setDoc(d, m.id); dlg.close(); } }, m.name, " ", h("small", {}, new Date(m.updated).toLocaleString("es-ES"))),
      m.id === docId ? h("small", {}, "(abierta)") : h("button", { class: "btn small", onclick: () => { if (confirm(`¿Borrar «${m.name}»?`)) { storage.remove(m.id); openDialog(); } } }, "Borrar"),
    ));
  }
  dlg.append(box, h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
  if (!dlg.open) dlg.showModal();
}

/** Descarga el proyecto; los archivos importados van dentro para poder abrirlo en otro equipo */
async function saveProjectFile() {
  const out: Doc = JSON.parse(JSON.stringify(doc));
  for (const f of doc.features) {
    if (f.type !== "import" || !f.file || out.files?.[f.file]) continue;
    const st = await files.get(f.file);
    if (st) (out.files ??= {})[f.file] = { name: st.name, format: st.format, data: toBase64(st.data) };
  }
  download(JSON.stringify(out, null, 2), `${safeName()}.geometria.json`, "application/json");
}

function fileAction(a: string) {
  if (a === "new") setDoc(emptyDoc(), uid());
  else if (a === "example") setDoc(exampleDoc(), uid());
  else if (a === "dup") { const d: Doc = JSON.parse(JSON.stringify(doc)); d.name += " (copia)"; setDoc(d, uid()); toast("Copia creada"); }
  else if (a === "open") openDialog();
  else if (a === "templates") templatesDialog();
  else if (a === "save-file") void saveProjectFile();
  else if (a === "load-file") $("#file").click();
}

$("#file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!isDoc(d)) throw new Error();
    // los archivos importados que trae dentro se guardan aparte
    for (const [id, f] of Object.entries(d.files ?? {})) {
      if (f && (f.format === "step" || f.format === "stl") && typeof f.data === "string") await files.put(id, { name: String(f.name), format: f.format, data: fromBase64(f.data) });
    }
    delete d.files;
    setDoc(d, uid());
    toast("Proyecto cargado");
  } catch {
    toast("Ese archivo no es un proyecto de Geometría");
  }
});

// menús
for (const m of document.querySelectorAll<HTMLElement>(".menu")) {
  m.querySelector("button")!.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = m.classList.contains("open");
    document.querySelectorAll(".menu").forEach((x) => x.classList.remove("open"));
    if (!open) m.classList.add("open");
  });
}
document.addEventListener("click", () => document.querySelectorAll(".menu").forEach((x) => x.classList.remove("open")));
$("#m-file").querySelectorAll<HTMLElement>("[data-a]").forEach((b) => b.addEventListener("click", () => fileAction(b.dataset.a!)));
$("#m-export").querySelectorAll<HTMLElement>("[data-f]").forEach((b) => b.addEventListener("click", () => doExport(b.dataset.f as never)));
$("#viewsel").addEventListener("change", (e) => { const sel = e.target as HTMLSelectElement; if (sel.value) viewport.view(sel.value as ViewName); sel.value = ""; });
document.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => b.addEventListener("click", () => (b.dataset.v === "fit" ? viewport.fit() : viewport.view(b.dataset.v as ViewName))));

// perspectiva / isométrica (se recuerda en este navegador)
const PERSP_KEY = "geometria:perspectiva";
try { viewport.perspective3d = localStorage.getItem(PERSP_KEY) !== "no"; } catch { /* sin almacenamiento */ }
function renderPerspBtn() {
  const short = isMobile();
  $("#persp-label").textContent = viewport.perspective3d ? (short ? "Persp." : "Perspectiva") : (short ? "Isom." : "Isométrica");
}
$("#persp").addEventListener("click", () => {
  viewport.setPerspective3d(!viewport.perspective3d);
  try { localStorage.setItem(PERSP_KEY, viewport.perspective3d ? "si" : "no"); } catch { /* nada */ }
  renderPerspBtn();
});
renderPerspBtn();
if (!viewport.perspective3d) viewport.view("iso");

// medir
let measuring = false;
function startMeasure() {
  if (active) setActive(null);
  measuring = true;
  viewport.clearMeasure();
  viewport.pickMode = "measure";
  $("#measure").classList.add("on");
  renderBanner();
}
function stopMeasure() {
  measuring = false;
  viewport.clearMeasure();
  if (viewport.pickMode === "measure") viewport.pickMode = "none";
  $("#measure").classList.remove("on");
  renderBanner();
}
$("#measure").addEventListener("click", () => (measuring ? stopMeasure() : startMeasure()));
viewport.events.onMeasure = () => renderBanner();
$("#undo").addEventListener("click", () => undoRedo("undo"));
$("#redo").addEventListener("click", () => undoRedo("redo"));
$("#undo-m").addEventListener("click", () => undoRedo("undo"));
$("#redo-m").addEventListener("click", () => undoRedo("redo"));
$("#addvar").addEventListener("click", () => {
  let i = 1;
  while (doc.variables.some((v) => v.name === `medida${i}`)) i++;
  doc.variables.push({ name: `medida${i}`, value: "10" });
  changed(true);
  renderVars();
});
const docname = $("#docname") as HTMLInputElement;
docname.addEventListener("change", () => { doc.name = docname.value.trim() || "Pieza sin nombre"; changed(true); });

// teclado
document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undoRedo(e.shiftKey ? "redo" : "undo"); return; }
  if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); undoRedo("redo"); return; }
  if (typing) return;
  const f = doc.features.find((x) => x.id === active);
  if (f?.type === "sketch" && !pickingFace) {
    if (e.key === "Escape") { if (!sketcher.cancel()) setActive(null); renderSketchBar(); return; }
    if (e.key === "Enter") { sketcher.finishPoly(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { sketcher.deleteSelected(); return; }
    const map: Record<string, SketchTool> = { s: "select", l: "poly", r: "rect", c: "circle", p: "ngon", w: "path" };
    const t = map[e.key.toLowerCase()];
    if (t && !mod) { sketcher.setTool(t); renderSketchBar(); }
    return;
  }
  if (e.key === "Escape" && measuring) { stopMeasure(); return; }
  if (e.key === "Escape" && active) setActive(null);
});

// ======================================================================

function renderAll() {
  docname.value = doc.name;
  renderTree();
  renderVars();
  renderProps();
  renderUndo();
  renderBanner();
}

renderAll();
rebuild();
// para depurar desde la consola
(window as unknown as Record<string, unknown>).geometria = { get doc() { return doc; }, setDoc, viewport };
