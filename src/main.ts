import "./style.css";
import type {
  Doc, Feature, SketchFeature, EdgeFeature, BuildResult, WorkerOut, Profile, StdPlane, Vec3, Resolved,
  PatternFeature, PatternKind, Axis, HoleFeature, RodFeature, HoleKind,
  TextFeature, TextFont, SweepFeature, ExtrudeFeature, GearFeature, CombineFeature, LoftFeature, ImportFeature, ReliefFeature, RefPlaneFeature, TransformFeature, PlaneDef, LayFlatFeature, PushPullFeature, ComponentFeature, DrawingView, DrawingDim, JointFeature, Clash, CatalogFeature, SplitFeature, BodyInfo, BodyMesh,
} from "./types";
import { checkPrint, DEFAULT_PRINT, type PrintSettings } from "./printcheck";
import { TEMPLATES } from "./templates";
import { CATALOG, catalogPart } from "./catalog";
import { MATERIALS, material, bodyInfo, bom, bomCsv, KIND_LABEL, type BomBody, type Kind } from "./bim";
import { snapsFromPaths, nearestPoint, nearestCircle, dimValue, dimAttached, dimSvg, type Snaps, type ViewXf } from "./drawdims";
import { files, fileId, toBase64, fromBase64 } from "./files";
import { docForRow, rowFileName, rowFromDoc, currentRow } from "./family";
import { makeZip } from "./zip";
import { readSvg, svgToProfiles } from "./svgimport";
import { solveSketch, cleanConstraints, CONSTRAINT_GLYPH, CONSTRAINT_NAME } from "./constraints";
import { Viewport, type ViewName, type GizmoDelta, type MeasureItem } from "./viewport";
import { SCREWS, SCREW_NAMES, HOLE_KIND_LABEL } from "./screws";
import { SketchEditor, TOOL_HINT, type SketchTool } from "./sketcher";
import { evaluate, fmt, VAR_NAME } from "./expr";
import { planeBasis, planeFromHit, profileLoop, toWorld, uid } from "./geom";
import { edgeShapes } from "./edgeloops";
import { planesAngle } from "./measure";
import { Dxf, addSvgPaths } from "./dxf";
import { cloud, docFileIds, type CloudStatus } from "./cloud";
import {
  emptyDoc, exampleDoc, newFeature, resolveDoc, History, storage, isDoc,
  FEATURE_LABEL, FEATURE_ICON, AUTO_EVERY_MS, myFit, setMyFit, type ResolveOut,
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
/** medida del cuadro de redondear/desfasar del boceto */
let sketchAmount = "2";
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
    <div class="menu-h">Piezas</div>
    <button data-a="new">Pieza nueva<kbd>N</kbd></button>
    <button data-a="open">Mis piezas…<kbd>O</kbd><small>Galería con miniaturas</small></button>
    <button data-a="templates">Plantillas…<small>Caja, bisagra, engranajes, muelle, clip, tornillo</small></button>
    <button data-a="dup">Duplicar esta pieza</button>
    <div class="menu-h">Versiones</div>
    <button data-a="version">Guardar versión…<kbd>Ctrl S</kbd><small>Una foto de cómo está ahora, con nombre</small></button>
    <button data-a="history">Historial de versiones…<small>Volver a como estaba antes</small></button>
    <div class="menu-h">Ajustes de la pieza</div>
    <button data-a="family">Familia de tamaños…<small>La misma pieza en varias medidas; exportarlas todas</small></button>
    <button data-a="fit">Mi holgura…<small>La que encaja bien en tu impresora</small></button>
    <div class="menu-h">Archivo</div>
    <button data-a="save-file">Descargar proyecto (.json)<small>Para guardarlo o pasarlo a otro equipo</small></button>
    <button data-a="load-file">Cargar proyecto (.json)…</button>
    <div class="menu-h">Ayuda</div>
    <button data-a="example">Abrir el ejemplo</button>
    <button data-a="keys">Atajos de teclado<kbd>?</kbd></button>
  </div></div>
  <div class="menu" id="m-export"><button class="btn primary">Exportar ▾</button><div class="menu-list">
    <button data-f="3mf">3MF<small>Para Bambu Studio, Orca, Prusa (recomendado)</small></button>
    <button data-f="stl">STL<small>Para cualquier programa de impresión</small></button>
    <button data-f="step">STEP<small>Para Rhino, Fusion, FreeCAD…</small></button>
    <div class="menu-h">2D (DXF, en mm)</div>
    <button data-dxf="views">Vistas de la pieza<small>Frente, arriba, derecha y 3D, para Rhino o AutoCAD</small></button>
    <button data-dxf="sketch">El boceto abierto<small>Para corte láser o CNC</small></button>
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
        <button class="btn small rbtn" id="explode" title="Vista explosionada: separar las piezas de un ensamblaje y grabar un vídeo"><i>💥</i><span>Explosionar</span></button>
        <button class="btn small rbtn" id="bom" title="Listado de piezas: materiales, pesos y costes (BIM)"><i>🧾</i><span>Piezas</span></button>
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
    <div class="secpanel explpanel" id="explpanel" hidden></div>
    <div class="secpanel selpanel" id="selpanel" hidden></div>
    <div class="secpanel hidechip" id="hidechip" hidden></div>
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
<footer class="status"><span id="st-engine">Motor: cargando</span><span id="st-msg"></span><span class="spacer"></span><span id="st-cloud"></span><span>Unidades: mm</span></footer>
<dialog id="dlg"></dialog>
<input type="file" id="file" accept=".json,application/json" hidden />
<input type="file" id="file3d" accept=".step,.stp,.stl" hidden />
<input type="file" id="filesvg" accept=".svg,image/svg+xml" hidden />
<input type="file" id="fileimg" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
<input type="file" id="filerelief" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
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
const collideWaiters = new Map<number, (m: Extract<WorkerOut, { kind: "collide" }>) => void>();
let collideSeq = 0;
/** Pregunta al motor qué cuerpos se meten unos en otros con estos pasos */
function askCollide(features: Resolved<Feature>[], mesh: boolean) {
  return new Promise<Extract<WorkerOut, { kind: "collide" }>>((res) => {
    const s = ++collideSeq;
    collideWaiters.set(s, res);
    worker.postMessage({ kind: "collide", seq: s, features, mesh });
  });
}
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
    if (hiddenBodies.size) renderHidden();
    if (section) viewport.setSection(section);
    lastBuildFull = buildFullBySeq === m.seq;
    if (lastBuildFull && m.bodies.length) scheduleThumb();
    if (clashOn && lastBuildFull && !sweeping) void runClashCheck();
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
  } else if (m.kind === "collide") {
    collideWaiters.get(m.seq)?.(m);
    collideWaiters.delete(m.seq);
  } else if (m.kind === "drawing") {
    drawingWaiters.get(m.seq)?.(m);
    drawingWaiters.delete(m.seq);
  } else if (m.kind === "exported") {
    exportWaiters.get(m.seq)?.(m);
    exportWaiters.delete(m.seq);
  }
};

/** Pasos que, mientras los editas, muestran la pieza como estaba antes de ellos */
const BEFORE_TYPES = new Set<Feature["type"]>(["fillet", "chamfer", "sketch", "shell", "hole", "rod", "text", "layflat", "pushpull"]);
const FACE_PICK_TYPES = new Set<Feature["type"]>(["shell", "hole", "rod", "text", "layflat", "pushpull"]);

/** Archivos importados que el motor ya tiene */
const sentFiles = new Set<string>();
/** Pasa una imagen a grises (sobre fondo blanco), como mucho 800 px de lado */
async function grayImage(data: ArrayBuffer): Promise<{ w: number; h: number; data: Uint8Array }> {
  const bmp = await createImageBitmap(new Blob([data]));
  const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const w = Math.max(2, Math.round(bmp.width * k)), hh = Math.max(2, Math.round(bmp.height * k));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = hh;
  const cx = cv.getContext("2d", { willReadFrequently: true })!;
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, w, hh);
  cx.drawImage(bmp, 0, 0, w, hh);
  bmp.close();
  const px = cx.getImageData(0, 0, w, hh).data;
  const out = new Uint8Array(w * hh);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  return { w, h: hh, data: out };
}
async function sendFiles() {
  for (const f of doc.features) {
    if (f.type === "relief" && f.file && !sentFiles.has(f.file)) {
      sentFiles.add(f.file);
      const st = await files.get(f.file);
      if (!st) { sentFiles.delete(f.file); continue; }
      try {
        const g = await grayImage(st.data);
        worker.postMessage({ kind: "gray", id: f.file, ...g }, [g.data.buffer]);
      } catch { toast("No se pudo leer la imagen del relieve"); }
      continue;
    }
    if (f.type !== "import" || !f.file || sentFiles.has(f.file)) continue;
    sentFiles.add(f.file);
    const st = await files.get(f.file);
    if (!st || st.format === "image") { sentFiles.delete(f.file); continue; }
    worker.postMessage({ kind: "file", id: f.file, format: st.format, data: st.data });
  }
}

let rebuildTimer = 0;
/** la última construcción enseña la pieza entera (no a medias por estar editando un paso) */
let lastBuildFull = false, buildFullBySeq = -1;
function rebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    resolved = resolveDoc(doc);
    renderSketchLines();
    if (!engineReady) return;
    void sendFiles();
    const f = doc.features.find((x) => x.id === active);
    // al editar un boceto o un redondeo se ve la pieza como estaba antes de ese paso
    // al mover un cuerpo se ve la pieza justo después de ese paso (aún sin los siguientes)
    const upTo = f && BEFORE_TYPES.has(f.type) ? f.id : f?.type === "transform" || f?.type === "joint" || f?.type === "split" ? doc.features[doc.features.indexOf(f) + 1]?.id : undefined;
    worker.postMessage({ kind: "build", seq: ++seq, features: resolved.features, upTo });
    if (!upTo) buildFullBySeq = seq;
  }, 90);
}

// ======================================================================
// Cambios, deshacer y guardado
// ======================================================================

/** Guarda en el navegador y, si hay servidor, deja la pieza lista para subirse */
function saveDoc(id: string, d: Doc) {
  storage.save(id, d);
  cloud.saved(id);
}

let saveTimer = 0;
function changed(commit = true, structural = false) {
  rebuild();
  if (structural) { renderTree(); renderProps(); }
  if (commit) {
    history.push(JSON.stringify(doc));
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveDoc(docId, doc); autoVersion(); }, 300);
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

/** Cada 10 minutos de trabajo se guarda sola una versión (si hubo cambios) */
function autoVersion() {
  const last = storage.versions(docId).find((v) => v.auto)?.t ?? 0;
  if (Date.now() - last < AUTO_EVERY_MS) return;
  storage.addVersion(docId, { t: Date.now(), name: "Automática", auto: true, doc: JSON.stringify(doc) });
}

/** Miniatura para la galería: cuando la pieza entera está a la vista y lleva un rato quieta */
let thumbTimer = 0;
function scheduleThumb() {
  clearTimeout(thumbTimer);
  const id = docId;
  thumbTimer = window.setTimeout(() => {
    if (id !== docId || !lastBuildFull) return;
    const url = viewport.thumbnail();
    if (url) storage.setThumb(id, url);
  }, 1500);
}

