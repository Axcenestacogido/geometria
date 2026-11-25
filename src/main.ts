import "./style.css";
import type {
  Doc, Feature, SketchFeature, EdgeFeature, BuildResult, WorkerOut, Profile, StdPlane, Vec3, Resolved,
  PatternFeature, PatternKind, Axis, HoleFeature, RodFeature, HoleKind,
} from "./types";
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
let resolved: ResolveOut = resolveDoc(doc);
let build: BuildResult | null = null;
let engineReady = false;
let seq = 0;
let lastBodiesKey = "";

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
    <div class="section"><h3>Añadir</h3><div class="tools" id="tools"></div></div>
    <div class="section grow"><h3>Pasos <span class="empty" id="buildtime"></span></h3><ul class="tree" id="tree"></ul></div>
    <div class="section vars"><h3>Variables <button class="btn small" id="addvar">+ Añadir</button></h3><div id="vars"></div></div>
  </aside>
  <section class="view" id="view">
    <div class="viewbar">
      <button class="btn small" id="measure" title="Medir distancias entre dos puntos">📏 Medir</button>
      <span class="sep"></span>
      <button class="btn small" data-v="iso" title="Vista 3D">3D</button>
      <button class="btn small" id="persp" title="Cambia la vista 3D entre perspectiva e isométrica (paralela)">Perspectiva</button>
      <span class="sep"></span>
      <button class="btn small" data-v="top">Arriba</button>
      <button class="btn small" data-v="bottom">Abajo</button>
      <button class="btn small" data-v="front">Frente</button>
      <button class="btn small" data-v="back">Detrás</button>
      <button class="btn small" data-v="left">Izquierda</button>
      <button class="btn small" data-v="right">Derecha</button>
      <span class="sep"></span>
      <button class="btn small" data-v="fit">Encajar</button>
    </div>
    <div class="banner" id="banner" hidden></div>
    <div class="sketch" id="sketch">
      <div class="sketchbar" id="sketchbar"></div>
      <div class="sketchhint" id="sketchhint"></div>
    </div>
    <div class="loading" id="loading">Cargando el motor geométrico…</div>
  </section>
  <aside class="side right" id="props"></aside>