function setDoc(d: Doc, id = docId, resetHistory = true) {
  doc = d;
  docId = id;
  active = null;
  selBody = null;
  hiddenBodies.clear();
  renderHidden();
  resolved = resolveDoc(doc);
  sketcher.close();
  $("#sketch").classList.remove("on");
  document.body.classList.remove("sketching");
  if (resetHistory) history.reset(JSON.stringify(doc));
  saveDoc(docId, doc);
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
  saveDoc(docId, doc);
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

const ADD_LABEL: Partial<Record<Feature["type"], string>> = {
  extrude: "Extruir", revolve: "Revolución", hole: "Agujeros", rod: "Varilla", loft: "Transición", import: "Importar",
  component: "Pieza", layflat: "Apoyar", pushpull: "Empujar", transform: "Mover", combine: "Combinar", joint: "Unión", catalog: "Catálogo", split: "Partir", relief: "Relieve", plane: "Plano ref.",
};
const ADD_TITLE: Partial<Record<Feature["type"], string>> = {
  sweep: "Un perfil que recorre un camino (tubos, asas, muelles…)",
  loft: "Transición suave entre dos o más bocetos (de cuadrado a círculo…)",
  text: "Letras en relieve o grabadas",
  plane: "Plano de referencia: un plano tuyo (desplazado, inclinado o sobre una cara) para dibujar bocetos encima",
  relief: "Desde una imagen: un logo en relieve (o grabado) o una litofanía con las alturas de una foto",
  import: "Traer una pieza STEP o STL de otro programa",
  component: "Meter aquí una de tus piezas guardadas, con sus medidas cambiables",
  layflat: "Girar la pieza para apoyarla sobre una cara al imprimir",
  pushpull: "Empujar o hundir una cara plana: arrastra la flecha y la pieza crece o se hunde (P)",
  transform: "Mover, girar o escalar un cuerpo (o una copia), con flechas o con números",
  combine: "Sumar, restar o intersecar cuerpos que ya existen",
  catalog: "Piezas que se compran (rodamientos, imanes, insertos, tuercas, perfil 2020, servo, NEMA 17), o el hueco justo para meterlas",
  split: "Partir una pieza que no cabe en la cama, con espigas para unir las partes",
  joint: "Ensamblaje: une cuerpos con una bisagra (gira) o una guía (desliza) y comprueba si chocan al moverse",
  gear: "Rueda dentada recta: eliges el módulo y los dientes",
  spring: "Muelle de compresión: diámetro, hilo, paso y vueltas",
};

/** Herramientas por grupos, en el orden en que se suelen usar */
const TOOL_GROUPS: { name: string; types: Feature["type"][] }[] = [
  { name: "Dibujar", types: ["sketch", "plane"] },
  { name: "Crear", types: ["extrude", "revolve", "box", "cylinder", "sphere", "sweep", "loft", "text", "relief", "gear", "spring"] },
  { name: "Modificar", types: ["pushpull", "fillet", "chamfer", "shell", "hole", "rod", "pattern", "transform", "combine", "split"] },
  { name: "Montar e importar", types: ["joint", "catalog", "component", "import", "layflat"] },
];
/** atajos de teclado de las herramientas (se ven en su globo) */
const TOOL_KEY: Partial<Record<Feature["type"], string>> = { sketch: "B", extrude: "E", fillet: "F", transform: "M", hole: "H", box: "C", text: "T", pushpull: "P" };
const closedGroups = new Set<string>((() => { try { return JSON.parse(localStorage.getItem("geometria:grupos") ?? "[]") as string[]; } catch { return []; } })());

/** Pulsa una herramienta de «Añadir» (desde el botón o con su atajo) */
function useTool(type: Feature["type"]) {
  if (type === "import") $("#file3d").click();
  else if (type === "relief") { replacingRelief = null; $("#filerelief").click(); }
  else if (type === "component") componentDialog();
  else if (type === "sketch" || type === "plane") whereDialog(type);
  else addFeature(type);
}
function toolDisabled(type: Feature["type"]) {
  const hasSketch = doc.features.some((f) => f.type === "sketch");
  const hasBody = !!build?.bodies.length;
  const needSketch = type === "extrude" || type === "revolve" || type === "sweep" || type === "loft";
  const needBody = ["pushpull", "fillet", "chamfer", "shell", "pattern", "hole", "rod", "layflat", "transform", "combine", "joint", "split"].includes(type);
  return needSketch && !hasSketch ? "Primero haz un boceto" : needBody && !hasBody ? "Primero crea un sólido" : "";
}

function renderTools() {
  const box = $("#tools");
  box.innerHTML = "";
  for (const g of TOOL_GROUPS) {
    const closed = closedGroups.has(g.name);
    box.append(h("button", { class: `tool-h ${closed ? "closed" : ""}`, title: closed ? "Mostrar" : "Ocultar", onclick: () => {
      if (closed) closedGroups.delete(g.name); else closedGroups.add(g.name);
      try { localStorage.setItem("geometria:grupos", JSON.stringify([...closedGroups])); } catch { /* sin sitio: da igual */ }
      renderTools();
    } }, h("span", {}, closed ? "▸" : "▾"), g.name));
    if (closed) continue;
    const grid = h("div", { class: "tools-g" });
    for (const type of g.types) {
      const why = toolDisabled(type);
      const key = TOOL_KEY[type];
      grid.append(h("button", {
        class: "tool", disabled: !!why,
        title: why || `${ADD_TITLE[type] ?? FEATURE_LABEL[type]}${key ? ` · Atajo: ${key}` : ""}`,
        onclick: () => useTool(type),
      }, h("b", {}, FEATURE_ICON[type]), ADD_LABEL[type] ?? FEATURE_LABEL[type]));
    }
    box.append(grid);
  }
}


function addFeature(type: Feature["type"]) {
  const f = newFeature(doc, type);
  if (f.type === "split") {
    // por defecto, por la mitad del último cuerpo y a lo largo de su lado más largo
    const last = build?.bodies.at(-1);
    const bb = last ? viewport.bodyBox(last.id) : null;
    if (bb) {
      const size = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
      const ax = size.indexOf(Math.max(...size));
      f.axis = (["x", "y", "z"] as const)[ax];
      f.at = fmt(Math.round(((bb[0][ax] + bb[1][ax]) / 2) * 10) / 10);
    }
  }
  doc.features.push(f);
  setActive(f.id);
  changed(true, true);
}

/** Extruye un boceto ya hecho: si está sobre una cara de la pieza, resta (un hueco); si no, suma */
function extrudeSketch(sketchId: string) {
  const sk = doc.features.find((x) => x.id === sketchId);
  if (sk?.type !== "sketch") return;
  const f = newFeature(doc, "extrude") as ExtrudeFeature;
  f.sketch = sketchId;
  const i = doc.features.indexOf(sk);
  doc.features.splice(i + 1, 0, f);
  setActive(f.id);
  changed(true, true);
}

function setActive(id: string | null) {
  active = id;
  // al editar un paso las piezas vuelven a su sitio (los clics sobre caras tienen que cuadrar)
  if (id && explode) { explode = null; renderExplode(); }
  if (id) selBody = null;
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
  // escribiendo el nombre de una carpeta: no rehacer la lista (se perdería lo escrito)
  if ((document.activeElement as HTMLElement | null)?.classList.contains("grp-name")) return;
  renderTools();
  const ul = $("#tree");
  ul.innerHTML = "";
  if (!doc.features.length) {
    ul.append(h("li", { class: "empty start" }, "Para empezar:",
      h("div", { class: "seg-btns" },
        h("button", { class: "btn small", onclick: () => useTool("sketch") }, "✎ Un boceto"),
        h("button", { class: "btn small", onclick: () => useTool("box") }, "▣ Una caja"),
        h("button", { class: "btn small", onclick: () => templatesDialog() }, "Una plantilla…"),
        h("button", { class: "btn small", onclick: () => openDialog() }, "Mis piezas…"))));
    return;
  }
  if (treeSel.size) {
    const n = treeSel.size;
    const into = (g: string) => { doc.features.forEach((f) => { if (treeSel.has(f.id)) f.group = g; }); treeSel.clear(); treeAnchor = -1; changed(true, true); };
    ul.append(h("li", { class: "grp-bar" },
      h("button", { class: "btn small primary", onclick: makeGroup }, `📁 Meter ${n === 1 ? "1 paso" : `${n} pasos`} en una carpeta`),
      ...groupNames().map((g) => h("button", { class: "btn small", onclick: () => into(g) }, `en «${g}»`)),
      h("button", { class: "btn small", onclick: () => { treeSel.clear(); treeAnchor = -1; renderTree(); } }, "Cancelar")));
  }
  // carpetas: pasos seguidos con la misma carpeta van juntos bajo su cabecera
  const folded = new Set(doc.folded ?? []);
  let lastGroup: string | undefined;
  doc.features.forEach((f, i) => {
    if (f.group && f.group !== lastGroup) ul.append(groupHeader(f.group, i));
    lastGroup = f.group;
    if (f.group && folded.has(f.group) && f.id !== active) return;
    const err = build?.errors[f.id] || Object.keys(resolved.fieldErrors).some((k) => k.startsWith(f.id + ":"));
    const li = h("li", {
      class: `${f.id === active ? "active" : ""} ${f.off ? "off" : ""} ${f.group ? "in-group" : ""} ${treeSel.has(f.id) ? "picked" : ""}`,
      title: typeof err === "string" ? err : err ? "Hay una medida que no se entiende" : "Mayús+clic: elegir varios para meterlos en una carpeta",
      onclick: (e: MouseEvent) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) { pickRange(i, e.shiftKey); return; }
        if (treeSel.size) { treeSel.clear(); }
        setActive(f.id === active ? null : f.id);
      },
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

// ---------- carpetas en la lista de pasos ----------
/** pasos elegidos con Mayús+clic (para meterlos en una carpeta) */
const treeSel = new Set<string>();
let treeAnchor = -1;
function pickRange(i: number, range: boolean) {
  const id = doc.features[i].id;
  if (range && treeAnchor >= 0) {
    const [a, b] = [Math.min(treeAnchor, i), Math.max(treeAnchor, i)];
    for (let k = a; k <= b; k++) treeSel.add(doc.features[k].id);
  } else if (treeSel.has(id)) treeSel.delete(id);
  else treeSel.add(id);
  // el paso abierto también cuenta, para que Mayús+clic desde él coja el tramo
  if (active && range && treeAnchor < 0) treeSel.add(active);
  treeAnchor = i;
  renderTree();
}
function groupNames() { return [...new Set(doc.features.map((f) => f.group).filter((g): g is string => !!g))]; }
function makeGroup() {
  const ids = doc.features.filter((f) => treeSel.has(f.id));
  if (!ids.length) return;
  let k = groupNames().length + 1, name = `Carpeta ${k}`;
  while (groupNames().includes(name)) name = `Carpeta ${++k}`;
  // los pasos de la carpeta se juntan donde estaba el primero (el orden entre ellos se mantiene)
  const first = doc.features.findIndex((f) => treeSel.has(f.id));
  const before = doc.features.slice(0, first).filter((f) => !treeSel.has(f.id));
  const after = doc.features.slice(first).filter((f) => !treeSel.has(f.id));
  ids.forEach((f) => (f.group = name));
  doc.features = [...before, ...ids, ...after];
  treeSel.clear(); treeAnchor = -1;
  changed(true, true);
  renamingGroup = name;
  renderTree();
}
let renamingGroup: string | null = null;
function groupHeader(name: string, at: number) {
  // los pasos seguidos de esta carpeta, desde «at»
  const run: Feature[] = [];
  for (let j = at; j < doc.features.length && doc.features[j].group === name; j++) run.push(doc.features[j]);
  const folded = (doc.folded ?? []).includes(name);
  const allOff = run.every((f) => f.off);
  const toggle = () => {
    const set = new Set(doc.folded ?? []);
    if (folded) set.delete(name); else set.add(name);
    doc.folded = [...set];
    if (!doc.folded.length) delete doc.folded;
    changed(true);
    renderTree();
  };
  const rename = (v: string) => {
    if (renamingGroup !== name) return; // ya guardado (Intro y luego el blur)
    const nv = v.trim();
    renamingGroup = null;
    (document.activeElement as HTMLElement | null)?.blur();
    if (nv && nv !== name) {
      doc.features.forEach((f) => { if (f.group === name) f.group = nv; });
      if (doc.folded?.includes(name)) doc.folded = doc.folded.map((g) => (g === name ? nv : g));
      changed(true);
    }
    renderTree();
  };
  const label = renamingGroup === name
    ? (() => {
        const inp = h("input", { class: "grp-name", value: name, title: "Nombre de la carpeta (Intro para guardar)" }) as HTMLInputElement;
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") rename(inp.value); if (e.key === "Escape") { renamingGroup = null; inp.blur(); renderTree(); } e.stopPropagation(); });
        inp.addEventListener("blur", () => rename(inp.value));
        inp.addEventListener("click", (e) => e.stopPropagation());
        setTimeout(() => { inp.focus(); inp.select(); });
        return inp;
      })()
    : h("span", { class: "nm", title: "Doble clic para cambiar el nombre" }, name);
  const li = h("li", { class: `grp ${folded ? "folded" : ""} ${allOff ? "off" : ""}`, onclick: toggle },
    h("span", { class: "ic" }, folded ? "▸" : "▾"),
    label,
    h("span", { class: "grp-n" }, String(run.length)),
    h("button", { class: "act", title: allOff ? "Encender todos" : "Apagar todos (saltar estos pasos)", onclick: (e: Event) => { e.stopPropagation(); run.forEach((f) => (f.off = !allOff)); changed(true, true); } }, allOff ? "◌" : "◉"),
    h("button", { class: "act", title: "Quitar la carpeta (los pasos se quedan)", onclick: (e: Event) => {
      e.stopPropagation();
      run.forEach((f) => delete f.group);
      changed(true, true);
      toast(`Carpeta «${name}» quitada`, { label: "Deshacer", run: () => undoRedo("undo") });
    } }, "✕"),
  );
  li.addEventListener("dblclick", (e) => { e.stopPropagation(); renamingGroup = name; renderTree(); });
  return li;
}

function move(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= doc.features.length) return;
  const [f] = doc.features.splice(i, 1);
  doc.features.splice(j, 0, f);
  changed(true, true);
}

function removeFeature(id: string) {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return;
  const users = doc.features.filter((x) => sketchUses(x).includes(id));
  doc.features = doc.features.filter((x) => x.id !== id);
  if (active === id) setActive(null);
  changed(true, true);
  // sin preguntar: se puede deshacer al momento
  toast(users.length ? `Borrado «${f.name}» (lo usaba «${users[0].name}»)` : `Borrado «${f.name}»`, { label: "Deshacer", run: () => undoRedo("undo") });
}

/** Bocetos que usa un paso */
function sketchUses(f: Feature): string[] {
  if (f.type === "extrude" || f.type === "revolve") return [f.sketch];
  if (f.type === "sweep") return [f.sketch, f.path];
  if (f.type === "loft") return f.sketches;
  return [];
}

/** Botón que pide un segundo clic para confirmar (sin ventanas del navegador) */
function twoClick(label: string, sure: string, run: () => void, cls = "btn small") {
  const b = h("button", { class: cls }, label) as HTMLButtonElement;
  let armed = 0;
  b.addEventListener("click", () => {
    if (armed) { clearTimeout(armed); armed = 0; run(); return; }
    b.textContent = sure; b.classList.add("danger");
    armed = window.setTimeout(() => { armed = 0; b.textContent = label; b.classList.remove("danger"); }, 3000);
  });
  return b;
}

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
    ...(() => {
      // con los materiales de cada pieza (BIM); si no has puesto ninguno, todo PLA
      const b = bom(doc, bomBodies(bodies), myPrices());
      const mixed = b.byMaterial.length > 1 || b.byMaterial[0]?.material !== "pla" || b.rows.some((r) => r.qty > 1);
      return [
        row(mixed ? "Peso con sus materiales" : "Peso en PLA", `${fmtEs(b.totalWeightG)} g`),
        ...(mixed ? [] : [row("Peso en PETG", `${fmtEs(cm3 * 1.27)} g`)]),
        row("Coste aproximado", `${fmtEs(b.totalCost, 2)} €`),
      ];
    })(),
    // filamento de 1,75 mm: sección de 2,405 mm² (solo de lo que se imprime)
    row("Filamento 1,75 mm", `${fmtEs(bodies.filter((b) => bodyInfo(doc, b.id).kind === "print").reduce((s2, b) => s2 + (b.volume || 0) * bodyInfo(doc, b.id).qty, 0) / 2.405 / 1000, 2)} m`),
    h("div", { class: "empty" }, "Calculado como si se imprimiera maciza (100 % de relleno). Con el relleno normal de tu laminador gastará bastante menos."),
  );
  if (bodies.length > 1) box.append(h("div", { class: "empty" }, `Suma de ${bodies.length} cuerpos.`));
  renderColors(box, bodies);
  renderPrintCheck(box);
  renderClashCheck(box);
}

// ---------- BIM: materiales, pesos y listado de piezas ----------
const PRICES_KEY = "geometria:precios";
function myPrices(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(PRICES_KEY) || "{}"); } catch { return {}; }
}
function setPrice(mat: string, v: number) {
  const p = myPrices(); p[mat] = v;
  try { localStorage.setItem(PRICES_KEY, JSON.stringify(p)); } catch { /* sin almacenamiento */ }
}
/** Cuerpos con su volumen y su tamaño, para el listado */
function bomBodies(bodies: BodyMesh[]): BomBody[] {
  return bodies.map((b) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const v = b.vertices;
    for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[i + k]); mx[k] = Math.max(mx[k], v[i + k]); }
    return { id: b.id, name: b.name, volume: b.volume || 0, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] as [number, number, number] };
  });
}
function setInfo(id: string, patch: Partial<BodyInfo>) {
  const cur = { ...(doc.bim?.[id] ?? {}), ...patch };
  (doc.bim ??= {})[id] = cur;
}
function materialSelect(id: string) {
  const inf = bodyInfo(doc, id);
  const sel = h("select", { class: "mat-sel", title: "Material de esta pieza" }) as HTMLSelectElement;
  for (const g of ["Filamento", "Madera", "Metal", "Otros"] as const) {
    const og = h("optgroup", { label: g });
    for (const m of MATERIALS.filter((x) => x.group === g)) og.append(h("option", { value: m.id }, m.name));
    sel.append(og);
  }
  sel.value = inf.material;
  sel.addEventListener("change", () => { setInfo(id, { material: sel.value }); changed(true); renderPieceInfo(); });
  return sel;
}

function bomDialog() {
  const bodies = build?.bodies ?? [];
  if (!bodies.length) return toast("Todavía no hay ninguna pieza");
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const wrap = h("div", { class: "bom-wrap" });
  const totals = h("div", { class: "bom-totals" });
  const draw = () => {
    const out = bom(doc, bomBodies(bodies), myPrices());
    wrap.innerHTML = "";
    const tbl = h("table", { class: "bom" });
    tbl.append(h("thead", {}, h("tr", {}, ...["Pieza", "Cant.", "Tipo", "Material", "Referencia", "Medidas (mm)", "Peso", "Coste", "Notas"].map((t) => h("th", {}, t)))));
    const tb = h("tbody");
    for (const r of out.rows) {
      const qty = h("input", { class: "bom-qty", type: "number", min: "1", step: "1", value: String(r.qty) }) as HTMLInputElement;
      qty.addEventListener("change", () => { setInfo(r.id, { qty: Math.max(1, Math.round(Number(qty.value) || 1)) }); changed(true); draw(); });
      const kind = h("select", { class: "bom-kind" }, ...(Object.keys(KIND_LABEL) as Kind[]).map((k) => h("option", { value: k }, KIND_LABEL[k]))) as HTMLSelectElement;
      kind.value = r.kind;
      kind.addEventListener("change", () => { setInfo(r.id, { kind: kind.value as Kind }); changed(true); draw(); });
      const ref = h("input", { value: r.ref, placeholder: "—" }) as HTMLInputElement;
      ref.addEventListener("change", () => { setInfo(r.id, { ref: ref.value.trim() || undefined }); changed(true); });
      const notes = h("input", { value: r.notes, placeholder: "acabado, proveedor…" }) as HTMLInputElement;
      notes.addEventListener("change", () => { setInfo(r.id, { notes: notes.value.trim() || undefined }); changed(true); });
      let costCell: HTMLElement;
      if (r.kind === "buy") {
        const price = h("input", { class: "bom-price", inputmode: "decimal", value: bodyInfo(doc, r.id).price !== undefined ? String(bodyInfo(doc, r.id).price).replace(".", ",") : "", placeholder: "€/ud" }) as HTMLInputElement;
        price.addEventListener("change", () => { const v = Number(price.value.replace(",", ".")); setInfo(r.id, { price: price.value.trim() && v >= 0 ? v : undefined }); changed(true); draw(); });
        costCell = h("td", {}, price, h("small", { class: "block" }, `${fmtEs(r.totalCost, 2)} €`));
      } else costCell = h("td", { class: "num" }, `${fmtEs(r.totalCost, 2)} €`);
      tb.append(h("tr", {},
        h("td", {}, r.name), h("td", {}, qty), h("td", {}, kind), h("td", {}, materialSelect(r.id)), h("td", {}, ref),
        h("td", { class: "num" }, r.size.map((v) => fmtEs(v)).join(" × ")),
        h("td", { class: "num" }, `${fmtEs(r.totalWeightG)} g`), costCell, h("td", {}, notes)));
    }
    tbl.append(tb);
    wrap.append(tbl);
    // totales por material, con su precio por kilo editable
    totals.innerHTML = "";
    const mt = h("table", { class: "bom bom-mat" });
    mt.append(h("thead", {}, h("tr", {}, h("th", {}, "Material"), h("th", {}, "Peso"), h("th", {}, "Precio (€/kg)"), h("th", {}, "Coste"))));
    const mb = h("tbody");
    for (const m of out.byMaterial) {
      const mat = material(m.material)!;
      const pr = h("input", { class: "bom-price", inputmode: "decimal", value: String(myPrices()[mat.id] ?? mat.price).replace(".", ",") }) as HTMLInputElement;
      pr.addEventListener("change", () => { const v = Number(pr.value.replace(",", ".")); if (v >= 0) { setPrice(mat.id, v); draw(); renderPieceInfo(); } });
      mb.append(h("tr", {}, h("td", {}, m.name), h("td", { class: "num" }, `${fmtEs(m.weightG)} g`), h("td", {}, pr), h("td", { class: "num" }, `${fmtEs(m.cost, 2)} €`)));
    }
    mb.append(h("tr", { class: "bom-sum" }, h("td", {}, "Total"), h("td", { class: "num" }, `${fmtEs(out.totalWeightG)} g`), h("td", {}), h("td", { class: "num" }, `${fmtEs(out.totalCost, 2)} €`)));
    mt.append(mb);
    totals.append(h("h3", { class: "mt" }, "Por material"), mt,
      h("div", { class: "empty" }, "Las impresas, macizas (100 % de relleno): con el relleno de tu laminador pesarán y costarán menos. Los precios por kilo son orientativos: pon los tuyos y se recuerdan."));
  };
  draw();
  dlg.append(h("h2", {}, "Listado de piezas"), wrap, totals,
    h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: () => download(bomCsv(bom(doc, bomBodies(bodies), myPrices()).rows), `${safeName()}-piezas.csv`, "text/csv;charset=utf-8") }, "Descargar CSV (Excel)"),
      h("button", { class: "btn", onclick: () => { $("#printarea").innerHTML = ""; $("#printarea").append(bomPrintSheet(bodies)); dlg.close(); setTimeout(() => window.print(), 50); } }, "Imprimir o guardar PDF"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
  if (!dlg.open) dlg.showModal();
}

/** Hoja para imprimir el listado (sin campos que rellenar) */
function bomPrintSheet(bodies: BodyMesh[]) {
  const out = bom(doc, bomBodies(bodies), myPrices());
  const t = h("table", { class: "bom" });
  t.append(h("thead", {}, h("tr", {}, ...["Pieza", "Cant.", "Tipo", "Material", "Referencia", "Medidas (mm)", "Peso", "Coste", "Notas"].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  for (const r of out.rows) tb.append(h("tr", {}, h("td", {}, r.name), h("td", { class: "num" }, String(r.qty)), h("td", {}, KIND_LABEL[r.kind]), h("td", {}, r.materialName), h("td", {}, r.ref),
    h("td", { class: "num" }, r.size.map((v) => fmtEs(v)).join(" × ")), h("td", { class: "num" }, `${fmtEs(r.totalWeightG)} g`), h("td", { class: "num" }, `${fmtEs(r.totalCost, 2)} €`), h("td", {}, r.notes)));
  for (const m of out.byMaterial) tb.append(h("tr", { class: "bom-sub" }, h("td", { colspan: "6" }, `Total ${m.name}`), h("td", { class: "num" }, `${fmtEs(m.weightG)} g`), h("td", { class: "num" }, `${fmtEs(m.cost, 2)} €`), h("td", {})));
  tb.append(h("tr", { class: "bom-sum" }, h("td", { colspan: "6" }, "Total"), h("td", { class: "num" }, `${fmtEs(out.totalWeightG)} g`), h("td", { class: "num" }, `${fmtEs(out.totalCost, 2)} €`), h("td", {})));
  t.append(tb);
  return h("div", { class: "bom-print" }, h("h1", {}, `Listado de piezas · ${doc.name}`),
    h("p", {}, `${new Date().toLocaleDateString("es-ES")} · Hecho con Geometría · Piezas impresas calculadas macizas`), t);
}
$("#bom").addEventListener("click", bomDialog);

// ---------- colores por cuerpo ----------
const DEFAULT_COLOR = "#9aa7b8";
const PALETTE = ["#e8743b", "#3b7dd8", "#4cae4c", "#d9b43b", "#8a4fd8", "#22201c", "#f4f2ee", "#c8402f"];
function renderColors(box: HTMLElement, bodies: { id: string; name: string }[]) {
  box.append(h("h3", { class: "mt" }, "Colores y materiales",
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
    box.append(h("div", { class: "color-row" }, input, h("span", { class: "grow" }, b.name), materialSelect(b.id), quick));
  });
  box.append(h("div", { class: "empty" }, "Cada cuerpo sale como un objeto aparte en el 3MF, con su color. En Bambu Studio u Orca asígnale después el filamento del AMS a cada objeto (el color guardado sirve de guía; no todos los laminadores lo leen)."));
}

// ---------- vista explosionada ----------
let explode: { k: number; mode: "center" | "up" } | null = null;
function renderExplode() {
  const p = $("#explpanel");
  $("#explode").classList.toggle("on", !!explode);
  p.hidden = !explode;
  p.innerHTML = "";
  if (!explode) { viewport.setExplode(0); return; }
  const e = explode;
  const range = h("input", { type: "range", min: "0", max: "100", value: String(Math.round(e.k * 100)), title: "Cuánto se separan" }) as HTMLInputElement;
  range.addEventListener("input", () => { e.k = Number(range.value) / 100; viewport.setExplode(e.k, e.mode); });
  const modeBtn = (m: "center" | "up", label: string, title: string) => h("button", { class: `btn small ${e.mode === m ? "on" : ""}`, title, onclick: () => { e.mode = m; renderExplode(); viewport.fitExploded(); } }, label);
  const rec = h("button", { class: "btn small", title: "Graba un vídeo de 8 s: se separan, la cámara da una vuelta y se juntan" }, "🎬 Vídeo") as HTMLButtonElement;
  rec.addEventListener("click", async () => {
    if (!Viewport.videoType()) return toast("Este navegador no sabe grabar vídeo");
    rec.disabled = true;
    try {
      const blob = await viewport.recordExplode(8, (f) => { rec.textContent = `Grabando ${Math.round(f * 100)} %`; });
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      download(blob, `${safeName()}-explosionada.${ext}`, blob.type);
      toast(ext === "webm" ? "Vídeo listo (WebM: lo abren Chrome, VLC y WhatsApp Web)" : "Vídeo listo");
    } catch (err) {
      toast("No se pudo grabar: " + (err as Error).message);
    } finally {
      rec.disabled = false;
      rec.textContent = "🎬 Vídeo";
    }
  });
  p.append(
    h("b", {}, "Explosionar"), modeBtn("center", "Desde el centro", "Cada pieza se aleja del centro"), modeBtn("up", "Hacia arriba", "Apiladas: cada pieza sube según su altura"),
    range, rec,
    h("button", { class: "btn small", title: "Juntar las piezas", onclick: () => { explode = null; renderExplode(); } }, "✕"),
  );
  viewport.setExplode(e.k, e.mode);
}
$("#explode").addEventListener("click", () => {
  if (!explode && (build?.bodies.length ?? 0) < 2) return toast("La vista explosionada necesita dos cuerpos o más");
  if (explode) explode = null;
  else { setActive(null); explode = { k: 0.5, mode: "center" }; }
  renderExplode();
  if (explode) viewport.fitExploded();
});

// ---------- familia de tamaños ----------
function familyDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  if (!doc.variables.length) {
    dlg.append(h("h2", {}, "Familia de tamaños"),
      h("p", {}, "Una familia es la misma pieza en varias medidas (por ejemplo, un soporte para M3, M4 y M6). Primero crea variables (abajo a la izquierda, «+ Añadir») y úsalas en las medidas de los pasos."),
      h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
    return dlg.showModal();
  }
  const fam = doc.family ?? { vars: doc.variables.slice(0, 3).map((v) => v.name), rows: [] };
  fam.vars = fam.vars.filter((n) => doc.variables.some((v) => v.name === n));
  const save = () => { doc.family = fam; changed(true); };
  const body = h("div", {});
  const draw = () => {
    body.innerHTML = "";
    body.append(h("h3", {}, "Variables que cambian"));
    const vbox = h("div", { class: "fam-vars" });
    for (const v of doc.variables) {
      const c = h("input", { type: "checkbox", checked: fam.vars.includes(v.name) }) as HTMLInputElement;
      c.addEventListener("change", () => { fam.vars = c.checked ? [...fam.vars, v.name] : fam.vars.filter((n) => n !== v.name); save(); draw(); });
      vbox.append(h("label", { class: "check" }, c, v.name));
    }
    body.append(vbox);
    const cur = currentRow(doc, fam);
    const tbl = h("table", { class: "bom fam" });
    tbl.append(h("thead", {}, h("tr", {}, h("th", {}, "Nombre"), ...fam.vars.map((n) => h("th", {}, n)), h("th", {}, ""))));
    const tb = h("tbody");
    fam.rows.forEach((r, i) => {
      const name = h("input", { value: r.name, class: "fam-name" }) as HTMLInputElement;
      name.addEventListener("change", () => { r.name = name.value; save(); });
      const cells = fam.vars.map((n) => {
        const inp = h("input", { value: r.values[n] ?? "", class: "fam-val", spellcheck: "false" }) as HTMLInputElement;
        inp.addEventListener("change", () => { r.values[n] = inp.value as never; save(); });
        return h("td", {}, inp);
      });
      tb.append(h("tr", { class: i === cur ? "on" : "" }, h("td", {}, name), ...cells, h("td", { class: "fam-act" },
        h("button", { class: "btn small", title: "Poner estas medidas en la pieza", onclick: () => {
          const d = docForRow(doc, fam, i);
          doc.variables = d.variables;
          save(); draw(); toast(`Tamaño «${r.name}»`);
        } }, i === cur ? "✓ Puesto" : "Ver"),
        h("button", { class: "btn small", title: "Quitar fila", onclick: () => { fam.rows.splice(i, 1); save(); draw(); } }, "✕"))));
    });
    tbl.append(tb);
    body.append(tbl);
    if (!fam.rows.length) body.append(h("div", { class: "empty" }, "Aún no hay tamaños. «+ Tamaño» copia las medidas que tiene ahora la pieza; luego cambia las que quieras."));
    body.append(h("div", { class: "seg-btns" },
      h("button", { class: "btn small", onclick: () => { fam.rows.push(rowFromDoc(doc, fam, `Tamaño ${fam.rows.length + 1}`)); save(); draw(); } }, "+ Tamaño")));
  };
  draw();
  const fmtSel = h("select", {}, h("option", { value: "3mf" }, "3MF"), h("option", { value: "stl" }, "STL"), h("option", { value: "step" }, "STEP")) as HTMLSelectElement;
  const go = h("button", { class: "btn primary" }, "Exportar todas (ZIP)") as HTMLButtonElement;
  go.addEventListener("click", async () => {
    if (!fam.rows.length) return toast("Añade al menos un tamaño");
    go.disabled = true;
    try {
      const out: { name: string; data: Uint8Array }[] = [];
      const bad: string[] = [];
      for (let i = 0; i < fam.rows.length; i++) {
        go.textContent = `Exportando ${i + 1} de ${fam.rows.length}…`;
        const d = docForRow(doc, fam, i);
        const r = resolveDoc(d);
        if (Object.keys(r.fieldErrors).length) { bad.push(fam.rows[i].name); continue; }
        const m = await exportFeatures(r.features, fmtSel.value as "3mf" | "stl" | "step", d.colors);
        if (!m.data) { bad.push(fam.rows[i].name); continue; }
        out.push({ name: `${rowFileName(doc.name, fam.rows[i].name, i)}.${fmtSel.value}`, data: new Uint8Array(m.data) });
      }
      if (out.length) download(makeZip(out), `${safeName()}-familia.zip`, "application/zip");
      toast(bad.length ? `Hechas ${out.length}; fallaron: ${bad.join(", ")}` : `${out.length} archivos en el ZIP`);
    } finally {
      go.disabled = false; go.textContent = "Exportar todas (ZIP)";
      rebuild();
    }
  });
  dlg.append(h("h2", {}, "Familia de tamaños"),
    h("p", { class: "empty" }, "La misma pieza en varias medidas. Cada fila es un tamaño: pon sus valores (pueden ser fórmulas) y pulsa «Ver» para probarlo."),
    body,
    h("div", { class: "actions" }, h("label", { class: "inline" }, "Formato ", fmtSel), go, h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
  dlg.showModal();
}

/** Exporta unos pasos ya resueltos (sin tocar la pieza que se ve) */
function exportFeatures(features: ReturnType<typeof resolveDoc>["features"], format: "stl" | "step" | "3mf", colors?: Record<string, string>) {
  return new Promise<Extract<WorkerOut, { kind: "exported" }>>((res) => {
    const s = ++seq;
    exportWaiters.set(s, res);
    worker.postMessage({ kind: "export", seq: s, features, format, colors });
  });
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

// ---------- choques entre cuerpos (ensamblajes) ----------
let clashOn = false;
let clashes: Clash[] | null = null;
let clashBusy = false, clashAgain = false;
/** mientras se recorre una unión no se repite la comprobación normal */
let sweeping = false;

async function runClashCheck() {
  if (clashBusy) { clashAgain = true; return; }
  clashBusy = true;
  try {
    const r = await askCollide(resolveDoc(doc).features, true);
    clashes = r.error ? null : r.clashes;
    if (r.error) toast("No se pudieron comprobar los choques: " + r.error);
  } finally {
    clashBusy = false;
  }
  if (clashAgain) { clashAgain = false; return runClashCheck(); }
  viewport.setClash(clashOn ? (clashes ?? []).flatMap((c) => (c.tris ? [c.tris] : [])) : null);
  if (!$("#props").contains(document.activeElement)) renderPieceInfo();
}

function renderClashCheck(box: HTMLElement) {
  const n = build?.bodies.length ?? 0;
  if (n < 2 && !clashOn) return;
  box.append(h("h3", { class: "mt" }, "Choques entre cuerpos",
    h("button", { class: `btn small ${clashOn ? "on" : ""}`, onclick: () => {
      clashOn = !clashOn;
      clashes = null;
      if (clashOn) void runClashCheck(); else viewport.setClash(null);
      renderPieceInfo();
    } }, clashOn ? "Ocultar" : "Comprobar")));
  if (!clashOn) return;
  if (!clashes) { box.append(h("div", { class: "empty" }, "Mirando…")); return; }
  if (!clashes.length) { box.append(h("div", { class: "msg info" }, `✓ Ningún cuerpo se mete en otro (${n} cuerpos). Tocarse sí está bien.`)); return; }
  for (const c of clashes) box.append(h("div", { class: "msg err" }, `⚠ «${c.nameA}» y «${c.nameB}» se meten uno en otro: ${fmtEs(c.volume, c.volume < 10 ? 2 : 0)} mm³ (en rojo).`));
  box.append(h("div", { class: "empty" }, "Al imprimir piezas que encajan, deja algo de holgura (0,2 a 0,4 mm)."));
}

/** Mueve la unión de su mínimo a su máximo y apunta dónde choca algo */
async function sweepJoint(f: JointFeature, out: HTMLElement, btn: HTMLButtonElement) {
  if (sweeping) return;
  const base = resolveDoc(doc);
  const rf = base.features.find((x) => x.id === f.id) as Resolved<JointFeature> | undefined;
  if (!rf || !(rf.max > rf.min)) { out.className = "msg err"; out.textContent = "Pon un mínimo y un máximo distintos."; return; }
  sweeping = true;
  btn.disabled = true;
  const keep = f.value;
  const N = 24;
  const hits: { v: number; c: Clash[] }[] = [];
  const unit = f.kind === "hinge" ? "°" : " mm";
  try {
    for (let i = 0; i <= N; i++) {
      const v = rf.min + ((rf.max - rf.min) * i) / N;
      out.className = "empty";
      out.textContent = `Probando ${fmtEs(v, 1)}${unit}… (${i + 1} de ${N + 1})`;
      // se ve moverse en la vista 3D mientras se comprueba
      f.value = fmt(Math.round(v * 1000) / 1000);
      rebuild();
      const feats = resolveDoc(doc).features;
      const r = await askCollide(feats, false);
      if (r.error) throw new Error(r.error);
      if (r.clashes.length) hits.push({ v, c: r.clashes });
    }
  } catch (e) {
    out.className = "msg err";
    out.textContent = "No se pudo recorrer: " + (e as Error).message;
    btn.disabled = false;
    return;
  } finally {
    f.value = keep;
    sweeping = false;
    changed(false);
  }
  // afinar dónde empieza y dónde acaba el choque (buscando entre la posición libre y la que choca)
  const clashAt = async (v: number) => {
    f.value = fmt(Math.round(v * 1000) / 1000);
    const r = await askCollide(resolveDoc(doc).features, false);
    return r.clashes.length > 0;
  };
  const step = (rf.max - rf.min) / N;
  let from = hits[0]?.v, to = hits[hits.length - 1]?.v;
  if (hits.length) {
    sweeping = true;
    out.className = "empty";
    out.textContent = "Afinando dónde empieza y acaba el choque…";
    try {
      if (from > rf.min) { let lo = from - step, hi = from; for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2; if (await clashAt(mid)) hi = mid; else lo = mid; } from = hi; }
      if (to < rf.max) { let lo = to, hi = to + step; for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2; if (await clashAt(mid)) lo = mid; else hi = mid; } to = lo; }
    } finally {
      f.value = keep;
      sweeping = false;
      changed(false);
    }
  }
  if (!hits.length) { btn.disabled = false; out.className = "msg info"; out.textContent = `✓ De ${fmtEs(rf.min, 1)} a ${fmtEs(rf.max, 1)}${unit} no choca nada (probado en ${N + 1} posiciones).`; return; }
  const pairs = [...new Set(hits.flatMap((x) => x.c.map((c) => `«${c.nameA}» con «${c.nameB}»`)))];
  out.className = "msg err";
  btn.disabled = false;
  const range = Math.abs(to - from) < 0.05 ? `hacia ${fmtEs(from, 1)}${unit}` : `entre ${fmtEs(from, 1)} y ${fmtEs(to, 1)}${unit}`;
  out.textContent = `⚠ Choca ${range}: ${pairs.join(", ")}. Pon la unión ahí y mira la zona roja con «Comprobar choques» (en la información de la pieza).`;
}

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
    case "transform": {
      const before = build?.bodiesBefore[f.id] ?? [];
      sec.append(selectField("Cuerpo", f.body, [["", "El último"], ...before.map((b) => [b.id, b.name] as [string, string])], (v) => (f.body = v)));
      sec.append(checkField("Hacer una copia (deja el original)", f.copy, (v) => (f.copy = v)));
      sec.append(h("div", { class: "seg-btns" },
        h("button", { class: `btn small ${gizmoMode === "translate" ? "on" : ""}`, onclick: () => { gizmoMode = "translate"; renderGizmo(); renderProps(); } }, "✥ Flechas: mover"),
        h("button", { class: `btn small ${gizmoMode === "rotate" ? "on" : ""}`, onclick: () => { gizmoMode = "rotate"; renderGizmo(); renderProps(); } }, "⟳ Flechas: girar"),
      ));
      sec.append(h("div", { class: "empty" }, "Arrastra las flechas en la vista 3D, o escribe los números."));
      sec.append(h("h3", { class: "mt" }, "Mover (mm)"));
      sec.append(exprField("X", () => f.dx, (v) => (f.dx = v), k("dx")));
      sec.append(exprField("Y", () => f.dy, (v) => (f.dy = v), k("dy")));
      sec.append(exprField("Z", () => f.dz, (v) => (f.dz = v), k("dz")));
      sec.append(h("h3", { class: "mt" }, "Girar (°, sobre su centro)"));
      sec.append(exprField("En X", () => f.rx, (v) => (f.rx = v), k("rx")));
      sec.append(exprField("En Y", () => f.ry, (v) => (f.ry = v), k("ry")));
      sec.append(exprField("En Z", () => f.rz, (v) => (f.rz = v), k("rz")));
      sec.append(h("h3", { class: "mt" }, "Escalar"));
      sec.append(exprField("Escala", () => f.scale, (v) => (f.scale = v), k("scale"), { hint: "1 = igual · 2 = el doble · 0,5 = la mitad" }));
      break;
    }
    case "catalog": {
      const sel = h("select", {}) as HTMLSelectElement;
      for (const g of [...new Set(CATALOG.map((p) => p.group))]) {
        const og = h("optgroup", { label: g });
        for (const p of CATALOG.filter((x) => x.group === g)) og.append(h("option", { value: p.id, ...(p.id === f.part ? { selected: true } : {}) }, p.name));
        sel.append(og);
      }
      sel.value = f.part;
      sel.addEventListener("change", () => { f.part = sel.value; changed(true, true); });
      sec.append(h("div", { class: "field" }, h("label", {}, "Pieza"), sel));
      const part = catalogPart(f.part);
      if (part) sec.append(h("div", { class: "empty" }, part.info));
      sec.append(selectField("Qué poner", f.op === "cut" ? "cut" : f.op === "new" ? "new" : "add", [["cut", "El hueco para meterla (resta)"], ["new", "La pieza, para ver cómo queda"], ["add", "La pieza, sumada al cuerpo"]], (v) => (f.op = v as never)));
      if (f.op !== "new") {
        const before = build?.bodiesBefore[f.id] ?? [];
        if (before.length > 1) sec.append(selectField("Sobre", f.target ?? "", [["", "El último cuerpo"], ...before.map((b) => [b.id, b.name] as [string, string])], (v) => (f.target = v || undefined)));
      }
      if (f.op === "cut") {
        if (part?.kind === "insert") sec.append(h("div", { class: "msg info" }, "El agujero de un inserto va sin holgura: el plástico se funde al meterlo con el soldador."));
        else sec.append(exprField("Holgura", () => f.fit, (v) => (f.fit = v), k("fit"), { hint: `en diámetro; tu holgura es ${fmtEs(myFit(), 2)}` }));
      }
      if (part?.kind === "profile") sec.append(exprField("Largo", () => f.length, (v) => (f.length = v), k("length")));
      sec.append(h("h3", { class: "mt" }, "Dónde"));
      sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x")));
      sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
      sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z")));
      sec.append(exprField("Girar en X", () => f.rx, (v) => (f.rx = v), k("rx"), { unit: "°", hint: "180 = boca abajo (hueco desde la cara de arriba)" }));
      sec.append(exprField("Girar en Z", () => f.rz, (v) => (f.rz = v), k("rz"), { unit: "°" }));
      sec.append(h("div", { class: "empty" }, "El punto X, Y, Z es la boca del hueco (la base de la pieza). En la lista de piezas sale como pieza comprada."));
      break;
    }
    case "split": {
      const before = build?.bodiesBefore[f.id] ?? [];
      sec.append(selectField("Cuerpo", f.body, [["", "El último"], ...before.map((b) => [b.id, b.name] as [string, string])], (v) => (f.body = v)));
      sec.append(selectField("Cortar a lo largo de", f.axis, [["x", "X (corte de lado a lado)"], ["y", "Y (corte de delante a atrás)"], ["z", "Z (corte horizontal)"]], (v) => (f.axis = v as SplitFeature["axis"])));
      sec.append(exprField("Dónde", () => f.at, (v) => (f.at = v), k("at"), { hint: `${f.axis.toUpperCase()} del corte, en mm` }));
      sec.append(h("button", { class: "btn small", onclick: () => {
        // centro del cuerpo entero: parte 1 + parte 2 (quitando la separación)
        const rf = resolveDoc(doc).features.find((x) => x.id === f.id) as Resolved<SplitFeature> | undefined;
        const tgt = f.body || before.at(-1)?.id || "";
        const ax = f.axis === "x" ? 0 : f.axis === "y" ? 1 : 2;
        const a = viewport.bodyBox(tgt), b = viewport.bodyBox(f.id);
        if (!a) return toast("No veo ese cuerpo ahora");
        const hi = b ? b[1][ax] - (rf?.gap ?? 0) : a[1][ax];
        f.at = fmt(Math.round(((a[0][ax] + hi) / 2) * 10) / 10);
        changed(true, true);
      } }, "Partir por la mitad"));
      if (printSt.bedX) sec.append(h("div", { class: "empty" }, `Tu cama es de ${printSt.bedX} × ${printSt.bedY} × ${printSt.bedZ} mm: cada parte tiene que caber.`));
      sec.append(selectField("Unión entre partes", f.pins, [["loose", "Agujeros + espigas sueltas (recomendado)"], ["fixed", "Espigas pegadas a la parte 1"], ["none", "Sin espigas (solo pegar)"]], (v) => (f.pins = v as SplitFeature["pins"])));
      if (f.pins !== "none") {
        sec.append(exprField("Espigas", () => f.count, (v) => (f.count = v), k("count"), { unit: "", hint: "cuántas; se colocan solas donde caben" }));
        sec.append(exprField("Diámetro", () => f.pinD, (v) => (f.pinD = v), k("pinD")));
        sec.append(exprField("Largo total", () => f.pinL, (v) => (f.pinL = v), k("pinL")));
        sec.append(exprField("Holgura", () => f.fit, (v) => (f.fit = v), k("fit"), { hint: `en diámetro; tu holgura es ${fmtEs(myFit(), 2)}` }));
      }
      sec.append(exprField("Separar para verlas", () => f.gap, (v) => (f.gap = v), k("gap"), { hint: "solo para ver las partes; 0 = juntas" }));
      break;
    }
    case "joint": {
      const before = build?.bodiesBefore[f.id] ?? [];
      const hinge = f.kind === "hinge";
      sec.append(selectField("Tipo", f.kind, [["hinge", "Bisagra (gira alrededor de un eje)"], ["slide", "Guía (desliza a lo largo de un eje)"]], (v) => {
        f.kind = v as JointFeature["kind"];
        if (f.kind === "slide" && f.max === "90") { f.min = "0"; f.max = "20"; }
        if (f.kind === "hinge" && f.max === "20") { f.min = "0"; f.max = "90"; }
      }));
      sec.append(h("h3", { class: "mt" }, "Cuerpos que se mueven"));
      if (!before.length) sec.append(h("div", { class: "empty" }, "Aún no hay cuerpos antes de este paso."));
      for (const b of before) sec.append(checkField(b.name, f.bodies.includes(b.id), (v) => { f.bodies = v ? [...f.bodies, b.id] : f.bodies.filter((t) => t !== b.id); }));
      sec.append(selectField("Eje", f.axis, [["x", "X"], ["-x", "X al revés"], ["y", "Y"], ["-y", "Y al revés"], ["z", "Z"], ["-z", "Z al revés"]], (v) => (f.axis = v as JointFeature["axis"])));
      // posición con deslizador
      const rf = resolveDoc(doc).features.find((x) => x.id === f.id) as Resolved<JointFeature> | undefined;
      const unit = hinge ? "°" : " mm";
      sec.append(h("h3", { class: "mt" }, hinge ? "Ángulo" : "Recorrido"));
      if (rf && rf.max > rf.min) {
        const sl = h("input", { type: "range", class: "joint-range", min: String(rf.min), max: String(rf.max), step: hinge ? "1" : "0.1", value: String(Math.min(rf.max, Math.max(rf.min, rf.value))) }) as HTMLInputElement;
        const lab = h("span", { class: "joint-val" }, fmtEs(rf.value, 1) + unit);
        sl.addEventListener("input", () => { f.value = fmt(Math.round(Number(sl.value) * 100) / 100); lab.textContent = fmtEs(Number(sl.value), 1) + unit; changed(false); });
        sl.addEventListener("change", () => { changed(true); renderProps(); });
        sec.append(h("div", { class: "joint-row" }, sl, lab));
      }
      sec.append(exprField("Posición", () => f.value, (v) => (f.value = v), k("value"), { unit, hint: "o mueve el deslizador" }));
      sec.append(exprField("Mínimo", () => f.min, (v) => (f.min = v), k("min"), { unit }));
      sec.append(exprField("Máximo", () => f.max, (v) => (f.max = v), k("max"), { unit }));
      const out = h("div", { class: "empty" }, "Mueve la unión de punta a punta y te dice si algo choca por el camino.");
      const btn = h("button", { class: "btn small primary", onclick: () => void sweepJoint(f, out, btn as HTMLButtonElement) }, "▶ Recorrer y buscar choques") as HTMLButtonElement;
      sec.append(btn, out);
      if (hinge) {
        sec.append(h("h3", { class: "mt" }, "Un punto del eje (mm)"));
        sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x")));
        sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
        sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z")));
        const pick = h("select", {}, h("option", { value: "" }, "elige un cuerpo…"), ...before.map((b) => h("option", { value: b.id }, b.name))) as HTMLSelectElement;
        pick.addEventListener("change", () => {
          const c = viewport.bodyCenter(pick.value);
          if (!c) return toast("Ese cuerpo no está a la vista ahora");
          [f.x, f.y, f.z] = c.map((v) => fmt(Math.round(v * 100) / 100));
          changed(true, true);
        });
        sec.append(h("div", { class: "field" }, h("label", {}, "Al centro de"), pick), h("div", { class: "empty" }, "Truco: si la bisagra lleva un pasador, pon el eje en el centro del pasador."));
      }
      break;
    }
    case "combine": {
      const before = build?.bodiesBefore[f.id] ?? [];
      sec.append(selectField("Operación", f.op, [["add", "Sumar (unir)"], ["cut", "Restar"], ["intersect", "Intersecar (lo común)"]], (v) => (f.op = v as CombineFeature["op"])));
      sec.append(selectField("Se queda en", f.target, [["", "Elige un cuerpo…"], ...before.map((b) => [b.id, b.name] as [string, string])], (v) => { f.target = v; f.tools = f.tools.filter((t) => t !== v); }));
      sec.append(h("h3", { class: "mt" }, f.op === "cut" ? "Cuerpos que restar" : "Cuerpos que combinar"));
      if (before.length < 2) sec.append(h("div", { class: "empty" }, "Hacen falta al menos dos cuerpos (usa «Cuerpo nuevo» al crearlos)."));
      for (const b of before) {
        if (b.id === f.target) continue;
        sec.append(checkField(b.name, f.tools.includes(b.id), (v) => { f.tools = v ? [...f.tools, b.id] : f.tools.filter((t) => t !== b.id); }));
      }
      sec.append(checkField("Conservar los cuerpos usados", f.keep, (v) => (f.keep = v)));
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
    case "pushpull": {
      if (!f.face) { sec.append(h("div", { class: "msg info" }, "Haz clic en una cara plana de la pieza.")); break; }
      sec.append(exprField("Distancia", () => f.distance, (v) => (f.distance = v), k("distance"), { unit: "mm", hint: "Positivo: la pieza crece. Negativo: se hunde." }));
      sec.append(h("div", { class: "seg-btns" },
        h("button", { class: "btn small", title: "Cambiar crecer por hundir", onclick: () => {
          f.distance = /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(f.distance) ? fmt(-Number(f.distance)) : `-(${f.distance})`;
          changed(true, true); renderProps();
        } }, "⇅ Al revés")));
      sec.append(h("div", { class: "empty mt" }, "Arrastra la flecha naranja en la vista: va de medio en medio milímetro y ves en transparente cómo quedará. Otro clic en una cara la cambia."));
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
    case "relief": renderReliefProps(sec, f); break;
    case "layflat": renderLayFlatProps(sec, f); break;
    case "plane": renderRefPlaneProps(sec, f); break;
    case "component": renderComponentProps(sec, f); break;
  }
  sec.append(h("div", { class: "actions" },
    h("button", { class: "btn primary", onclick: () => setActive(null) }, "Hecho"),
  ));
}

function renderPatternProps(sec: HTMLElement, f: PatternFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  const idx = doc.features.indexOf(f);
  const sources = doc.features.slice(0, idx).filter((x) => ["extrude", "revolve", "box", "cylinder", "sphere", "gear", "spring", "hole", "rod", "pattern", "text", "sweep", "loft", "import", "relief"].includes(x.type));
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
  if (p) {
    sec.append(checkField("Seguir la curva (cara cilíndrica)", !!f.wrap, (v) => { if (v) f.wrap = true; else delete f.wrap; }));
    if (f.wrap) sec.append(h("div", { class: "empty" }, "Cada letra se coloca tangente al cilindro y da la vuelta con él (el giro no se usa). Vale por fuera y por dentro de un vaso."));
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

function renderReliefProps(sec: HTMLElement, f: ReliefFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  const rf = resolved.features.find((x) => x.id === f.id) as Resolved<ReliefFeature> | undefined;
  const pic = h("img", { class: "relief-pic", alt: "" }) as HTMLImageElement;
  if (f.file) void imageUrl(f.file).then((u) => { if (u) pic.src = u; });
  sec.append(h("div", { class: "relief-file" }, pic, h("div", {},
    h("div", {}, f.fileName || "Sin imagen"),
    h("button", { class: "btn small", onclick: () => { replacingRelief = f.id; $("#filerelief").click(); } }, "Cambiar imagen…"))));
  const logo = f.mode === "logo";
  sec.append(selectField("Qué hacer", f.mode, [["logo", "Logo (lo oscuro sale)"], ["relief", "Relieve o litofanía"]], (v) => {
    f.mode = v as ReliefFeature["mode"];
    // cada modo con un detalle razonable
    if (f.mode === "relief" && Number(f.detail) > 160) f.detail = "100";
    if (f.mode === "logo" && f.detail === "100") f.detail = "200";
    if (f.mode === "relief" && f.height === "1" && f.op !== "cut") f.height = "2.4";
  }));
  sec.append(exprField("Ancho", () => f.width, (v) => (f.width = v), k("width"), { hint: rf ? `alto de la imagen: ${fmtEs(rf.width * f.aspect, 1)} mm` : undefined }));
  if (logo) {
    sec.append(exprField(f.op === "cut" ? "Profundidad" : "Alto", () => f.height, (v) => (f.height = v), k("height")));
    sec.append(exprField("Umbral", () => f.threshold, (v) => (f.threshold = v), k("threshold"), { unit: " %", hint: "a partir de qué gris cuenta como logo; súbelo si sale demasiado" }));
  } else {
    sec.append(exprField(f.op === "cut" ? "Profundidad" : "Relieve", () => f.height, (v) => (f.height = v), k("height"), { hint: "de lo más claro a lo más oscuro" }));
    if (f.op !== "cut") sec.append(exprField("Base", () => f.base, (v) => (f.base = v), k("base"), { hint: "placa por debajo; en una litofanía, lo más fino (0,6–0,8 mm)" }));
  }
  sec.append(exprField("Detalle", () => f.detail, (v) => (f.detail = v), k("detail"), { unit: " puntos", hint: logo ? "en el lado largo; de 10 a 400" : "en el lado largo; de 10 a 160 (más = más lento)" }));
  sec.append(checkField(logo ? "Invertir (lo claro es el logo)" : "Invertir (lo claro, más alto)", f.invert, (v) => (f.invert = v)));
  sec.append(h("h3", { class: "mt" }, "Dónde"));
  sec.append(exprField("X", () => f.x, (v) => (f.x = v), k("x"), { hint: "centro de la imagen" }));
  sec.append(exprField("Y", () => f.y, (v) => (f.y = v), k("y")));
  sec.append(exprField("Z", () => f.z, (v) => (f.z = v), k("z"), { hint: f.op === "cut" ? "la cara donde se graba (se hunde hacia abajo)" : "dónde se apoya" }));
  sec.append(...opFields(f));
  sec.append(h("div", { class: "empty mt" }, logo
    ? "Va mejor con logos de dos colores y buen contraste. Si tienes el logo en SVG, mejor impórtalo en un boceto: sale más limpio."
    : "Para una litofanía: imprímela de pie (gírala 90° con Mover), al 100 % de relleno y en blanco; a contraluz se ve la foto."));
}

let replacingRelief: string | null = null;
$("#filerelief").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return toast("La imagen pasa de 20 MB");
  try {
    const data = await file.arrayBuffer();
    const bmp = await createImageBitmap(new Blob([data]));
    const aspect = bmp.height / bmp.width;
    bmp.close();
    const id = await fileId(data);
    await files.put(id, { name: file.name, format: "image", data });
    const old = replacingRelief ? doc.features.find((x) => x.id === replacingRelief) : undefined;
    replacingRelief = null;
    if (old?.type === "relief") {
      Object.assign(old, { file: id, fileName: file.name, aspect });
      changed(true, true);
      return;
    }
    const f = newFeature(doc, "relief") as ReliefFeature;
    Object.assign(f, { file: id, fileName: file.name, aspect });
    doc.features.push(f);
    setActive(f.id);
    changed(true, true);
    toast("Imagen puesta. Ajusta el ancho en mm.");
  } catch {
    toast("No se pudo leer esa imagen");
  }
});

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

const hasMyFit = () => { try { return localStorage.getItem("geometria:holgura") !== null; } catch { return false; } };

/** Tu holgura: la que salió bien en la prueba de holguras */
function fitDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const inp = h("input", { value: fmt(myFit()), inputmode: "decimal" }) as HTMLInputElement;
  const ok = () => {
    const v = Number(inp.value.replace(",", "."));
    if (!(v > 0 && v < 2)) { inp.classList.add("bad"); return; }
    setMyFit(v);
    dlg.close();
    toast(`Tu holgura: ${fmtEs(v, 2)} mm. Se usará en agujeros, catálogo, partir y plantillas nuevas.`);
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
  dlg.append(h("h2", {}, "Mi holgura"),
    h("p", { class: "empty" }, "Es cuánto más grande (en diámetro) tiene que ser un agujero para que entre una pieza a mano, sin bailar. Depende de tu impresora, la boquilla y el filamento."),
    h("div", { class: "msg info" }, "1. Abre la plantilla «Prueba de holguras» e imprímela. 2. Mete la espiga en cada agujero. 3. Escribe aquí el número del primero en el que entra bien."),
    h("div", { class: "field" }, h("label", {}, "Holgura (mm)"), inp),
    h("div", { class: "t-right" },
      h("button", { class: "btn", onclick: () => { dlg.close(); const t = TEMPLATES.find((x) => x.id === "holguras")!; setDoc(t.make(), uid()); toast("Prueba de holguras abierta: expórtala a 3MF e imprímela"); } }, "Abrir la prueba"), " ",
      h("button", { class: "btn", onclick: () => dlg.close() }, "Cancelar"), " ",
      h("button", { class: "btn primary", onclick: ok }, "Guardar")));
  dlg.showModal();
  inp.select();
}

function templatesDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  dlg.append(h("h2", {}, "Plantillas"));
  dlg.append(h("p", { class: "empty" }, "Cada una se abre como pieza nueva, con variables para cambiar medidas y holguras."));
  const box = h("div", { class: "list" });
  for (const t of TEMPLATES) {
    box.append(h("div", { class: "it" },
      h("span", { onclick: () => {
        dlg.close();
        const d = t.make();
        // tu holgura, salvo en la bisagra (se imprime montada y necesita más hueco)
        const v = d.variables.find((x) => x.name === "holgura");
        if (v && hasMyFit() && t.id !== "bisagra") v.value = String(myFit()) as never;
        setDoc(d, uid());
        toast(`Plantilla «${t.name}» abierta`);
      } }, t.name, h("small", { class: "block" }, t.info)),
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

/** Planos de referencia que hay antes de un paso (o todos) */
function refPlanesBefore(id?: string) {
  const idx = id ? doc.features.findIndex((x) => x.id === id) : doc.features.length;
  return doc.features.slice(0, idx < 0 ? doc.features.length : idx).filter((x): x is RefPlaneFeature => x.type === "plane" && !x.off);
}

/** Selector de plano para un boceto o un plano de referencia */
function planeSelect(f: SketchFeature | RefPlaneFeature) {
  const pl = f.plane;
  const opts: [string, string][] = [["XY", "Suelo (XY)"], ["XZ", "Frente (XZ)"], ["YZ", "Lado (YZ)"]];
  for (const r of refPlanesBefore(f.id)) opts.push([`ref:${r.id}`, `▱ ${r.name}`]);
  if (pl.kind === "face") opts.push(["face", "Cara elegida"]);
  opts.push(["pick", "Elegir una cara de la pieza…"]);
  const cur = pl.kind === "std" ? pl.name : pl.kind === "ref" ? `ref:${pl.ref}` : "face";
  return selectField("Plano", cur, opts, (v) => {
    const keep = { offset: f.plane.offset, tilt: f.plane.tilt, turn: f.plane.turn };
    if (v === "pick") { startFacePick(); return; }
    if (v.startsWith("ref:")) f.plane = { kind: "ref", ref: v.slice(4), ...keep };
    else if (v !== "face") f.plane = { kind: "std", name: v as StdPlane, ...keep };
  });
}

/** Antes de un boceto o un plano: ¿dónde? (suelo, frente, lado, una cara o uno de tus planos) */
function whereDialog(type: "sketch" | "plane") {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const hasBody = !!build?.bodies.length;
  const off = h("input", { value: type === "plane" ? "10" : "0", spellcheck: "false", class: "where-off" }) as HTMLInputElement;
  const create = (plane: PlaneDef | null) => {
    let offset = off.value.trim() || "0";
    try { evaluate(offset, resolved.vars); } catch { off.classList.add("bad"); return; }
    dlg.close();
    const f = newFeature(doc, type) as SketchFeature | RefPlaneFeature;
    if (plane) f.plane = { ...plane, offset } as PlaneDef;
    else f.plane = { kind: "std", name: "XY", offset };
    doc.features.push(f);
    setActive(f.id);
    changed(true, true);
    if (!plane) startFacePick();
  };
  const big = (icon: string, label: string, small: string, fn: () => void, disabled = false) =>
    h("button", { class: "where-btn", disabled, onclick: fn }, h("b", {}, icon), h("span", {}, label), h("small", {}, small));
  const grid = h("div", { class: "where-grid" },
    big("⬓", "Suelo", "Plano XY, mirando desde arriba", () => create({ kind: "std", name: "XY", offset: "0" })),
    big("◧", "Frente", "Plano XZ, de pie, mirando de frente", () => create({ kind: "std", name: "XZ", offset: "0" })),
    big("◨", "Lado", "Plano YZ, de pie, mirando de lado", () => create({ kind: "std", name: "YZ", offset: "0" })),
    big("◩", "Una cara", hasBody ? "Haz clic en una cara plana de la pieza" : "Primero crea un sólido", () => create(null), !hasBody),
    ...refPlanesBefore().map((r) => big("▱", r.name, "Tu plano de referencia", () => create({ kind: "ref", ref: r.id, offset: "0" }))),
  );
  dlg.append(
    h("h2", {}, type === "sketch" ? "¿Dónde dibujas el boceto?" : "¿Dónde pones el plano?"),
    grid,
    h("div", { class: "field" }, h("label", {}, "Separado"), off, h("div", { class: "val" }, type === "sketch" ? "mm por encima del plano o la cara (0 = justo encima)" : "mm desde el plano o la cara; luego puedes inclinarlo")),
    ...(type === "sketch" ? [h("div", { class: "empty" }, "¿Necesitas un plano a otra altura o inclinado que vayas a usar varias veces? Crea un «Plano ref.» y te saldrá aquí.")] : []),
    h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cancelar")),
  );
  dlg.showModal();
}

function renderRefPlaneProps(sec: HTMLElement, f: RefPlaneFeature) {
  const k = (field: string) => `${f.id}:${field}`;
  sec.append(planeSelect(f));
  if (build?.errors[f.id] || resolved.fieldErrors[`${f.id}:plane`]) sec.append(h("div", { class: "msg err" }, resolved.fieldErrors[`${f.id}:plane`] ?? ""));
  sec.append(exprField("Separado", () => f.plane.offset, (v) => (f.plane.offset = v), k("offset"), { hint: "mm en su perpendicular" }));
  sec.append(exprField("Inclinación", () => f.plane.tilt ?? "0", (v) => (f.plane.tilt = v), k("tilt"), { unit: "°", hint: "gira sobre su eje X (rojo)" }));
  sec.append(exprField("Giro", () => f.plane.turn ?? "0", (v) => (f.plane.turn = v), k("turn"), { unit: "°", hint: "gira dentro del plano" }));
  sec.append(exprField("Tamaño en pantalla", () => f.size, (v) => (f.size = v), k("size"), { hint: "solo para verlo; el plano es infinito" }));
  sec.append(h("div", { class: "seg-btns" }, h("button", { class: "btn small primary", onclick: () => {
    const sk = newFeature(doc, "sketch") as SketchFeature;
    sk.plane = { kind: "ref", ref: f.id, offset: "0" };
    doc.features.push(sk);
    setActive(sk.id);
    changed(true, true);
  } }, "✎ Dibujar un boceto aquí")));
  sec.append(h("div", { class: "empty mt" }, "Un plano de referencia no crea volumen: sirve para dibujar bocetos encima. Si lo mueves, sus bocetos se mueven con él."));
}

function renderSketchProps(sec: HTMLElement, f: SketchFeature) {
  sec.append(planeSelect(f));
  sec.append(exprField("Desfase", () => f.plane.offset, (v) => (f.plane.offset = v), `${f.id}:offset`, { hint: "separa el plano en su normal" }));
  sec.append(exprField("Inclinación", () => f.plane.tilt ?? "0", (v) => (f.plane.tilt = v), `${f.id}:tilt`, { unit: "°", hint: "gira el plano sobre su eje X (rojo)" }));
  sec.append(exprField("Giro", () => f.plane.turn ?? "0", (v) => (f.plane.turn = v), `${f.id}:turn`, { unit: "°", hint: "gira el dibujo dentro del plano" }));
  sec.append(h("div", { class: "seg-btns" },
    h("button", { class: "btn small", onclick: startFacePick }, "Dibujar sobre una cara de la pieza…"),
    h("button", { class: "btn small", title: "Traer un dibujo de Inkscape, Illustrator, Figma…", onclick: () => $("#filesvg").click() }, "Importar SVG…"),
  ));

  renderImageFields(sec, f);

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
  if (p.kind === "poly") ps.append(checkField("Curva suave (pasa por todos los puntos)", !!p.smooth, (v) => { if (v) p.smooth = true; else delete p.smooth; }));
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
  // redondear, desfase y quitar tramo, sobre lo elegido
  if (sketcher.tool === "select" && (sketcher.selected || n)) {
    bar.append(h("span", { class: "sep" }));
    const amt = h("input", { class: "sk-amount", value: sketchAmount, inputmode: "decimal", title: "Medida (mm) para redondear o desfasar" }) as HTMLInputElement;
    amt.addEventListener("input", () => (sketchAmount = amt.value));
    const num = () => { try { return evaluate(amt.value.replace(",", "."), resolved.vars); } catch { return NaN; } };
    const run = (fn: () => string | null) => { const err = fn(); if (err) toast(err); renderSketchBar(); };
    bar.append(amt,
      h("button", { class: "btn small", title: n === 2 ? "Redondea la esquina entre los dos tramos" : "Redondea todas las esquinas del contorno", onclick: () => run(() => sketcher.filletSelection(num())) }, n === 2 ? "◜ Redondear esquina" : "◜ Redondear"),
      h("button", { class: "btn small", title: "Copia paralela del contorno (negativo = hacia dentro)", onclick: () => run(() => sketcher.offsetSelected(num())) }, "⧈ Desfase"),
    );
    if (n === 1 || sketcher.selSeg !== null) bar.append(h("button", { class: "btn small", title: "Quita el tramo elegido", onclick: () => run(() => sketcher.removeSelectedSegment()) }, "✂ Quitar tramo"));
  }
  if (sketchRef.inP.length || sketchRef.outP.length) bar.append(h("button", { class: "btn small", title: "Copia al boceto los contornos de la pieza que están en este plano (o, si no hay, los que se ven desde él)", onclick: useBodyEdges }, "⬚ Bordes de la pieza"));
  const snap = h("button", { class: `btn small ${sketcher.snapOn ? "on" : ""}`, title: "Ajustar a la rejilla (Mayús lo suspende)", onclick: () => { sketcher.snapOn = !sketcher.snapOn; renderSketchBar(); } }, "# Rejilla");
  bar.append(snap, h("button", { class: "btn small", onclick: () => sketcher.fitView() }, "Encajar"));
  if (sketcher.tool === "poly" || sketcher.tool === "path") bar.append(h("button", { class: "btn small", title: "Igual que Intro o doble clic", onclick: () => sketcher.finishPoly() }, "↵ Acabar línea"));
  bar.append(h("span", { class: "spacer" }));
  const skf = doc.features.find((x) => x.id === active);
  const used = skf ? doc.features.some((x) => sketchUses(x).includes(skf.id)) : true;
  const closed = skf?.type === "sketch" && skf.profiles.some((p) => !(p.kind === "poly" && p.open));
  if (skf?.type === "sketch" && !used && closed) {
    // el paso siguiente casi siempre es extruir: un clic
    bar.append(h("button", { class: "btn small", title: "Termina el boceto y lo extruye (atajo E)", onclick: () => extrudeSketch(skf.id) }, "⬆ Extruir"));
  }
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
  const had = !!(sketchRef.inP.length || sketchRef.outP.length);
  sketchRef = { inP, outP };
  if (had !== !!(inP.length || outP.length)) renderSketchBar();
}
/** aristas de la pieza vistas desde el boceto abierto: en el plano y proyectadas */
let sketchRef: { inP: number[]; outP: number[] } = { inP: [], outP: [] };

/** Mete en el boceto los bordes de la pieza: los que están en su plano o, si no hay, los proyectados */
function useBodyEdges() {
  const f = doc.features.find((x) => x.id === active);
  if (f?.type !== "sketch") return;
  const onPlane = sketchRef.inP.length > 0;
  const shapes = edgeShapes(onPlane ? sketchRef.inP : sketchRef.outP);
  if (!shapes.length) return toast("No encuentro contornos cerrados de la pieza en este plano");
  for (const s of shapes) {
    const id = uid();
    if (s.kind === "circle") f.profiles.push({ id, kind: "circle", hole: s.hole, cx: fmt(s.cx), cy: fmt(s.cy), r: fmt(s.r) });
    else if (s.kind === "rect") f.profiles.push({ id, kind: "rect", hole: s.hole, x: fmt(s.x), y: fmt(s.y), w: fmt(s.w), h: fmt(s.h), r: "0" });
    else f.profiles.push({ id, kind: "poly", hole: s.hole, pts: s.pts.map(([x, y]) => ({ x: fmt(x), y: fmt(y) })) });
  }
  sketcher.render();
  changed(true, true);
  const n = shapes.length;
  toast(`${n === 1 ? "1 contorno" : `${n} contornos`} de la pieza${onPlane ? "" : " (vistos desde el boceto)"}`, { label: "Deshacer", run: () => undoRedo("undo") });
}

function startFacePick() {
  pickingFace = true;
  $("#sketch").classList.remove("on");
  viewport.pickMode = "face";
  renderBanner();
}

viewport.events.onFacePick = (point, normal) => {
  const f = doc.features.find((x) => x.id === active);
  if (f?.type === "pushpull") {
    const r3 = (v: Vec3) => v.map((c) => Math.round(c * 1000) / 1000) as Vec3;
    f.face = r3(point); f.normal = r3(normal);
    changed(true, true);
    renderProps();
    return;
  }
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
  if (f?.type === "plane") {
    f.plane = { kind: "face", ...planeFromHit(point, normal), offset: "0" };
    pickingFace = false;
    viewport.pickMode = "none";
    renderBanner();
    changed(true, true);
    return;
  }
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
    b.append("Haz clic en una cara plana de la pieza", h("button", { class: "btn small", onclick: () => { pickingFace = false; viewport.pickMode = "none"; if (f?.type === "sketch") $("#sketch").classList.add("on"); renderBanner(); } }, "Cancelar"));
  } else if (measuring) {
    b.hidden = false;
    b.innerHTML = "";
    b.append(measureText(viewport.measureItems));
    b.append(h("button", { class: "btn small", onclick: stopMeasure }, "Terminar"));
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
  } else if (f?.type === "pushpull") {
    b.hidden = false;
    b.textContent = f.face ? `${f.name}: arrastra la flecha (o clic en otra cara)` : `${f.name}: clic en la cara plana que quieres empujar`;
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
  renderSelPanel();
}

// ---------- flechas para mover/girar ----------
let gizmoMode: "translate" | "rotate" = "translate";
/** cuerpo elegido con un clic en la vista (sin ningún paso abierto) */
let selBody: string | null = null;
function renderSelPanel() {
  const p = $("#selpanel");
  const b = selBody ? build?.bodies.find((x) => x.id === selBody) : undefined;
  if (selBody && !b) selBody = null;
  viewport.setSelected(selBody);
  p.hidden = !selBody || !!active || !!explode;
  p.innerHTML = "";
  if (p.hidden || !b) { renderGizmo(); return; }
  const mode = (m: "translate" | "rotate", label: string) => h("button", { class: `btn small ${gizmoMode === m ? "on" : ""}`, onclick: () => { gizmoMode = m; renderSelPanel(); } }, label);
  p.append(
    h("b", {}, b.name), mode("translate", "✥ Mover (G)"), mode("rotate", "⟳ Girar (R)"),
    h("button", { class: "btn small", "data-copy": "1", title: "Hacer una copia al lado y elegirla (Ctrl D)", onclick: () => {
      const bb = viewport.bodyBox(b.id);
      const t = newFeature(doc, "transform") as TransformFeature;
      Object.assign(t, { body: b.id, copy: true, dx: fmt(bb ? Math.round((bb[1][0] - bb[0][0] + 5) * 10) / 10 : 20) });
      doc.features.push(t);
      selBody = t.id;
      changed(true, true);
    } }, "⧉ Copia"),
    h("button", { class: "btn small", title: "Ver los números de este movimiento", onclick: () => {
      const last = doc.features.at(-1);
      if (last?.type === "transform" && last.body === b.id) setActive(last.id); else toast("Aún no has movido este cuerpo");
    } }, "123"),
    h("button", { class: "btn small", title: "Dejar de elegirlo", onclick: () => { selBody = null; renderSelPanel(); } }, "✕"),
  );
  renderGizmo();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selBody && !active && !(document.activeElement instanceof HTMLInputElement)) { selBody = null; renderSelPanel(); }
});
viewport.events.onFaceDouble = (point, normal) => {
  if (active || explode || measuring) return;
  // doble clic en una cara: boceto encima, sin preguntar
  const f = newFeature(doc, "sketch") as SketchFeature;
  f.plane = { kind: "face", ...planeFromHit(point, normal), offset: "0" };
  selBody = null;
  doc.features.push(f);
  setActive(f.id);
  changed(true, true);
  sketcher.refitSoon();
};
// ---------- ocultar / aislar y menú del botón derecho ----------
/** cuerpos ocultos: solo en la vista (se siguen exportando y calculando) */
const hiddenBodies = new Set<string>();
function renderHidden() {
  if (selBody && hiddenBodies.has(selBody)) { selBody = null; renderSelPanel(); }
  viewport.setHidden(hiddenBodies);
  const p = $("#hidechip");
  const n = [...hiddenBodies].filter((id) => build?.bodies.some((b) => b.id === id)).length;
  p.hidden = !n;
  p.innerHTML = "";
  if (n) p.append(h("span", { title: "Solo en la vista: se siguen exportando" }, n === 1 ? "1 pieza oculta" : `${n} piezas ocultas`),
    h("button", { class: "btn small", onclick: showAll }, "👁 Mostrar todo"));
}
/** al «ver solo esta» se acerca la cámara; al volver a mostrar todo, se encaja otra vez */
let isolated = false;
function showAll() { hiddenBodies.clear(); renderHidden(); if (isolated) { isolated = false; viewport.fit(); } }
function hideBody(id: string) {
  hiddenBodies.add(id);
  renderHidden();
  const b = build?.bodies.find((x) => x.id === id);
  toast(`Oculta «${b?.name ?? "pieza"}»`, { label: "Deshacer", run: () => { hiddenBodies.delete(id); renderHidden(); } });
}
/** deja solo esa pieza a la vista; si ya estaba sola, vuelve a mostrar todo */
function isolateBody(id: string) {
  const others = (build?.bodies ?? []).filter((b) => b.id !== id).map((b) => b.id);
  if (others.length && others.every((o) => hiddenBodies.has(o)) && !hiddenBodies.has(id)) { showAll(); return; }
  hiddenBodies.clear();
  others.forEach((o) => hiddenBodies.add(o));
  renderHidden();
  isolated = true;
  viewport.fit();
}
const nn = (...xs: (HTMLElement | null)[]) => xs.filter((x): x is HTMLElement => !!x);
function closeMenu() { document.querySelectorAll(".ctxmenu").forEach((x) => x.remove()); }
function bodyMenu(id: string | null, x: number, y: number, face: { point: Vec3; normal: Vec3 } | null = null) {
  closeMenu();
  if (active || explode || measuring) return;
  const b = id ? build?.bodies.find((q) => q.id === id) : undefined;
  const item = (label: string, key: string, run: () => void, cls = "") =>
    h("button", { class: `ctx-i ${cls}`, onclick: () => { closeMenu(); run(); } }, h("span", {}, label), key ? h("kbd", {}, key) : null);
  const m = h("div", { class: "ctxmenu", role: "menu" });
  if (b) {
    const step = doc.features.find((f) => f.id === b.id);
    const pick = (mode: "translate" | "rotate") => { selBody = b.id; gizmoMode = mode; renderSelPanel(); };
    const cur = doc.colors?.[b.id];
    const colorRow = h("div", { class: "ctx-colors" }, ...PALETTE.map((c) => {
      // el color va por estilo de JavaScript: la CSP del servidor no deja estilos escritos en el HTML
      const sw = h("button", { class: `ctx-sw ${cur === c ? "on" : ""}`, title: "Poner este color", onclick: () => { closeMenu(); (doc.colors ??= {})[b.id] = c; changed(true); } });
      sw.style.background = c;
      return sw;
    }),
      h("button", { class: "ctx-sw none", title: "Color normal", onclick: () => { closeMenu(); if (doc.colors) delete doc.colors[b.id]; changed(true); } }, "×"));
    m.append(...nn(
      h("div", { class: "menu-h" }, b.name),
      item("✥ Mover", "G", () => pick("translate")),
      item("⟳ Girar", "R", () => pick("rotate")),
      item("⧉ Hacer una copia", "Ctrl D", () => { pick("translate"); ($("#selpanel").querySelector("[data-copy]") as HTMLButtonElement | null)?.click(); }),
      face ? item("⇕ Empujar esta cara", "", () => pushFace(face)) : null,
      colorRow,
      h("hr"),
      item("◌ Ocultar", "V", () => hideBody(b.id)),
      item("◎ Ver solo esta", "I", () => isolateBody(b.id)),
      hiddenBodies.size ? item("👁 Mostrar todo", "", showAll) : null,
      h("hr"),
      step ? item("✎ Cambiar sus medidas", "", () => setActive(step.id)) : null,
      step ? item("✕ Borrar", "", () => removeFeature(step.id), "danger") : null,
    ));
  } else {
    m.append(...nn(
      hiddenBodies.size ? item("👁 Mostrar todo", "", showAll) : null,
      item("⤢ Encajar la vista", "0", () => viewport.fit()),
      item("✎ Boceto nuevo", "B", () => useTool("sketch")),
      item("▣ Caja", "C", () => useTool("box")),
    ));
  }
  document.body.append(m);
  // que no se salga de la pantalla
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}
document.addEventListener("pointerdown", (e) => { if (!(e.target as HTMLElement).closest?.(".ctxmenu")) closeMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
addEventListener("resize", closeMenu);
viewport.events.onBodyMenu = (id, x, y, face) => bodyMenu(id, x, y, face);
/** paso «Empujar cara» nuevo sobre esa cara, abierto y con la flecha lista */
function pushFace(face: { point: Vec3; normal: Vec3 }) {
  const r3 = (v: Vec3) => v.map((c) => Math.round(c * 1000) / 1000) as Vec3;
  const f = newFeature(doc, "pushpull") as PushPullFeature;
  f.face = r3(face.point); f.normal = r3(face.normal);
  selBody = null;
  doc.features.push(f);
  setActive(f.id);
  changed(true, true);
}

viewport.events.onBodyClick = (id) => {
  if (active || explode || measuring) return;
  selBody = id;
  renderSelPanel();
};
/** suma un número a una medida: si es un número suelto, lo cambia; si es una cuenta, le añade «+ n» */
function addTo(expr: string, delta: number): string {
  if (Math.abs(delta) < 1e-9) return expr;
  if (/^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(expr)) return fmt(Number(expr) + delta);
  return `${expr} ${delta < 0 ? "-" : "+"} ${fmt(Math.abs(delta))}`;
}
const isZero = (e: string) => { try { return Math.abs(evaluate(e || "0", resolved.vars)) < 1e-9; } catch { return false; } };
/**
 * Suma lo movido con las flechas a un paso «Mover». Un giro solo se suma si el paso no gira ya
 * en otro eje (girar en X y luego en Z no es lo mismo que sumar ángulos); si no, devuelve false.
 */
function addGizmo(f: TransformFeature, d: GizmoDelta): boolean {
  const axes = (["rx", "ry", "rz"] as const).filter((k) => Math.abs(d[k]) > 1e-9);
  const used = (["rx", "ry", "rz"] as const).filter((k) => !isZero(f[k]));
  if (axes.length && used.some((k) => !axes.includes(k))) return false;
  if (axes.length > 1) return false;
  f.dx = addTo(f.dx, d.dx); f.dy = addTo(f.dy, d.dy); f.dz = addTo(f.dz, d.dz);
  for (const k of axes) f[k] = addTo(f[k], d[k]);
  return true;
}
/** Paso «Mover» nuevo para un cuerpo, justo después de «after» (o al final) */
function newMove(body: string, d: GizmoDelta, after?: string): TransformFeature {
  const t = newFeature(doc, "transform") as TransformFeature;
  t.body = body;
  addGizmo(t, d);
  const i = after ? doc.features.findIndex((x) => x.id === after) : -1;
  if (i >= 0) doc.features.splice(i + 1, 0, t); else doc.features.push(t);
  return t;
}

/** flecha de «Empujar cara» cuando ese paso está abierto */
function renderPush() {
  const f = doc.features.find((x) => x.id === active);
  if (f?.type !== "pushpull" || !f.face || !build) { viewport.setPush(null); return; }
  const rf = resolved.features.find((x) => x.id === f.id) as Resolved<PushPullFeature> | undefined;
  const dist = rf?.distance ?? 0;
  viewport.setPush({
    point: f.face, normal: f.normal, dist,
    onDone: (d) => {
      if (Math.abs(d - dist) < 1e-9) return;
      // si era una cuenta (con variables), se le suma lo arrastrado en vez de borrarla
      f.distance = addTo(f.distance, d - dist);
      if (isZero(f.distance)) f.distance = "0.5";
      changed(true, true);
      renderProps();
    },
  });
}

function renderGizmo() {
  renderPush();
  const f = doc.features.find((x) => x.id === active);
  if (!f && selBody && build && !explode) {
    // cuerpo elegido con un clic: se mueve o gira directamente
    const center = viewport.bodyCenter(selBody);
    if (!center) { viewport.setGizmo(null); return; }
    viewport.setGizmo({
      body: selBody, center, mode: gizmoMode,
      onDone: (d) => {
        const last = doc.features.at(-1);
        // si lo último que hiciste fue mover este mismo cuerpo, se suma a ese paso (menos pasos en la lista)
        if (!(last?.type === "transform" && !last.copy && !last.off && last.body === selBody && addGizmo(last, d))) newMove(selBody!, d);
        changed(true, true);
      },
    });
    return;
  }
  if (f?.type !== "transform" || !build) { viewport.setGizmo(null); return; }
  const before = build.bodiesBefore[f.id] ?? [];
  const body = f.copy ? f.id : f.body || before[before.length - 1]?.id || "";
  const center = body ? viewport.bodyCenter(body) : null;
  if (!center) { viewport.setGizmo(null); return; }
  viewport.setGizmo({
    body, center, mode: gizmoMode,
    onDone: (d) => {
      if (!addGizmo(f, d)) {
        // girar en otro eje: va en un paso nuevo, justo detrás
        const t = newMove(body, d, f.id);
        toast("Giro en otro eje: va en un paso «Mover» nuevo");
        setActive(t.id);
      }
      changed(true, true);
      renderProps();
    },
  });
}

/** Dibuja en 3D los bocetos que aún no se han usado (y el activo) */
// ---------- imágenes de referencia ----------
const imageUrls = new Map<string, Promise<string | null>>();
function imageUrl(id: string): Promise<string | null> {
  let u = imageUrls.get(id);
  if (!u) {
    u = files.get(id).then((st) => (st ? URL.createObjectURL(new Blob([st.data])) : null));
    imageUrls.set(id, u);
  }
  return u;
}

let imagesSeq = 0;
/** Pone las imágenes en el editor de boceto y en la vista 3D */
async function syncImages() {
  const my = ++imagesSeq;
  const f = doc.features.find((x) => x.id === active);
  const list: Parameters<typeof viewport.setRefImages>[0] = [];
  let sk: Parameters<typeof sketcher.setImage>[0] = null;
  for (const rf of resolved.features) {
    if (rf.type !== "sketch" || rf.off || !rf.image) continue;
    const im = rf.image;
    const url = await imageUrl(im.file);
    if (my !== imagesSeq) return;
    if (!url) continue;
    const geo = { url, x: im.x, y: im.y, w: im.w, h: im.w * im.aspect, opacity: im.opacity };
    if (f?.id === rf.id) sk = geo;
    if (im.show3d !== false && f?.id !== rf.id) list.push({ ...geo, basis: planeBasis(rf.plane as never), opacity: Math.min(im.opacity, 0.6) });
  }
  sketcher.setImage(sk);
  viewport.setRefImages(list);
}

function renderImageFields(sec: HTMLElement, f: SketchFeature) {
  const box = h("div", { class: "subsection" });
  sec.append(box);
  box.append(h("h3", {}, "Imagen de referencia", f.image ? h("button", { class: "btn small", onclick: () => { delete f.image; changed(true, true); } }, "Quitar") : null));
  if (!f.image) {
    box.append(h("button", { class: "btn small", onclick: () => { imageTarget = f.id; $("#fileimg").click(); } }, "🖼 Poner una imagen de fondo…"));
    box.append(h("div", { class: "empty" }, "Una foto o un plano para calcar encima. Pon su ancho real en mm para que la escala cuadre."));
    return;
  }
  const im = f.image;
  const num = (label: string, get: () => number, set: (v: number) => void, hint?: string) => {
    const i = h("input", { value: fmt(get()), inputmode: "decimal" }) as HTMLInputElement;
    i.addEventListener("change", () => {
      const v = Number(i.value.replace(",", "."));
      if (!Number.isFinite(v)) { i.classList.add("bad"); return; }
      i.classList.remove("bad");
      set(v); changed(true);
    });
    return h("div", { class: "field" }, h("label", {}, label), i, hint ? h("div", { class: "val" }, hint) : null);
  };
  box.append(
    num("Ancho real", () => im.w, (v) => { if (v > 0) im.w = v; }, "mm que mide la imagen de lado a lado"),
    num("Esquina X", () => im.x, (v) => (im.x = v)),
    num("Esquina Y", () => im.y, (v) => (im.y = v)),
    h("div", { class: "seg-btns" }, h("button", { class: "btn small", onclick: () => { im.x = -im.w / 2; im.y = -(im.w * im.aspect) / 2; changed(true, true); } }, "Centrar en el origen")),
  );
  const op = h("input", { type: "range", min: "0.1", max: "1", step: "0.05", value: String(im.opacity) }) as HTMLInputElement;
  op.addEventListener("input", () => { im.opacity = Number(op.value); void syncImages(); });
  op.addEventListener("change", () => changed(true));
  box.append(h("div", { class: "field" }, h("label", {}, "Opacidad"), op));
  box.append(checkField("Verla también en la vista 3D", im.show3d !== false, (v) => (im.show3d = v)));
}
let imageTarget = "";
$("#fileimg").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const f = doc.features.find((x) => x.id === imageTarget);
  if (!file || f?.type !== "sketch") return;
  try {
    const data = await file.arrayBuffer();
    const bmp = await createImageBitmap(new Blob([data]));
    const aspect = bmp.height / bmp.width;
    bmp.close();
    const id = await fileId(data);
    await files.put(id, { name: file.name, format: "image", data });
    const w = 100;
    f.image = { file: id, x: -w / 2, y: (-w * aspect) / 2, w, aspect, opacity: 0.5, show3d: true };
    changed(true, true);
    toast("Imagen puesta. Ajusta su ancho real en mm.");
  } catch {
    toast("No se pudo leer esa imagen");
  }
});

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
  // planos de referencia: un cuadrado con una cruz en el centro
  for (const f of resolved.features) {
    if (f.type !== "plane" || f.off) continue;
    const b = planeBasis(f.plane as never);
    const r = Math.max(5, f.size || 80) / 2, c = r / 8;
    const sq = [[-r, -r], [r, -r], [r, r], [-r, r], [-r, -r]].map(([u, v]) => toWorld(b, u, v));
    out.push({ pts: [sq, [toWorld(b, -c, 0), toWorld(b, c, 0)], [toWorld(b, 0, -c), toWorld(b, 0, c)]], active: f.id === active });
  }
  viewport.setSketchLines(out);
  renderMarks();
  void syncImages();
}

// ======================================================================
// Archivo y exportar
// ======================================================================

function toast(text: string, action?: { label: string; run: () => void }) {
  document.querySelectorAll(".toast").forEach((x) => x.remove()); // uno cada vez
  const t = h("div", { class: "toast" }, text);
  if (action) t.append(h("button", { class: "toast-btn", onclick: () => { t.remove(); action.run(); } }, action.label));
  document.body.append(t);
  setTimeout(() => t.remove(), action ? 6000 : 2600);
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

/** Hoja A4 apaisada (en mm) con las vistas, las medidas generales, tus cotas y el cajetín */
function drawingSheet(views: DrawingView[], snaps: Partial<Record<DrawingView["name"], Snaps>> = {}): { svg: string; xf: Partial<Record<DrawingView["name"], ViewXf & { cell: [number, number, number, number] }>>; dimAt: { id: string; at: [number, number] }[] } {
  const xf: Partial<Record<DrawingView["name"], ViewXf & { cell: [number, number, number, number] }>> = {};
  const dimAt: { id: string; at: [number, number] }[] = [];
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
    xf[name] = { ox, oy, k, cell: [cx, cy, cx + cellW, cy + cellH] };
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
    // tus cotas: en naranja las que se han quedado sueltas porque la pieza cambió
    for (const dd of doc.dims ?? []) {
      if (dd.view !== name) continue;
      const loose = snaps[name] ? !dimAttached(dd, snaps[name]!) : false;
      const pre = dd.kind === "d" ? "Ø" : dd.kind === "r" ? "R" : "";
      const r = dimSvg(dd, { ox, oy, k }, pre + n(dimValue(dd)), loose ? "#d9480f" : "#000");
      out.push(r.svg);
      dimAt.push({ id: dd.id, at: r.at });
    }
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
  out.push(`<g id="dim-ui"></g>`);
  out.push("</svg>");
  return { svg: out.join(""), xf, dimAt };
}

type DimTool = "none" | "h" | "v" | "a" | "d" | "r" | "del";
const DIM_TOOLS: [DimTool, string, string][] = [
  ["h", "↔ Horizontal", "Toca dos puntos y luego dónde va la línea de cota"],
  ["v", "↕ Vertical", "Toca dos puntos y luego dónde va la línea de cota"],
  ["a", "⤢ Alineada", "Toca dos puntos (mide en línea recta) y luego dónde va la cota"],
  ["d", "Ø Diámetro", "Toca el borde de un círculo, por el lado donde quieres el texto"],
  ["r", "R Radio", "Toca el borde de un arco o círculo, por el lado donde quieres el texto"],
  ["del", "✕ Quitar cota", "Toca el número de la cota que quieres quitar"],
];

function drawingDialog() {
  if (!engineReady) return toast("El motor aún está cargando");
  if (!build?.bodies.length) return toast("Todavía no hay ninguna pieza que dibujar");
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const preview = h("div", { class: "sheet" }, h("div", { class: "empty" }, "Dibujando las vistas…"));
  const actions = h("div", { class: "actions" });
  const dimbar = h("div", { class: "dimbar" });
  const hint = h("div", { class: "empty dimhint" });
  dlg.append(h("h2", {}, "Plano con medidas"), dimbar, hint, preview, actions);
  if (!dlg.open) dlg.showModal();
  const s = ++seq;
  drawingWaiters.set(s, (m) => {
    rebuild();
    if (!m.views?.length) { preview.innerHTML = ""; preview.append(h("div", { class: "msg err" }, "No se pudo dibujar: " + (m.error ?? "sin vistas"))); return; }
    const views = m.views;
    const snaps: Partial<Record<DrawingView["name"], Snaps>> = {};
    for (const v of views) if (v.name !== "iso") snaps[v.name] = snapsFromPaths([...v.visible, ...v.hidden]);
    let sheet = drawingSheet(views, snaps);
    let tool: DimTool = "none";
    /** puntos ya tocados de la cota que estás poniendo */
    let picks: { view: DrawingDim["view"]; pts: [number, number][] } | null = null;
    const draw = () => {
      sheet = drawingSheet(views, snaps);
      preview.innerHTML = sheet.svg;
      const loose = (doc.dims ?? []).filter((d) => snaps[d.view] && !dimAttached(d, snaps[d.view]!)).length;
      hint.textContent = tool === "none"
        ? (loose ? `${loose} cota${loose > 1 ? "s" : ""} en naranja: la pieza cambió y ya no coinciden. Quítalas o vuelve a ponerlas.` : "Elige un tipo de cota para añadir las tuyas. Se guardan con la pieza.")
        : DIM_TOOLS.find((t) => t[0] === tool)![2] + ". Esc para cancelar.";
    };
    const setTool = (t: DimTool) => {
      tool = tool === t ? "none" : t;
      picks = null;
      dimbar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.t === tool));
      preview.classList.toggle("picking", tool !== "none");
      draw();
    };
    for (const [t, label] of DIM_TOOLS) dimbar.append(h("button", { class: "btn small", "data-t": t, onclick: () => setTool(t) }, label));
    // del punto de la pantalla a mm de la hoja y de la vista
    const where = (e: PointerEvent) => {
      const svg = preview.querySelector("svg") as SVGSVGElement | null;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return null;
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      const sheetP: [number, number] = [pt.x, pt.y];
      const mmPerPx = 1 / ctm.a;
      for (const name of ["front", "top", "right"] as const) {
        const x = sheet.xf[name];
        if (!x) continue;
        const [x0, y0, x1, y1] = x.cell;
        if (picks && picks.view !== name) continue; // la segunda punta, en la misma vista
        if (!picks && (pt.x < x0 || pt.x > x1 || pt.y < y0 || pt.y > y1)) continue;
        return { view: name, x, sheetP, p: [(pt.x - x.ox) / x.k, (pt.y - x.oy) / x.k] as [number, number], tol: (e.pointerType === "touch" ? 9 : 5) * mmPerPx / x.k };
      }
      return { view: null, x: null, sheetP, p: null, tol: 0 };
    };
    /** la cota que saldría si tocaras ahora */
    const candidate = (w: NonNullable<ReturnType<typeof where>>): { dim?: DrawingDim; mark?: [number, number] } => {
      if (!w.view || !w.p || !w.x) return {};
      const sn = snaps[w.view];
      if (!sn) return {};
      if (tool === "d" || tool === "r") {
        const c = nearestCircle(sn, w.p, w.tol);
        if (!c || (tool === "d" && !c.full)) return {};
        return { dim: { id: "", view: w.view, kind: tool, a: w.p, b: w.p, off: 0, c: c.c, r: c.r } };
      }
      if (!picks || picks.pts.length < 2) return { mark: nearestPoint(sn, w.p, w.tol) ?? undefined };
      const [a, b] = picks.pts;
      let off: number;
      if (tool === "h") off = w.p[1];
      else if (tool === "v") off = w.p[0];
      else { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; off = ((w.p[0] - a[0]) * -(b[1] - a[1]) + (w.p[1] - a[1]) * (b[0] - a[0])) / l; }
      return { dim: { id: "", view: w.view, kind: tool as "h" | "v" | "a", a, b, off } };
    };
    const ui = () => preview.querySelector("#dim-ui");
    preview.addEventListener("pointermove", (e) => {
      const g = ui();
      if (!g || tool === "none" || tool === "del") return;
      const w = where(e);
      const parts: string[] = [];
      if (w?.x && picks) for (const p of picks.pts) parts.push(`<circle cx="${w.x.ox + p[0] * w.x.k}" cy="${w.x.oy + p[1] * w.x.k}" r="1" fill="#1c7ed6"/>`);
      if (w?.x) {
        const c = candidate(w);
        if (c.mark) parts.push(`<circle cx="${w.x.ox + c.mark[0] * w.x.k}" cy="${w.x.oy + c.mark[1] * w.x.k}" r="1.3" fill="none" stroke="#1c7ed6" stroke-width="0.4"/>`);
        if (c.dim) {
          const pre = c.dim.kind === "d" ? "Ø" : c.dim.kind === "r" ? "R" : "";
          parts.push(dimSvg(c.dim, w.x, pre + fmtEs(dimValue(c.dim), 2).replace(/,00$/, ""), "#1c7ed6").svg);
        }
      }
      g.innerHTML = parts.join("");
    });
    preview.addEventListener("click", (e) => {
      if (tool === "none") return;
      const w = where(e as PointerEvent);
      if (!w) return;
      if (tool === "del") {
        let best = "", bd = 6 / ((preview.querySelector("svg") as SVGSVGElement).getScreenCTM()?.a || 1) + 3;
        for (const d of sheet.dimAt) { const dd = Math.hypot(d.at[0] - w.sheetP[0], d.at[1] - w.sheetP[1]); if (dd < bd) { bd = dd; best = d.id; } }
        if (!best) return toast("Toca justo el número de la cota");
        doc.dims = (doc.dims ?? []).filter((d) => d.id !== best);
        changed(true);
        return draw();
      }
      const c = candidate(w);
      if (c.dim) {
        (doc.dims ??= []).push({ ...c.dim, id: uid() });
        picks = null;
        changed(true);
        return draw();
      }
      if (tool === "d" || tool === "r") return toast(tool === "d" ? "Toca el borde de un círculo entero" : "Toca el borde de un arco");
      if (!c.mark || !w.view) return toast("Toca cerca de una esquina, el medio de una línea o un centro");
      if (!picks) picks = { view: w.view, pts: [c.mark] };
      else if (Math.hypot(picks.pts[0][0] - c.mark[0], picks.pts[0][1] - c.mark[1]) < 1e-6) return;
      else picks.pts.push(c.mark);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || tool === "none") return;
      e.preventDefault(); // que no cierre la ventana
      if (picks) { picks = null; const g = ui(); if (g) g.innerHTML = ""; } else setTool(tool);
    };
    dlg.addEventListener("keydown", onKey);
    dlg.addEventListener("close", () => dlg.removeEventListener("keydown", onKey), { once: true });
    draw();
    actions.append(
      h("button", { class: "btn primary", onclick: () => {
        $("#printarea").innerHTML = drawingSheet(views, snaps).svg;
        dlg.close();
        // el navegador ofrece «Guardar como PDF» en el diálogo de imprimir
        setTimeout(() => window.print(), 50);
      } }, "Imprimir o guardar PDF"),
      h("button", { class: "btn", onclick: () => download(drawingSheet(views, snaps).svg, `${safeName()}-plano.svg`, "image/svg+xml") }, "Descargar SVG"),
      h("button", { class: "btn", onclick: () => {
        if (!doc.dims?.length) return toast("Aún no has puesto ninguna cota");
        const old = doc.dims; doc.dims = []; changed(true); draw();
        toast("Cotas quitadas", { label: "Deshacer", run: () => { doc.dims = old; changed(true); draw(); } });
      } }, "Quitar mis cotas"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar"),
    );
  });
  worker.postMessage({ kind: "drawing", seq: s, features: resolveDoc(doc).features });
}
$("#drawing").addEventListener("click", drawingDialog);
window.addEventListener("afterprint", () => { $("#printarea").innerHTML = ""; });

/** Galería de piezas guardadas en este navegador, con miniatura */
function openDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  // la abierta, con su miniatura al día
  // (solo en el navegador: la pieza de ejemplo de un equipo nuevo no tiene por qué ir al servidor)
  if (!storage.list().some((m) => m.id === docId)) storage.save(docId, doc);
  if (lastBuildFull) { const u = viewport.thumbnail(); if (u) storage.setThumb(docId, u); }
  const list = storage.list();
  const search = h("input", { class: "gal-search", type: "search", placeholder: "Buscar por nombre…" }) as HTMLInputElement;
  const grid = h("div", { class: "gallery" });
  const fill = () => {
    grid.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    const shown = list.filter((m) => !q || m.name.toLowerCase().includes(q));
    if (!shown.length) grid.append(h("div", { class: "empty" }, list.length ? "Ninguna se llama así." : "Todavía no hay ninguna."));
    for (const m of shown) {
      const url = storage.thumb(m.id);
      const open = () => { const d = storage.load(m.id); if (d) setDoc(d, m.id); dlg.close(); };
      const pic = url ? h("img", { src: url, alt: "" }) : h("div", { class: "nopic" }, "Sin miniatura");
      const nv = storage.versions(m.id).length;
      grid.append(h("div", { class: "card" + (m.id === docId ? " current" : "") },
        h("button", { class: "pic", title: "Abrir", onclick: open }, pic),
        h("div", { class: "card-name" }, m.name),
        h("small", {}, new Date(m.updated).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }), nv ? ` · ${nv} versión${nv > 1 ? "es" : ""}` : ""),
        h("div", { class: "card-acts" },
          m.id === docId ? h("small", {}, "Abierta") : h("button", { class: "btn small primary", onclick: open }, "Abrir"),
          h("button", { class: "btn small", onclick: () => {
            const d = storage.load(m.id); if (!d) return;
            d.name += " (copia)";
            const nid = uid();
            saveDoc(nid, d);
            if (url) storage.setThumb(nid, url);
            if (m.id !== docId) saveDoc(docId, doc); // que la abierta siga siendo la última
            openDialog();
            toast("Copia creada");
          } }, "Duplicar"),
          m.id === docId ? null : twoClick("Borrar", "¿Seguro? Borrar", () => { storage.remove(m.id); cloud.remove(m.id); openDialog(); }),
        ),
      ));
    }
  };
  search.addEventListener("input", fill);
  fill();
  const only = cloud.localOnly().length;
  const where = cloud.status === "none"
    ? h("p", { class: "empty" }, "Guardadas en este navegador. Para pasarlas a otro equipo: Archivo → Descargar proyecto.")
    : h("p", { class: "empty" }, cloud.status === "offline"
      ? "Sin conexión con el servidor: lo que cambies se guarda aquí y se sube al volver."
      : "Guardadas en el servidor: las ves igual en todos tus equipos y entran en la copia de cada noche.");
  const up = only && cloud.status !== "none"
    ? h("div", { class: "msg info cloud-up" }, `${only === 1 ? "Hay 1 pieza" : `Hay ${only} piezas`} solo en este navegador.`,
        h("button", { class: "btn small primary", onclick: async () => {
          const n = await cloud.uploadLocal();
          toast(cloud.status === "on" ? `${n === 1 ? "1 pieza subida" : `${n} piezas subidas`} al servidor` : "Sin conexión: se subirán al volver");
          openDialog();
        } }, "Subirlas al servidor"))
    : null;
  dlg.append(...[h("h2", {}, "Mis piezas"), where, up, search, grid].filter((x): x is HTMLElement => !!x),
    h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
  if (!dlg.open) dlg.showModal();
}

/** Guarda a mano una versión con nombre */
function saveVersionDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const inp = h("input", { value: `Versión ${new Date().toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}` }) as HTMLInputElement;
  const ok = () => {
    const name = inp.value.trim() || "Versión";
    if (storage.addVersion(docId, { t: Date.now(), name, auto: false, doc: JSON.stringify(doc) })) toast(`Versión «${name}» guardada`);
    else toast("No cabe en el navegador: borra versiones viejas o descarga el proyecto");
    dlg.close();
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
  dlg.append(h("h2", {}, "Guardar versión"),
    h("p", { class: "empty" }, "Ponle un nombre que te diga algo, como «antes de agujerear» o «la que imprimí». Además se guarda una sola cada 10 minutos de trabajo."),
    h("div", { class: "field" }, h("label", {}, "Nombre"), inp),
    h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cancelar"), " ", h("button", { class: "btn primary", onclick: ok }, "Guardar")));
  dlg.showModal();
  inp.select();
}

/** Lista de versiones de la pieza abierta, para volver a una o abrirla como copia */
function historyDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const list = storage.versions(docId);
  dlg.append(h("h2", {}, "Historial de versiones"),
    h("p", { class: "empty" }, "Al volver a una versión, la de ahora se guarda antes, así que no pierdes nada. También puedes deshacer (Ctrl+Z)."));
  const box = h("div", { class: "list" });
  if (!list.length) box.append(h("div", { class: "empty" }, "Aún no hay versiones. Usa Archivo → Guardar versión, o sigue trabajando: cada 10 minutos se guarda una sola."));
  const cur = JSON.stringify(doc);
  for (const v of list) {
    let steps = 0, name = "";
    try { const d = JSON.parse(v.doc) as Doc; steps = d.features.length; name = d.name; } catch { /* rota */ }
    const same = v.doc === cur;
    box.append(h("div", { class: "it" },
      h("span", {}, v.auto ? h("i", { class: "vtag" }, "auto") : null, " ", v.name,
        h("small", { class: "block" }, `${new Date(v.t).toLocaleString("es-ES")} · ${steps} paso${steps === 1 ? "" : "s"}${name && name !== doc.name ? ` · «${name}»` : ""}${same ? " · igual que ahora" : ""}`)),
      same ? null : h("button", { class: "btn small primary", onclick: () => {
        storage.addVersion(docId, { t: Date.now(), name: `Antes de volver a «${v.name}»`, auto: true, doc: cur });
        const d = JSON.parse(v.doc) as Doc;
        doc = d;
        resolved = resolveDoc(doc);
        active = null;
        sketcher.close();
        history.push(JSON.stringify(doc));
        saveDoc(docId, doc);
        renderAll();
        rebuild();
        dlg.close();
        toast(`Has vuelto a «${v.name}»`);
      } }, "Volver a esta"),
      h("button", { class: "btn small", onclick: () => {
        const d = JSON.parse(v.doc) as Doc;
        d.name = `${d.name} (${v.name})`;
        dlg.close();
        setDoc(d, uid());
        toast("Abierta como pieza aparte");
      } }, "Abrir aparte"),
      h("button", { class: "btn small", title: "Borrar esta versión", onclick: () => { storage.removeVersion(docId, v.t); historyDialog(); } }, "✕"),
    ));
  }
  dlg.append(box, h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
  if (!dlg.open) dlg.showModal();
}

/** Descarga el proyecto; los archivos importados van dentro para poder abrirlo en otro equipo */
async function saveProjectFile() {
  const out: Doc = JSON.parse(JSON.stringify(doc));
  for (const fid of docFileIds(doc)) {
    if (out.files?.[fid]) continue;
    const st = await files.get(fid);
    if (st) (out.files ??= {})[fid] = { name: st.name, format: st.format, data: toBase64(st.data) };
  }
  download(JSON.stringify(out, null, 2), `${safeName()}.geometria.json`, "application/json");
}

function fileAction(a: string) {
  if (a === "new") setDoc(emptyDoc(), uid());
  else if (a === "example") setDoc(exampleDoc(), uid());
  else if (a === "dup") { const d: Doc = JSON.parse(JSON.stringify(doc)); d.name += " (copia)"; setDoc(d, uid()); toast("Copia creada"); }
  else if (a === "open") openDialog();
  else if (a === "version") saveVersionDialog();
  else if (a === "history") historyDialog();
  else if (a === "templates") templatesDialog();
  else if (a === "fit") fitDialog();
  else if (a === "family") familyDialog();
  else if (a === "keys") keysDialog();
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
      if (f && (f.format === "step" || f.format === "stl" || f.format === "image") && typeof f.data === "string") await files.put(id, { name: String(f.name), format: f.format, data: fromBase64(f.data) });
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
$("#m-export").querySelectorAll<HTMLElement>("[data-dxf]").forEach((b) => b.addEventListener("click", () => (b.dataset.dxf === "sketch" ? exportSketchDxf() : exportViewsDxf())));

/** El boceto abierto (o el último que hiciste) en DXF, en sus coordenadas del plano */
function exportSketchDxf() {
  const f = doc.features.find((x) => x.id === active && x.type === "sketch") ?? [...doc.features].reverse().find((x) => x.type === "sketch");
  if (!f) return toast("Todavía no hay ningún boceto");
  const rf = resolveDoc(doc).features.find((x) => x.id === f.id) as Resolved<SketchFeature> | undefined;
  if (!rf?.profiles.length) return toast(`«${f.name}» está vacío`);
  const dxf = new Dxf().layer("CONTORNO", 7).layer("AGUJEROS", 1);
  for (const p of rf.profiles) {
    const layer = p.hole ? "AGUJEROS" : "CONTORNO";
    if (p.kind === "circle") dxf.circle([p.cx, p.cy], p.r, layer);
    else if (p.kind === "rect" && p.r > 0) {
      // rectángulo con esquinas redondeadas: 4 rectas y 4 arcos de verdad
      const { x, y, w, h: hh } = p, r = Math.min(p.r, Math.abs(w) / 2, Math.abs(hh) / 2);
      dxf.line([x + r, y], [x + w - r, y], layer); dxf.line([x + w, y + r], [x + w, y + hh - r], layer);
      dxf.line([x + w - r, y + hh], [x + r, y + hh], layer); dxf.line([x, y + hh - r], [x, y + r], layer);
      dxf.arc([x + w - r, y + r], r, 270, 360, layer); dxf.arc([x + w - r, y + hh - r], r, 0, 90, layer);
      dxf.arc([x + r, y + hh - r], r, 90, 180, layer); dxf.arc([x + r, y + r], r, 180, 270, layer);
    } else dxf.polyline(profileLoop(p as never), layer);
  }
  download(dxf.toString(), `${safeName()}-${f.name.replace(/[^\wáéíóúñÁÉÍÓÚÑ-]+/g, "-")}.dxf`, "image/vnd.dxf");
  toast(f.id === active ? "Boceto en DXF" : `Ningún boceto abierto: va «${f.name}», el último`);
}

/** Las vistas del plano en DXF: frente abajo a la izquierda, arriba encima, derecha al lado y 3D en la esquina */
function exportViewsDxf() {
  if (!engineReady) return toast("El motor aún está cargando");
  if (!build?.bodies.length) return toast("Todavía no hay ninguna pieza");
  const s = ++seq;
  toast("Dibujando las vistas…");
  drawingWaiters.set(s, (m) => {
    rebuild();
    const by = new Map((m.views ?? []).map((v) => [v.name, v]));
    const fr = by.get("front");
    if (!fr) return toast("No se pudo dibujar: " + (m.error ?? "sin vistas"));
    const gap = 20;
    const W = fr.box[2] - fr.box[0], H = fr.box[3] - fr.box[1];
    const dxf = new Dxf().layer("VISIBLE", 7).layer("OCULTAS", 8);
    const put = (v: DrawingView | undefined, ox: number, oy: number) => {
      if (!v) return;
      addSvgPaths(dxf, v.visible, "VISIBLE", [ox, oy]);
      addSvgPaths(dxf, v.hidden, "OCULTAS", [ox, oy]);
    };
    const top = by.get("top"), right = by.get("right"), iso = by.get("iso");
    put(fr, -fr.box[0], fr.box[3]);
    put(top, -fr.box[0], H + gap + (top?.box[3] ?? 0));
    put(right, W + gap - (right?.box[0] ?? 0), fr.box[3]);
    put(iso, W + gap - (iso?.box[0] ?? 0), H + gap + (iso?.box[3] ?? 0));
    download(dxf.toString(), `${safeName()}-vistas.dxf`, "image/vnd.dxf");
  });
  worker.postMessage({ kind: "drawing", seq: s, features: resolveDoc(doc).features });
}
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
/** Lo que dice la barra de medir según lo que hayas tocado */
function measureText(items: MeasureItem[]): string {
  const es = (v: number, d: number) => v.toLocaleString("es-ES", { maximumFractionDigits: d });
  const deg = (v: number) => `${es(v, 1)}°`;
  const mm = (v: number) => `${es(v, 2)} mm`;
  const [a, c] = items;
  if (!a) return "Medir: clic en dos puntos, en dos caras (ángulo) o en un círculo o agujero (diámetro)";
  if (a.kind === "circle") {
    const { r, sweep } = a.circle;
    return sweep > 359 ? `Círculo Ø ${mm(2 * r)}  ·  radio ${mm(r)}` : `Arco de radio ${mm(r)}  ·  ${deg(sweep)}  ·  Ø ${mm(2 * r)}`;
  }
  if (a.kind === "face" && a.face.kind === "cylinder") {
    if (!a.face.full) return `Cara curva de radio ${mm(a.face.r)}  ·  Ø ${mm(2 * a.face.r)}`;
    return `${a.face.hole ? "Agujero" : "Cilindro"} Ø ${mm(2 * a.face.r)}  ·  radio ${mm(a.face.r)}`;
  }
  if (!c) return a.kind === "face" && a.face.kind === "plane" ? "Cara plana: clic en otra cara para el ángulo, o en un punto para la distancia" : "Ahora el segundo punto";
  if (a.kind === "face" && c.kind === "face" && a.face.kind === "plane" && c.face.kind === "plane") {
    const r = planesAngle(a.face.normal, a.p, c.face.normal, c.p);
    return r.gap !== null ? `Caras paralelas, separadas ${mm(r.gap)}` : `Ángulo entre caras ${deg(r.angle)}` + (Math.abs(r.angle - 90) > 0.05 ? `  ·  (${deg(180 - r.angle)} por el otro lado)` : "");
  }
  const dx = c.p[0] - a.p[0], dy = c.p[1] - a.p[1], dz = c.p[2] - a.p[2];
  return `Distancia ${fmt(Math.hypot(dx, dy, dz))} mm  ·  X ${fmt(Math.abs(dx))}  Y ${fmt(Math.abs(dy))}  Z ${fmt(Math.abs(dz))}`;
}
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
  if (e.key === "Escape" && active) { setActive(null); return; }
  if ((document.querySelector("dialog[open]"))) return;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveVersionDialog(); return; }
  if (mod && e.key.toLowerCase() === "d" && selBody) { e.preventDefault(); ($("#selpanel").querySelector("[data-copy]") as HTMLButtonElement | null)?.click(); return; }
  if (mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if ((e.key === "Delete" || e.key === "Backspace") && f) { e.preventDefault(); removeFeature(f.id); return; }
  if (k === "?" || (e.shiftKey && k === "¿")) { keysDialog(); return; }
  if (k === "n") { fileAction("new"); return; }
  if (k === "o") { openDialog(); return; }
  if (selBody && !f && k === "v") { hideBody(selBody); return; }
  if (selBody && !f && k === "i") { isolateBody(selBody); return; }
  if (!f && k === "v" && hiddenBodies.size) { showAll(); return; }
  if (selBody && !f && (k === "g" || k === "r")) { gizmoMode = k === "g" ? "translate" : "rotate"; renderSelPanel(); return; }
  if (k === "0" || k === "inicio") { viewport.fit(); return; }
  const tool = (Object.entries(TOOL_KEY) as [Feature["type"], string][]).find(([, key]) => key.toLowerCase() === k)?.[0];
  if (!tool) return;
  if (tool === "transform" && selBody) { gizmoMode = "translate"; renderSelPanel(); return; }
  const why = toolDisabled(tool);
  if (why) { toast(why); return; }
  // E con un boceto recién hecho y sin usar: lo extruye
  if (tool === "extrude") {
    const sk = [...doc.features].reverse().find((x) => x.type === "sketch");
    if (sk && !doc.features.some((x) => sketchUses(x).includes(sk.id))) { extrudeSketch(sk.id); return; }
  }
  e.preventDefault();
  useTool(tool);
});

function keysDialog() {
  const dlg = $("#dlg") as HTMLDialogElement;
  dlg.innerHTML = "";
  const row = (k: string, t: string) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, t));
  dlg.append(h("h2", {}, "Atajos de teclado"),
    h("div", { class: "keys" },
      h("table", {}, h("tbody", {},
        h("tr", {}, h("th", { colspan: "2" }, "Añadir")),
        row("B", "Boceto"), row("E", "Extruir (el último boceto sin usar)"), row("C", "Caja"), row("F", "Redondeo"), row("H", "Agujeros"), row("T", "Texto"), row("M", "Mover"),
      )),
      h("table", {}, h("tbody", {},
        h("tr", {}, h("th", { colspan: "2" }, "General")),
        row("Ctrl Z / Ctrl Y", "Deshacer / rehacer"), row("Supr", "Borrar el paso abierto (se puede deshacer)"), row("Esc", "Cerrar el paso o soltar la pieza"),
        row("Ctrl S", "Guardar versión"), row("N / O", "Pieza nueva / Mis piezas"), row("0", "Encajar la vista"), row("?", "Esta ayuda"),
      )),
      h("table", {}, h("tbody", {},
        h("tr", {}, h("th", { colspan: "2" }, "Pieza elegida (clic)")),
        row("G", "Flechas para mover"), row("R", "Aros para girar"), row("Ctrl D", "Copia al lado"), row("P", "Empujar una cara"), row("Mayús+clic en pasos", "Elegir varios para meterlos en una carpeta"), row("V", "Ocultar la pieza elegida (sin ninguna: mostrar todo)"), row("I", "Ver solo la pieza elegida"), row("Botón derecho", "Menú de la pieza"),
        h("tr", {}, h("th", { colspan: "2" }, "Vista")),
        row("Doble clic en cara", "Boceto sobre esa cara"),
        h("tr", {}, h("th", { colspan: "2" }, "En el boceto")),
        row("S L R C P W", "Elegir, líneas, rectángulo, círculo, polígono, camino"), row("Intro", "Acabar la línea"),
      )),
    ),
    h("div", { class: "t-right" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cerrar")));
  dlg.showModal();
}

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
(window as unknown as Record<string, unknown>).geometria = { get doc() { return doc; }, get build() { return build; }, setDoc, viewport };

// ---------- guardado en el servidor ----------
function renderCloud(s: CloudStatus, pending: number) {
  const el = $("#st-cloud");
  el.className = `cloud ${s}`;
  el.textContent = s === "none" ? "" : s === "checking" ? "☁ …" : s === "offline" ? `☁ Sin conexión${pending ? ": se subirá al volver" : ""}` : pending ? "☁ Subiendo…" : "☁ Guardado en el servidor";
  el.title = s === "offline" ? "No llego al servidor. Todo se sigue guardando en este navegador." : s === "on" ? "Tus piezas están en el servidor: las ves en todos tus equipos." : "";
}
cloud.hooks = {
  onStatus: renderCloud,
  onConflict: (id, copyId) => {
    if (id !== docId) return;
    const d = storage.load(copyId);
    if (d) setDoc(d, copyId, false);
    toast(`Otro equipo había cambiado «${storage.load(id)?.name ?? "esta pieza"}». Lo tuyo sigue aquí como «${d?.name}»; la otra está en Mis piezas.`);
  },
  onPulled: (ids) => {
    if (ids.includes(docId)) {
      const d = storage.load(docId);
      if (!d) {
        // la borraron en otro equipo: aquí sigue abierta, y se vuelve a guardar
        saveDoc(docId, doc);
        toast("Esta pieza se borró en otro equipo. Aquí sigue abierta y se ha vuelto a guardar.");
      } else if (JSON.stringify(d) !== JSON.stringify(doc) && !active) {
        setDoc(d, docId);
        toast("Pieza puesta al día con los cambios de otro equipo");
      }
    }
    const dlg = $("#dlg") as HTMLDialogElement;
    if (dlg.open && dlg.querySelector(".gallery")) openDialog();
  },
};
void cloud.init().then(() => {
  const n = cloud.localOnly().length;
  if (cloud.status === "on" && n) toast(`${n === 1 ? "Tienes 1 pieza" : `Tienes ${n} piezas`} solo en este navegador`, { label: "Subirlas", run: async () => { const k = await cloud.uploadLocal(); toast(`${k === 1 ? "1 pieza subida" : `${k} piezas subidas`} al servidor`); } });
});