</div>
<footer class="status"><span id="st-engine">Motor: cargando</span><span id="st-msg"></span><span class="spacer"></span><span>Unidades: mm</span></footer>
<dialog id="dlg"></dialog>
<input type="file" id="file" accept=".json,application/json" hidden />
`;

const viewport = new Viewport($("#view"));
const sketcher = new SketchEditor($("#sketch"), {
  onChange: (commit) => changed(commit),
  onSelect: () => renderProps(),
  ev: (e) => evaluate(e, resolved.vars),
});

// ======================================================================
// Motor (trabajador en segundo plano)
// ======================================================================

const worker = new Worker(new URL("./cad.worker.ts", import.meta.url), { type: "module" });
const exportWaiters = new Map<number, (m: Extract<WorkerOut, { kind: "exported" }>) => void>();

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
    viewport.setBodies(m.bodies);
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
  } else if (m.kind === "exported") {
    exportWaiters.get(m.seq)?.(m);
    exportWaiters.delete(m.seq);
  }
};

/** Pasos que, mientras los editas, muestran la pieza como estaba antes de ellos */
const BEFORE_TYPES = new Set<Feature["type"]>(["fillet", "chamfer", "sketch", "shell", "hole", "rod"]);
const FACE_PICK_TYPES = new Set<Feature["type"]>(["shell", "hole", "rod"]);

let rebuildTimer = 0;
function rebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    resolved = resolveDoc(doc);
    renderSketchLines();
    if (!engineReady) return;
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
  if (active && doc.features.find((f) => f.id === active)?.type === "sketch") sketcher.render();
}

function setDoc(d: Doc, id = docId, resetHistory = true) {
  doc = d;
  docId = id;
  active = null;
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
  if (active && !doc.features.some((f) => f.id === active)) active = null;
  storage.save(docId, doc);
  renderAll();
  rebuild();
}

function renderUndo() {
  ($("#undo") as HTMLButtonElement).disabled = !history.canUndo;
  ($("#redo") as HTMLButtonElement).disabled = !history.canRedo;
}

// ======================================================================
// Panel izquierdo: añadir, pasos, variables
// ======================================================================

const ADD: { type: Feature["type"]; key?: string }[] = [
  { type: "sketch" }, { type: "extrude" }, { type: "revolve" }, { type: "fillet" },
  { type: "box" }, { type: "cylinder" }, { type: "sphere" }, { type: "chamfer" },
  { type: "shell" }, { type: "pattern" }, { type: "hole" }, { type: "rod" },
];
const ADD_LABEL: Partial<Record<Feature["type"], string>> = { extrude: "Extruir", revolve: "Revolución", hole: "Agujeros", rod: "Varilla" };

function renderTools() {
  const box = $("#tools");
  box.innerHTML = "";
  const hasSketch = doc.features.some((f) => f.type === "sketch");
  const hasBody = !!build?.bodies.length;
  for (const t of ADD) {
    const needSketch = t.type === "extrude" || t.type === "revolve";
    const needBody = ["fillet", "chamfer", "shell", "pattern", "hole", "rod"].includes(t.type);
    box.append(h("button", {
      class: "tool",
      disabled: (needSketch && !hasSketch) || (needBody && !hasBody),
      title: needSketch && !hasSketch ? "Primero haz un boceto" : needBody && !hasBody ? "Primero crea un sólido" : "",
      onclick: () => addFeature(t.type),
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
  viewport.pickMode = f?.type === "fillet" || f?.type === "chamfer" ? "edge" : f && FACE_PICK_TYPES.has(f.type) ? "face" : "none";
  renderTree();
  renderProps();
  renderBanner();
  rebuild();
}

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
  const users = doc.features.filter((f) => (f.type === "extrude" || f.type === "revolve") && f.sketch === id);
  if (users.length && !confirmInline(`Este boceto lo usa «${users.map((u) => u.name).join(", ")}». ¿Borrarlo igualmente?`)) return;
  doc.features = doc.features.filter((f) => f.id !== id);
  if (active === id) setActive(null);
  changed(true, true);
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
      for (const [k, v] of Object.entries(o)) out[k] = k === "id" || k === "name" || k === "type" || k === "sketch" || k === "target" ? v : walk(v);
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
  if (!box) return;
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
      h("h3", { class: "mt" }, "Ratón"),
      h("div", { class: "empty" }, "Botón izquierdo: girar · derecho: desplazar · rueda: zoom"),
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
    case "fillet":
    case "chamfer": {
      sec.append(exprField(f.type === "fillet" ? "Radio" : "Distancia", () => f.size, (v) => (f.size = v), k("size")));
      sec.append(h("div", { class: "msg info" }, `Haz clic en las aristas de la vista 3D para elegirlas (otro clic la quita). Elegidas: ${f.edges.length}.`));
      if (f.edges.length) sec.append(h("button", { class: "btn small", onclick: () => { f.edges = []; changed(true, true); renderMarks(); } }, "Quitar todas"));
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
  }
  sec.append(h("div", { class: "actions" },
    h("button", { class: "btn primary", onclick: () => setActive(null) }, "Hecho"),
  ));
}

function renderPatternProps(sec: HTMLElement, f: PatternFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  const idx = doc.features.indexOf(f);
  const sources = doc.features.slice(0, idx).filter((x) => ["extrude", "revolve", "box", "cylinder", "sphere", "hole", "rod", "pattern"].includes(x.type));
  sec.append(selectField("Tipo", f.kind, [["linear", "En fila / rejilla"], ["circular", "En círculo"], ["mirror", "Simetría (espejo)"]], (v) => (f.kind = v as PatternKind)));
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
    if (v !== "face") f.plane = { kind: "std", name: v as StdPlane, offset: f.plane.offset };
  }));
  sec.append(exprField("Desfase", () => f.plane.offset, (v) => (f.plane.offset = v), `${f.id}:offset`, { hint: "separa el plano en su normal" }));
  sec.append(h("button", { class: "btn small", onclick: startFacePick }, "Dibujar sobre una cara de la pieza…"));

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
  ps.append(checkField("Es un agujero", p.hole, (v) => (p.hole = v)));
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
          p.pts.length > 3 ? h("button", { class: "btn small", title: "Quitar punto", onclick: () => { p.pts.splice(i, 1); changed(true, true); } }, "✕") : h("span"),
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
  ["circle", "◯ Círculo", "C"], ["ngon", "⬡ Polígono", "P"],
];

function renderSketchBar() {
  const bar = $("#sketchbar");
  bar.innerHTML = "";
  for (const [t, label, key] of SK_TOOLS) {
    bar.append(h("button", { class: `btn small ${sketcher.tool === t ? "on" : ""}`, title: `Atajo: ${key}`, onclick: () => { sketcher.setTool(t); renderSketchBar(); } }, label));
  }
  const snap = h("button", { class: `btn small ${sketcher.snapOn ? "on" : ""}`, title: "Ajustar a la rejilla (Mayús lo suspende)", onclick: () => { sketcher.snapOn = !sketcher.snapOn; renderSketchBar(); } }, "# Rejilla");
  bar.append(snap, h("button", { class: "btn small", onclick: () => sketcher.fitView() }, "Encajar"));
  bar.append(h("span", { class: "spacer" }));
  bar.append(h("button", { class: "btn small primary", onclick: () => setActive(null) }, "✓ Terminar boceto"));
  $("#sketchhint").innerHTML = `${TOOL_HINT[sketcher.tool]} · Rueda: zoom · Botón derecho o central: desplazar`;
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
  if (f?.type === "shell") {
    // otro clic cerca de un punto ya elegido lo quita
    const near = f.faces.findIndex((q) => Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]) < 3);
    if (near >= 0) f.faces.splice(near, 1);
    else f.faces.push(point.map((c) => Math.round(c * 1000) / 1000) as Vec3);
    changed(true, true);
    return;
  }
  if (f?.type === "hole" || f?.type === "rod") {
    const n = normal.map((c) => Math.round(c * 1e6) / 1e6) as Vec3;
    // redondeo a 0,5 mm y vuelta al plano de la cara, para que las medidas salgan limpias
    let q = point.map((c) => Math.round(c * 2) / 2) as Vec3;
    const d = (point[0] - q[0]) * n[0] + (point[1] - q[1]) * n[1] + (point[2] - q[2]) * n[2];
    q = [q[0] + n[0] * d, q[1] + n[1] * d, q[2] + n[2] * d].map((c) => Math.round(c * 1000) / 1000) as Vec3;
    f.points.push({ x: fmt(q[0]), y: fmt(q[1]), z: fmt(q[2]), n });
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
  if (near >= 0) f.edges.splice(near, 1);
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
    b.textContent = `${f.name}: elige aristas con un clic`;
  } else if (f?.type === "shell") {
    b.hidden = false;
    b.textContent = `${f.name}: clic en la cara que queda abierta`;
  } else if (f?.type === "hole" || f?.type === "rod") {
    b.hidden = false;
    b.textContent = `${f.name}: clic en una cara para colocar cada uno`;
  } else b.hidden = true;
}

function renderMarks() {
  const f = doc.features.find((x) => x.id === active);
  let plane = null;
  if (f?.type === "sketch") {
    const rf = resolved.features.find((x) => x.id === f.id) as Resolved<SketchFeature> | undefined;
    if (rf) plane = planeBasis(rf.plane as never);
  }
  const pins = f && (f.type === "hole" || f.type === "rod")
    ? ((resolved.features.find((x) => x.id === f.id) as Resolved<HoleFeature> | undefined)?.points ?? []).map((p) => ({ p: [p.x, p.y, p.z] as Vec3, n: p.n as Vec3 }))
    : [];
  viewport.setMarks({
    edges: f && (f.type === "fillet" || f.type === "chamfer") ? f.edges : [],
    faces: f?.type === "shell" ? f.faces : [],
    pins,
    plane: pickingFace ? null : plane,
  });
}

/** Dibuja en 3D los bocetos que aún no se han usado (y el activo) */
function renderSketchLines() {
  const used = new Set(doc.features.flatMap((f) => (f.type === "extrude" || f.type === "revolve") && !f.off ? [f.sketch] : []));
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
  worker.postMessage({ kind: "export", seq: s, features: resolveDoc(doc).features, format });
}

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

function fileAction(a: string) {
  if (a === "new") setDoc(emptyDoc(), uid());
  else if (a === "example") setDoc(exampleDoc(), uid());
  else if (a === "dup") { const d: Doc = JSON.parse(JSON.stringify(doc)); d.name += " (copia)"; setDoc(d, uid()); toast("Copia creada"); }
  else if (a === "open") openDialog();
  else if (a === "save-file") download(JSON.stringify(doc, null, 2), `${safeName()}.geometria.json`, "application/json");
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
document.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => b.addEventListener("click", () => (b.dataset.v === "fit" ? viewport.fit() : viewport.view(b.dataset.v as ViewName))));

// perspectiva / isométrica (se recuerda en este navegador)
const PERSP_KEY = "geometria:perspectiva";
try { viewport.perspective3d = localStorage.getItem(PERSP_KEY) !== "no"; } catch { /* sin almacenamiento */ }
function renderPerspBtn() {
  $("#persp").textContent = viewport.perspective3d ? "Perspectiva" : "Isométrica";
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
    const map: Record<string, SketchTool> = { s: "select", l: "poly", r: "rect", c: "circle", p: "ngon" };
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
