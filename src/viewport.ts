// Vista 3D con three.js. Z hacia arriba, como en Rhino y en los programas de impresión.
// Dos cámaras: en perspectiva (como la ve el ojo) y paralela/isométrica (las medidas no
// se deforman con la distancia). Las vistas Arriba, Frente, etc. van siempre en paralela.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { BodyMesh, Vec3 } from "./types";
import type { Basis } from "./geom";
import { circleFrom, faceKind, type Circle3, type FaceKind } from "./measure";

export type PickMode = "none" | "edge" | "face" | "measure";

/** Lo que se ha tocado al medir: un punto, una arista circular o una cara (plana o cilíndrica) */
export type MeasureItem =
  | { kind: "point"; p: Vec3 }
  | { kind: "circle"; p: Vec3; circle: Circle3 }
  | { kind: "face"; p: Vec3; face: FaceKind };
export type ViewName = "iso" | "top" | "bottom" | "front" | "back" | "left" | "right";

export interface ViewportEvents {
  onEdgePick?: (point: Vec3) => void;
  onFacePick?: (point: Vec3, normal: Vec3) => void;
  onMeasure?: (items: MeasureItem[]) => void;
  /** clic sin herramienta: el cuerpo que hay debajo (o null si es el vacío) */
  onBodyClick?: (id: string | null) => void;
  /** botón derecho sin arrastrar: cuerpo debajo (o null) y dónde abrir el menú */
  onBodyMenu?: (id: string | null, x: number, y: number, face: { point: Vec3; normal: Vec3 } | null) => void;
  /** doble clic sobre una cara sin herramienta: para dibujar encima */
  onFaceDouble?: (point: Vec3, normal: Vec3) => void;
}

/** Lo que se ha movido con las flechas: mm y grados (un solo eje de giro por arrastre) */
export interface GizmoDelta { dx: number; dy: number; dz: number; rx: number; ry: number; rz: number }

export interface Marks {
  edges?: Vec3[];
  faces?: Vec3[];
  /** puntos con su normal (agujeros, varillas) */
  pins?: { p: Vec3; n: Vec3 }[];
  plane?: Basis | null;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

const VIEW_DIRS: Record<ViewName, Vec3> = {
  iso: [1, -1, 1], // isométrica de verdad: los tres ejes con el mismo ángulo
  top: [0, -1e-4, 1], // un pelín inclinada para que el giro (con Z arriba) no se bloquee
  bottom: [0, -1e-4, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  /** true = la vista 3D usa perspectiva; false = paralela (isométrica) */
  perspective3d = true;
  private light: THREE.DirectionalLight;
  private bodiesGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private markGroup = new THREE.Group();
  private measureGroup = new THREE.Group();
  private checkGroup = new THREE.Group();
  private refGroup = new THREE.Group();
  private clashGroup = new THREE.Group();
  private textures = new Map<string, THREE.Texture>();
  private grid!: THREE.GridHelper;
  private axes!: THREE.Group;
  private hoverObj: THREE.Object3D | null = null;
  private edgeObjects: { line: THREE.LineSegments; pts: Float32Array; groups: { start: number; count: number }[] }[] = [];
  private bodyData: BodyMesh[] = [];
  measurePts: Vec3[] = [];
  measureItems: MeasureItem[] = [];
  pickMode: PickMode = "none";
  events: ViewportEvents = {};
  private needsFit = true;
  private down: { x: number; y: number } | null = null;
  /** el último toque fue con el dedo: se elige con más margen */
  private touch = false;
  /** plano de corte (null = sin corte) */
  private section: THREE.Plane | null = null;
  private colors: Record<string, string> = {};
  /** flechas para mover/girar un cuerpo con el ratón o el dedo */
  private gizmo: TransformControls | null = null;
  private gizmoObj = new THREE.Object3D();
  private gizmoBody = "";
  private gizmoDone: ((d: GizmoDelta) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, -100000, 100000);
    for (const c of [this.persp, this.ortho]) c.up.set(0, 0, 1);
    this.persp.position.set(120, -160, 110);
    this.camera = this.persp;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1.4);
    hemi.position.set(0, 0, 1);
    this.light = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(hemi, this.light, this.light.target, this.bodiesGroup, this.sketchGroup, this.markGroup, this.measureGroup, this.checkGroup, this.refGroup, this.clashGroup);
    this.buildGrid(200);
    this.applyTheme();

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    const el = this.renderer.domElement;
    // flecha de «Empujar cara»: se coge antes que la órbita de la cámara (por eso en captura)
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.push || !this.hitPush(e)) return;
      const p = this.push;
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      this.pushDrag = { start: p.dist, t0: this.lineParam(e) };
    }, { capture: true });
    el.addEventListener("pointermove", (e) => {
      if (!this.pushDrag || !this.push) return;
      const raw = this.pushDrag.start + this.lineParam(e) - this.pushDrag.t0;
      const d = Math.round(raw * 2) / 2; // medio milímetro
      if (d !== this.push.dist) { this.push.dist = d; this.drawPush(); }
    });
    el.addEventListener("pointerdown", (e) => { this.down = { x: e.clientX, y: e.clientY }; this.touch = e.pointerType === "touch"; });
    el.addEventListener("pointerup", (e) => {
      if (this.pushDrag) {
        this.pushDrag = null;
        this.down = null;
        this.controls.enabled = true;
        if (this.push) this.push.onDone(this.push.dist);
        return;
      }
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved < (this.touch ? 12 : 5) && e.button === 0) this.click(e);
    });
    el.addEventListener("pointermove", (e) => this.hover(e));
    // botón derecho: menú de la pieza, al soltar y solo si no has arrastrado para mover la vista
    // (en Mac y Linux el navegador avisa al pulsar; esperando a soltar va igual en todos)
    let right: { x: number; y: number } | null = null;
    el.addEventListener("pointerdown", (e) => { right = e.button === 2 ? { x: e.clientX, y: e.clientY } : null; });
    el.addEventListener("pointerup", (e) => {
      const r = right;
      right = null;
      if (e.button !== 2 || !r || this.pickMode !== "none" || Math.hypot(e.clientX - r.x, e.clientY - r.y) > 5) return;
      const f = this.pickFace(e);
      this.events.onBodyMenu?.(this.pickBody(e), e.clientX, e.clientY, f ? { point: [f.point.x, f.point.y, f.point.z], normal: [f.normal.x, f.normal.y, f.normal.z] } : null);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("dblclick", (e) => {
      if (this.pickMode !== "none" || this.explodeK > 0) return;
      const f = this.pickFace(e as PointerEvent);
      if (f) this.events.onFaceDouble?.([f.point.x, f.point.y, f.point.z], [f.normal.x, f.normal.y, f.normal.z]);
    });

    const loop = () => {
      this.anim?.(performance.now());
      this.placePushLabel();
      this.controls.update();
      // la luz principal sale siempre desde un poco por encima de la cámara
      const off = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      this.light.position.copy(this.controls.target).add(off).add(new THREE.Vector3(0, 0, off.length() * 0.6));
      this.light.target.position.copy(this.controls.target);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
  }

  get isOrtho() { return this.camera === this.ortho; }

  // ---------- vista explosionada ----------
  private explodeK = 0;
  private explodeMode: "center" | "up" = "center";
  /** algo que se mueve en cada fotograma (el vídeo) */
  private anim: ((t: number) => void) | null = null;

  /** Separa los cuerpos: k = 0 juntos, 1 = separados del todo. «up» = apilados hacia arriba */
  setExplode(k: number, mode: "center" | "up" = this.explodeMode) {
    this.explodeK = Math.max(0, k);
    this.explodeMode = mode;
    this.applyExplode();
  }
  get exploded() { return this.explodeK > 0; }
  /** Encuadra con las piezas separadas del todo */
  fitExploded() {
    const k = this.explodeK;
    this.setExplode(1);
    this.fit();
    this.setExplode(k);
  }

  private applyExplode() {
    const kids = this.bodiesGroup.children;
    const boxes = new Map<string, THREE.Box3>();
    for (const c of kids) {
      const m = c as THREE.Mesh;
      if (!m.isMesh || c.userData.cap) continue;
      m.geometry.computeBoundingBox();
      const bb = boxes.get(c.userData.body) ?? new THREE.Box3();
      bb.union(m.geometry.boundingBox!);
      boxes.set(c.userData.body, bb);
    }
    const all = new THREE.Box3();
    boxes.forEach((bb) => all.union(bb));
    const size = all.isEmpty() ? 50 : all.getSize(new THREE.Vector3()).length();
    const center = all.isEmpty() ? new THREE.Vector3() : all.getCenter(new THREE.Vector3());
    const off = new Map<string, THREE.Vector3>();
    if (this.explodeMode === "up") {
      // apilados: cada cuerpo sube según su orden de abajo a arriba
      const order = [...boxes.entries()].sort((a, b) => a[1].getCenter(new THREE.Vector3()).z - b[1].getCenter(new THREE.Vector3()).z);
      const step = (all.isEmpty() ? 20 : all.getSize(new THREE.Vector3()).z * 0.6 + 10) * this.explodeK;
      order.forEach(([id], i) => off.set(id, new THREE.Vector3(0, 0, i * step)));
    } else {
      boxes.forEach((bb, id) => {
        const d = bb.getCenter(new THREE.Vector3()).sub(center);
        // si un cuerpo está justo en el centro, sube un poco para que se vea
        if (d.length() < size * 0.02) d.set(0, 0, 1);
        // cada pieza se aleja en su dirección: un tramo fijo (para que se separen las que están pegadas) más su distancia al centro
        const dist = d.length();
        off.set(id, d.normalize().multiplyScalar((size * 0.45 + dist) * this.explodeK));
      });
    }
    for (const c of kids) c.position.copy(off.get(c.userData.body) ?? new THREE.Vector3());
    // los marcadores y choques dejan de cuadrar al separar: se esconden
    for (const g of [this.markGroup, this.clashGroup, this.checkGroup, this.measureGroup]) g.visible = this.explodeK === 0;
  }

  /** Formato de vídeo que sabe grabar este navegador */
  static videoType(): string | null {
    if (typeof MediaRecorder === "undefined") return null;
    for (const t of ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"]) if (MediaRecorder.isTypeSupported(t)) return t;
    return null;
  }

  /**
   * Graba un vídeo corto: se separan las piezas, la cámara da una vuelta y se vuelven a juntar.
   * Devuelve el vídeo (MP4 o WebM según el navegador).
   */
  recordExplode(seconds = 8, onProgress?: (f: number) => void): Promise<Blob> {
    const type = Viewport.videoType();
    if (!type) return Promise.reject(new Error("este navegador no sabe grabar vídeo"));
    const canvas = this.renderer.domElement;
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const kWas = this.explodeK;
    const camWas = this.camera.position.clone(), targetWas = this.controls.target.clone();
    // encuadre con las piezas separadas del todo, para que no se salgan
    this.setExplode(1);
    this.fit();
    this.setExplode(0);
    const target = this.controls.target.clone();
    const start = this.camera.position.clone().sub(target);
    const hide = [this.sketchGroup, this.refGroup];
    const was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const ease = (x: number) => 0.5 - Math.cos(Math.PI * Math.min(1, Math.max(0, x))) / 2;
    return new Promise((res, rej) => {
      let t0 = 0;
      rec.onstop = () => {
        this.anim = null;
        hide.forEach((o, i) => (o.visible = was[i]));
        this.controls.target.copy(targetWas);
        this.camera.position.copy(camWas);
        this.setExplode(kWas);
        res(new Blob(chunks, { type: type.split(";")[0] }));
      };
      rec.onerror = () => { this.anim = null; rej(new Error("falló la grabación")); };
      this.anim = (now) => {
        if (!t0) t0 = now;
        const f = (now - t0) / (seconds * 1000);
        onProgress?.(Math.min(1, f));
        // 0–30 %: se separan · 30–75 %: vuelta de cámara · 75–100 %: se juntan
        const k = f < 0.3 ? ease(f / 0.3) : f < 0.75 ? 1 : 1 - ease((f - 0.75) / 0.25);
        this.setExplode(k);
        const ang = ease(Math.min(1, f / 0.9)) * Math.PI * 2;
        const p = start.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), ang);
        this.camera.position.copy(target).add(p);
        this.camera.lookAt(target);
        if (f >= 1 && rec.state === "recording") { this.anim = null; rec.stop(); }
      };
      rec.start(250);
    });
  }

  applyTheme() {
    this.scene.background = new THREE.Color(css("--view-bg"));
    this.buildGrid(this.gridSize);
  }

  private gridSize = 200;
  private buildGrid(size: number) {
    this.gridSize = size;
    if (this.grid) this.scene.remove(this.grid);
    if (this.axes) this.scene.remove(this.axes);
    const div = Math.round(size / 10);
    this.grid = new THREE.GridHelper(size, div, new THREE.Color(css("--grid-main")), new THREE.Color(css("--grid")));
    this.grid.rotation.x = Math.PI / 2;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.9;
    this.scene.add(this.grid);
    this.axes = new THREE.Group();
    const L = size / 2;
    const mk = (to: Vec3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...to)]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    };
    this.axes.add(mk([L, 0, 0], 0xd9534f), mk([0, L, 0], 0x4cae4c), mk([0, 0, L / 2], 0x3b7dd8));
    this.axes.position.z = size / 20000; // un pelo por encima de la rejilla
    this.scene.add(this.axes);
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.setOrthoHeight((this.ortho.top - this.ortho.bottom) / 2);
  }

  private setOrthoHeight(half: number) {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const a = w / h;
    this.ortho.left = -half * a; this.ortho.right = half * a;
    this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }

  /** Cambia de cámara manteniendo el mismo punto de vista y tamaño aparente */
  private useCamera(ortho: boolean) {
    if (ortho === this.isOrtho) return;
    const from = this.camera, to = ortho ? this.ortho : this.persp;
    const target = this.controls.target;
    const dir = from.position.clone().sub(target).normalize();
    const fovHalf = THREE.MathUtils.degToRad(this.persp.fov / 2);
    if (ortho) {
      const dist = from.position.distanceTo(target);
      this.setOrthoHeight(dist * Math.tan(fovHalf));
      this.ortho.zoom = 1;
      this.ortho.position.copy(target).addScaledVector(dir, Math.max(dist, 10));
    } else {
      const half = (this.ortho.top - this.ortho.bottom) / 2 / this.ortho.zoom;
      const dist = half / Math.tan(fovHalf);
      this.persp.position.copy(target).addScaledVector(dir, dist);
    }
    to.updateProjectionMatrix();
    this.camera = to;
    this.controls.object = to;
    if (this.gizmo) this.gizmo.camera = to;
    this.controls.update();
  }

  /** Centro de la caja de un cuerpo dibujado */
  /** Caja de un cuerpo dibujado: [mínimo, máximo] */
  bodyBox(id: string): [Vec3, Vec3] | null {
    const box = new THREE.Box3();
    for (const c of this.bodiesGroup.children) if (c.userData.body === id && (c as THREE.Mesh).isMesh && !c.userData.cap) box.expandByObject(c);
    if (box.isEmpty()) return null;
    return [[box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]];
  }

  bodyCenter(id: string): Vec3 | null {
    const box = new THREE.Box3();
    for (const c of this.bodiesGroup.children) if (c.userData.body === id && (c as THREE.Mesh).isMesh && !c.userData.cap) box.expandByObject(c);
    if (box.isEmpty()) return null;
    const v = box.getCenter(new THREE.Vector3());
    return [v.x, v.y, v.z];
  }

  /**
   * Flechas sobre un cuerpo: al soltar, avisa de cuánto se movió (mm) y giró en Z (grados).
   * Mientras arrastras, el cuerpo se mueve en la vista (la pieza de verdad se recalcula al soltar).
   */
  setGizmo(g: { body: string; center: Vec3; mode: "translate" | "rotate"; onDone: (d: GizmoDelta) => void } | null) {
    if (!g) {
      if (this.gizmo) { this.scene.remove(this.gizmo.getHelper()); this.gizmo.detach(); this.gizmo.dispose(); this.gizmo = null; }
      this.gizmoDone = null;
      return;
    }
    if (!this.gizmo) {
      const tc = new TransformControls(this.camera, this.renderer.domElement);
      tc.setSpace("world");
      tc.addEventListener("dragging-changed", (e) => {
        this.controls.enabled = !(e as unknown as { value: boolean }).value;
        if (!(e as unknown as { value: boolean }).value) this.finishGizmo();
      });
      tc.addEventListener("objectChange", () => this.previewGizmo());
      this.scene.add(this.gizmoObj);
      this.scene.add(tc.getHelper());
      this.gizmo = tc;
    }
    const tc = this.gizmo;
    tc.camera = this.camera;
    tc.setMode(g.mode);
    tc.showX = true; tc.showY = true; tc.showZ = true;
    // pasos limpios: medio milímetro y 5 grados
    tc.setTranslationSnap(0.5);
    tc.setRotationSnap(THREE.MathUtils.degToRad(5));
    tc.size = this.touch || matchMedia("(pointer: coarse)").matches ? 1.4 : 1;
    this.gizmoBody = g.body;
    this.gizmoDone = g.onDone;
    this.gizmoObj.position.set(...g.center);
    this.gizmoObj.rotation.set(0, 0, 0);
    this.gizmoObj.userData.start = [...g.center];
    tc.attach(this.gizmoObj);
  }

  private gizmoMatrix() {
    const c = new THREE.Vector3(...(this.gizmoObj.userData.start as Vec3));
    this.gizmoObj.updateMatrix();
    return this.gizmoObj.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  }

  private previewGizmo() {
    const m = this.gizmoMatrix();
    for (const c of this.bodiesGroup.children) if (c.userData.body === this.gizmoBody) {
      c.matrixAutoUpdate = false;
      c.matrix.copy(m);
      c.matrixWorldNeedsUpdate = true;
    }
  }

  private finishGizmo() {
    const st = this.gizmoObj.userData.start as Vec3;
    const p = this.gizmoObj.position;
    const r = this.gizmoObj.rotation;
    const deg = (v: number) => Math.round(THREE.MathUtils.radToDeg(v) * 1000) / 1000;
    const d: GizmoDelta = { dx: p.x - st[0], dy: p.y - st[1], dz: p.z - st[2], rx: deg(r.x), ry: deg(r.y), rz: deg(r.z) };
    if (Math.hypot(d.dx, d.dy, d.dz) < 1e-6 && Math.hypot(d.rx, d.ry, d.rz) < 1e-6) return;
    this.gizmoDone?.(d);
  }

  private clip() { return this.section ? [this.section] : []; }

  /**
   * Corte: esconde lo que queda a un lado de un plano perpendicular a X, Y o Z.
   * `at` va de 0 a 1 dentro de la caja de la pieza. Por dentro se ve en otro color (la "tapa").
   */
  setSection(s: { axis: 0 | 1 | 2; at: number; flip: boolean } | null) {
    if (!s) this.section = null;
    else {
      const box = new THREE.Box3().setFromObject(this.bodiesGroup);
      const lo = box.isEmpty() ? -50 : box.min.getComponent(s.axis), hi = box.isEmpty() ? 50 : box.max.getComponent(s.axis);
      const pos = lo + (hi - lo) * s.at;
      const n = new THREE.Vector3(); n.setComponent(s.axis, s.flip ? 1 : -1);
      // se ve lo que cumple n·p + c >= 0
      this.section = new THREE.Plane(n, s.flip ? -pos : pos);
    }
    this.applyClip();
  }

  private applyClip() {
    const planes = this.clip();
    for (const g of [this.bodiesGroup, this.checkGroup, this.markGroup, this.clashGroup]) g.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) { m.clippingPlanes = planes; m.needsUpdate = true; }
      if (o.userData.cap) o.visible = !!this.section;
    });
  }

  setBodies(bodies: BodyMesh[], colors: Record<string, string> = this.colors) {
    this.colors = colors;
    for (const c of [...this.bodiesGroup.children]) {
      this.bodiesGroup.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    this.edgeObjects = [];
    this.bodyData = bodies;
    const bodyColor = new THREE.Color(css("--body"));
    const edgeColor = new THREE.Color(css("--edge"));
    for (const b of bodies) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(b.vertices, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(b.normals, 3));
      g.setIndex(new THREE.BufferAttribute(b.triangles, 1));
      const mat = new THREE.MeshStandardMaterial({
        color: colors[b.id] ? new THREE.Color(colors[b.id]) : bodyColor, metalness: 0.05, roughness: 0.55,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.body = b.id;
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.BufferAttribute(b.lines, 3));
      const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: edgeColor }));
      lines.userData.body = b.id;
      // replicad cuenta las aristas en puntos; aquí se pasan a posiciones del array (×3)
      this.edgeObjects.push({ line: lines, pts: b.lines, groups: b.edgeGroups.map((g) => ({ start: g.start * 3, count: g.count * 3 })) });
      // la "tapa" del corte: las caras de dentro, en color plano
      // (más oscura que el cuerpo, para que se distinga del resto)
      const capColor = (colors[b.id] ? new THREE.Color(colors[b.id]) : new THREE.Color(css("--cap"))).multiplyScalar(colors[b.id] ? 0.55 : 1);
      const cap = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: capColor, side: THREE.BackSide }));
      cap.userData.cap = true;
      cap.userData.body = b.id;
      this.bodiesGroup.add(mesh, lines, cap);
    }
    this.applyClip();
    this.applyExplode();
    this.applyHidden();
    if (this.selected) this.setSelected(this.selected);
    if (this.needsFit && bodies.length) {
      this.needsFit = false;
      this.fit();
    }
  }

  /** Comprobación para imprimir: zonas coloreadas y el volumen de la cama */
  setCheck(c: { layers: { tris: Float32Array; color: string }[]; bed: [number, number, number] } | null) {
    this.clearGroup(this.checkGroup);
    if (!c) return;
    for (const l of c.layers) {
      if (!l.tris.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(l.tris, 3));
      this.checkGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: new THREE.Color(l.color), transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      })));
    }
    this.applyClip();
    const [x, y, z] = c.bed;
    const box = new THREE.Box3(new THREE.Vector3(-x / 2, -y / 2, 0), new THREE.Vector3(x / 2, y / 2, z));
    this.checkGroup.add(new THREE.Box3Helper(box, new THREE.Color(css("--muted"))));
  }

  /** Zonas donde dos cuerpos se meten uno en otro, en rojo y visibles a través de la pieza */
  setClash(list: Float32Array[] | null) {
    this.clearGroup(this.clashGroup);
    if (!list) return;
    for (const tris of list) {
      if (!tris.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(tris, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xe03131, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      mesh.renderOrder = 10;
      this.clashGroup.add(mesh);
    }
    this.applyClip();
  }

  /** Imágenes de referencia de los bocetos, como láminas en su plano */
  setRefImages(list: { url: string; basis: Basis; x: number; y: number; w: number; h: number; opacity: number }[]) {
    for (const c of [...this.refGroup.children]) {
      this.refGroup.remove(c);
      const m = c as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const im of list) {
      let tex = this.textures.get(im.url);
      if (!tex) {
        tex = new THREE.TextureLoader().load(im.url);
        tex.colorSpace = THREE.SRGBColorSpace;
        this.textures.set(im.url, tex);
      }
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(im.w, im.h), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: im.opacity, side: THREE.DoubleSide, depthWrite: false,
      }));
      const b = im.basis;
      const mx = new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.x), new THREE.Vector3(...b.y), new THREE.Vector3(...b.n));
      const cu = im.x + im.w / 2, cv = im.y + im.h / 2;
      mx.setPosition(new THREE.Vector3(
        b.origin[0] + b.x[0] * cu + b.y[0] * cv, b.origin[1] + b.x[1] * cu + b.y[1] * cv, b.origin[2] + b.x[2] * cu + b.y[2] * cv));
      mesh.applyMatrix4(mx);
      mesh.renderOrder = -1;
      this.refGroup.add(mesh);
    }
  }

  /** Contornos de bocetos (en 3D) */
  setSketchLines(list: { pts: Vec3[][]; active: boolean }[]) {
    this.clearGroup(this.sketchGroup);
    for (const s of list) {
      const color = new THREE.Color(css(s.active ? "--accent" : "--sketch"));
      for (const loop of s.pts) {
        const g = new THREE.BufferGeometry().setFromPoints(loop.map((p) => new THREE.Vector3(...p)));
        this.sketchGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
      }
    }
  }

  private dotSize() { return this.modelSize() / 120; }

  /** Marcas: aristas y caras elegidas, puntos de agujeros y plano de boceto */
  setMarks(m: Marks) {
    this.clearGroup(this.markGroup);
    const accent = new THREE.Color(css("--accent"));
    const dotMat = new THREE.MeshBasicMaterial({ color: accent });
    const dot = (p: Vec3, r = this.dotSize()) => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), dotMat);
      s.position.set(...p);
      this.markGroup.add(s);
    };
    for (const p of m.edges ?? []) {
      const seg = this.nearestEdge(new THREE.Vector3(...p), 1.0);
      if (seg) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(seg, 3));
        this.markGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: accent })));
      }
      dot(p);
    }
    for (const p of m.faces ?? []) {
      const tris = this.faceTriangles(new THREE.Vector3(...p));
      if (tris) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(tris, 3));
        this.markGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
          color: accent, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        })));
      }
      dot(p);
    }
    for (const pin of m.pins ?? []) {
      dot(pin.p, this.dotSize() * 1.3);
      const L = this.modelSize() / 12;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...pin.p),
        new THREE.Vector3(pin.p[0] + pin.n[0] * L, pin.p[1] + pin.n[1] * L, pin.p[2] + pin.n[2] * L),
      ]);
      this.markGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: accent })));
    }
    if (m.plane) {
      const plane = m.plane;
      const S = this.gridSize * 0.35;
      const geo = new THREE.PlaneGeometry(S, S);
      const mx = new THREE.Matrix4().makeBasis(new THREE.Vector3(...plane.x), new THREE.Vector3(...plane.y), new THREE.Vector3(...plane.n));
      mx.setPosition(new THREE.Vector3(...plane.origin));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      mesh.applyMatrix4(mx);
      this.markGroup.add(mesh);
    }
  }

  // ---------- medir ----------
  clearMeasure() {
    this.measurePts = [];
    this.measureItems = [];
    this.drawMeasure();
  }

  /**
   * Qué hay bajo el ratón para medir: un vértice (punto), una arista (si es un círculo o un arco,
   * con su centro y radio) o una cara (plana, o cilíndrica con su diámetro).
   */
  private pickMeasureItem(e: PointerEvent): MeasureItem | null {
    const tol = this.worldPerPixel() * 10;
    const onEdge = this.pickEdge(e);
    if (onEdge) {
      // vértice cerca: manda el punto
      const a = new THREE.Vector3();
      const b2 = new THREE.Vector3();
      for (const eo of this.edgeObjects) if (eo.line.visible) for (const g of eo.groups) {
        // un círculo cerrado empieza y acaba en el mismo punto: esa «costura» no es un vértice de verdad
        a.fromArray(eo.pts, g.start); b2.fromArray(eo.pts, g.start + g.count - 3);
        if (g.count > 6 && a.distanceTo(b2) < 1e-6) continue;
        for (const i of [g.start, g.start + g.count - 3]) {
          a.fromArray(eo.pts, i);
          if (a.distanceTo(onEdge) < tol) return { kind: "point", p: [a.x, a.y, a.z] };
        }
      }
      const seg = this.nearestEdge(onEdge, 1e-3 + this.worldPerPixel());
      if (seg) {
        const pts: Vec3[] = [];
        for (let i = 0; i < seg.length; i += 6) pts.push([seg[i], seg[i + 1], seg[i + 2]]);
        if (seg.length >= 6) pts.push([seg[seg.length - 3], seg[seg.length - 2], seg[seg.length - 1]]);
        const circle = circleFrom(pts);
        if (circle) return { kind: "circle", p: [onEdge.x, onEdge.y, onEdge.z], circle };
      }
      return { kind: "point", p: [onEdge.x, onEdge.y, onEdge.z] };
    }
    const f = this.pickFace(e);
    if (!f) return null;
    const g = this.faceGroupAt(f.point);
    const face: FaceKind = g ? faceKind(g.verts, g.normals) : { kind: "plane", normal: [f.normal.x, f.normal.y, f.normal.z] };
    return { kind: "face", p: [f.point.x, f.point.y, f.point.z], face };
  }

  /** Vértices y normales de la cara (de la malla) más cercana al punto */
  private faceGroupAt(p: THREE.Vector3): { verts: Vec3[]; normals: Vec3[] } | null {
    let best: { d: number; b: BodyMesh; g: { start: number; count: number } } | null = null;
    const tri = new THREE.Triangle(), q = new THREE.Vector3();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (const b of this.bodyData) {
      if (this.hiddenIds.has(b.id)) continue;
      for (const g of b.faceGroups) {
        let d = Infinity;
        for (let i = g.start; i < g.start + g.count; i += 3) {
          A.fromArray(b.vertices, b.triangles[i] * 3); B.fromArray(b.vertices, b.triangles[i + 1] * 3); C.fromArray(b.vertices, b.triangles[i + 2] * 3);
          tri.set(A, B, C).closestPointToPoint(p, q);
          d = Math.min(d, q.distanceTo(p));
        }
        if (!best || d < best.d) best = { d, b, g };
      }
    }
    if (!best || best.d > 1) return null;
    const seen = new Set<number>(), verts: Vec3[] = [], normals: Vec3[] = [];
    for (let k = best.g.start; k < best.g.start + best.g.count; k++) {
      const vi = best.b.triangles[k];
      if (seen.has(vi)) continue;
      seen.add(vi);
      verts.push([best.b.vertices[vi * 3], best.b.vertices[vi * 3 + 1], best.b.vertices[vi * 3 + 2]]);
      normals.push([best.b.normals[vi * 3], best.b.normals[vi * 3 + 1], best.b.normals[vi * 3 + 2]]);
    }
    return { verts, normals };
  }

  private drawMeasure() {
    this.clearGroup(this.measureGroup);
    const color = new THREE.Color(css("--hover"));
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
    for (const p of this.measurePts) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(this.dotSize() * 1.2, 12, 8), mat);
      s.position.set(...p);
      s.renderOrder = 10;
      this.measureGroup.add(s);
    }
    for (const m of this.measureItems) {
      if (m.kind !== "circle") continue;
      // el círculo reconocido, resaltado
      const { center, normal, r } = m.circle;
      const n = new THREE.Vector3(...normal), t = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const u = new THREE.Vector3().crossVectors(n, t).normalize(), w = new THREE.Vector3().crossVectors(n, u);
      const pts = Array.from({ length: 65 }, (_, i) => { const a = (i / 64) * Math.PI * 2; return new THREE.Vector3(...center).addScaledVector(u, r * Math.cos(a)).addScaledVector(w, r * Math.sin(a)); });
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 10;
      this.measureGroup.add(l);
    }
    if (this.measurePts.length === 2) {
      const g = new THREE.BufferGeometry().setFromPoints(this.measurePts.map((p) => new THREE.Vector3(...p)));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 10;
      this.measureGroup.add(l);
    }
  }

  /** Punto para medir: vértice si está cerca, si no un punto de arista, si no de cara */
  private pickMeasure(e: PointerEvent): THREE.Vector3 | null {
    const tol = this.worldPerPixel() * 10;
    const onEdge = this.pickEdge(e);
    if (onEdge) {
      let best: THREE.Vector3 | null = null, bd = tol;
      const a = new THREE.Vector3();
      for (const eo of this.edgeObjects) if (eo.line.visible) for (const g of eo.groups) {
        for (const i of [g.start, g.start + g.count - 3]) {
          a.fromArray(eo.pts, i);
          const d = a.distanceTo(onEdge);
          if (d < bd) { bd = d; best = a.clone(); }
        }
      }
      return best ?? onEdge;
    }
    return this.pickFace(e)?.point ?? null;
  }

  private worldPerPixel() {
    const h = this.host.clientHeight || 1;
    if (this.isOrtho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const dist = this.camera.position.distanceTo(this.controls.target);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / h;
  }

  private clearGroup(g: THREE.Group) {
    for (const c of [...g.children]) {
      g.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
  }

  private nearestEdge(p: THREE.Vector3, tol: number): Float32Array | null {
    let best: { d: number; arr: Float32Array } | null = null;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), line = new THREE.Line3(), q = new THREE.Vector3();
    for (const eo of this.edgeObjects) {
      if (!eo.line.visible) continue;
      for (const g of eo.groups) {
        let d = Infinity;
        for (let i = g.start; i < g.start + g.count; i += 6) {
          a.fromArray(eo.pts, i); b.fromArray(eo.pts, i + 3);
          line.set(a, b);
          line.closestPointToPoint(p, true, q);
          d = Math.min(d, q.distanceTo(p));
        }
        if (d < tol && (!best || d < best.d)) best = { d, arr: eo.pts.slice(g.start, g.start + g.count) };
      }
    }
    return best?.arr ?? null;
  }

  /** Triángulos (posiciones sueltas) de la cara de la pieza más cercana al punto */
  private faceTriangles(p: THREE.Vector3): Float32Array | null {
    let best: { d: number; b: BodyMesh; g: { start: number; count: number } } | null = null;
    const tri = new THREE.Triangle(), q = new THREE.Vector3();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (const b of this.bodyData) {
      for (const g of b.faceGroups) {
        let d = Infinity;
        for (let i = g.start; i < g.start + g.count; i += 3) {
          A.fromArray(b.vertices, b.triangles[i] * 3);
          B.fromArray(b.vertices, b.triangles[i + 1] * 3);
          C.fromArray(b.vertices, b.triangles[i + 2] * 3);
          tri.set(A, B, C).closestPointToPoint(p, q);
          d = Math.min(d, q.distanceTo(p));
        }
        if (!best || d < best.d) best = { d, b, g };
      }
    }
    if (!best || best.d > 1) return null;
    const out = new Float32Array(best.g.count * 3);
    for (let k = 0; k < best.g.count; k++) {
      const vi = best.b.triangles[best.g.start + k] * 3;
      out[k * 3] = best.b.vertices[vi]; out[k * 3 + 1] = best.b.vertices[vi + 1]; out[k * 3 + 2] = best.b.vertices[vi + 2];
    }
    return out;
  }

  private ray(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(v, this.camera);
    rc.params.Line = { threshold: this.worldPerPixel() * (this.touch ? 16 : 6) };
    return rc;
  }

  private pickEdge(e: PointerEvent): THREE.Vector3 | null {
    const rc = this.ray(e);
    const hits = rc.intersectObjects(this.edgeObjects.filter((o) => o.line.visible).map((o) => o.line), false).filter((h) => !this.section || this.section.distanceToPoint(h.point) >= -1e-6);
    if (!hits.length) return null;
    // una arista tapada por una cara (detrás de ella) no cuenta
    const meshes = this.bodiesGroup.children.filter((c) => (c as THREE.Mesh).isMesh && !c.userData.cap && c.visible);
    const face = rc.intersectObjects(meshes, false).find((fh) => !this.section || this.section.distanceToPoint(fh.point) >= -1e-6);
    const slack = this.worldPerPixel() * 4 + 1e-3;
    const h = hits.find((x) => !face || x.distance <= face.distance + slack);
    if (!h) return null;
    // proyectar el punto exactamente sobre el segmento tocado
    const pts = (h.object as THREE.LineSegments).geometry.getAttribute("position");
    const i = h.index!;
    const a = new THREE.Vector3().fromBufferAttribute(pts, i), b = new THREE.Vector3().fromBufferAttribute(pts, i + 1);
    const out = new THREE.Vector3();
    new THREE.Line3(a, b).closestPointToPoint(h.point, true, out);
    return out;
  }

  private pickFace(e: PointerEvent) {
    const rc = this.ray(e);
    const meshes = this.bodiesGroup.children.filter((c) => (c as THREE.Mesh).isMesh && !c.userData.cap && c.visible);
    // con corte, lo que está al otro lado del plano no se puede tocar
    const hit = rc.intersectObjects(meshes, false).find((h) => !this.section || this.section.distanceToPoint(h.point) >= -1e-6);
    if (!hit || !hit.face) return null;
    return { point: hit.point, normal: hit.face.normal.clone() };
  }

  // ---------- flecha para empujar una cara ----------
  private push: { point: Vec3; normal: Vec3; dist: number; onDone: (d: number) => void } | null = null;
  private pushDrag: { start: number; t0: number } | null = null;
  private pushGroup = new THREE.Group();
  private pushLabel: HTMLDivElement | null = null;
  /**
   * Flecha sobre una cara: arrastrándola cambia la distancia (de medio en medio mm) y se ve
   * en transparente cómo quedará. Al soltar avisa con la distancia nueva.
   */
  setPush(p: { point: Vec3; normal: Vec3; dist: number; onDone: (d: number) => void } | null) {
    this.push = p ? { ...p } : null;
    if (!this.pushGroup.parent) this.scene.add(this.pushGroup);
    this.drawPush();
  }
  private clearPush() {
    for (const c of [...this.pushGroup.children]) {
      this.pushGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
  }
  private drawPush() {
    this.clearPush();
    if (!this.pushLabel) {
      this.pushLabel = document.createElement("div");
      this.pushLabel.className = "push-label";
      this.host.append(this.pushLabel);
    }
    const p = this.push;
    this.pushLabel.hidden = !p;
    if (!p) return;
    const n = new THREE.Vector3(...p.normal).normalize();
    const o = new THREE.Vector3(...p.point);
    const accent = new THREE.Color(css("--accent"));
    // fantasma: la cara desplazada y sus paredes
    const tris = this.faceTriangles(o);
    if (tris && Math.abs(p.dist) > 1e-9) {
      const off = n.clone().multiplyScalar(p.dist);
      const pos: number[] = [];
      for (let i = 0; i < tris.length; i += 3) pos.push(tris[i] + off.x, tris[i + 1] + off.y, tris[i + 2] + off.z);
      // bordes de la cara = lados de triángulo que no comparte otro triángulo
      const key = (i: number) => `${tris[i].toFixed(3)},${tris[i + 1].toFixed(3)},${tris[i + 2].toFixed(3)}`;
      const edges = new Map<string, [number, number] | null>();
      for (let t = 0; t < tris.length; t += 9) for (const [a, b] of [[t, t + 3], [t + 3, t + 6], [t + 6, t]]) {
        const ka = key(a), kb = key(b), k = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        edges.set(k, edges.has(k) ? null : [a, b]);
      }
      for (const e of edges.values()) {
        if (!e) continue;
        const [a, b] = e;
        const A = [tris[a], tris[a + 1], tris[a + 2]], B = [tris[b], tris[b + 1], tris[b + 2]];
        const A2 = [A[0] + off.x, A[1] + off.y, A[2] + off.z], B2 = [B[0] + off.x, B[1] + off.y, B[2] + off.z];
        pos.push(...A, ...B, ...B2, ...A, ...B2, ...A2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const ghost = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
      ghost.renderOrder = 5;
      this.pushGroup.add(ghost);
    }
    // la flecha, en la punta de lo empujado
    const size = this.worldPerPixel() * 70 * (this.touch ? 1.4 : 1);
    const tip = o.clone().addScaledVector(n, p.dist);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    const mat = new THREE.MeshBasicMaterial({ color: accent, depthTest: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.035, size * 0.035, size * 0.75, 12), mat);
    shaft.position.copy(tip).addScaledVector(n, size * 0.375);
    const head = new THREE.Mesh(new THREE.ConeGeometry(size * 0.12, size * 0.3, 20), mat);
    head.position.copy(tip).addScaledVector(n, size * 0.9);
    // zona invisible más gorda para cogerla fácil
    const grab = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.18, size * 0.18, size * 1.1, 8), new THREE.MeshBasicMaterial({ visible: false }));
    grab.position.copy(tip).addScaledVector(n, size * 0.55);
    grab.userData.grab = true;
    for (const m of [shaft, head, grab]) { m.quaternion.copy(q); m.renderOrder = 10; this.pushGroup.add(m); }
    this.pushTip = head.position.clone();
    this.pushLabel.textContent = `${p.dist > 0 ? "+" : ""}${p.dist.toLocaleString("es-ES")} mm`;
    this.placePushLabel();
  }
  private pushTip = new THREE.Vector3();
  /** la etiqueta con los mm sigue a la punta de la flecha aunque gires la vista */
  private placePushLabel() {
    if (!this.push || !this.pushLabel) return;
    const sp = this.pushTip.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
    this.pushLabel.style.left = `${r.left - hr.left + ((sp.x + 1) / 2) * r.width + 14}px`;
    this.pushLabel.style.top = `${r.top - hr.top + ((1 - sp.y) / 2) * r.height - 10}px`;
  }
  private hitPush(e: PointerEvent) {
    const grab = this.pushGroup.children.filter((c) => c.userData.grab);
    return this.ray(e).intersectObjects(grab, false).length > 0;
  }
  /** Posición a lo largo de la normal de la cara más cercana al rayo del ratón */
  private lineParam(e: PointerEvent): number {
    if (!this.push) return 0;
    const ray = this.ray(e).ray;
    const o = new THREE.Vector3(...this.push.point), n = new THREE.Vector3(...this.push.normal).normalize();
    // punto más cercano entre dos rectas
    const w = o.clone().sub(ray.origin);
    const b = n.dot(ray.direction), d = n.dot(w), e2 = ray.direction.dot(w);
    const den = 1 - b * b;
    if (Math.abs(den) < 1e-6) return 0;
    return (b * e2 - d) / den;
  }

  /** Cuerpos ocultos (solo en la vista: se siguen exportando) */
  private hiddenIds = new Set<string>();
  setHidden(ids: Iterable<string>) {
    this.hiddenIds = new Set(ids);
    this.applyHidden();
  }
  private applyHidden() {
    for (const c of this.bodiesGroup.children) c.visible = !this.hiddenIds.has(c.userData.body as string);
  }

  /** Cuerpo elegido con un clic: se ve resaltado */
  private selected: string | null = null;
  setSelected(id: string | null) {
    this.selected = id;
    for (const c of this.bodiesGroup.children) {
      const m = c as THREE.Mesh;
      if (!m.isMesh || c.userData.cap) continue;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.emissive?.set(c.userData.body === id ? css("--accent") : "#000000");
      if (mat.emissive) mat.emissiveIntensity = c.userData.body === id ? 0.25 : 1;
    }
  }

  private pickBody(e: PointerEvent): string | null {
    const meshes = this.bodiesGroup.children.filter((c) => (c as THREE.Mesh).isMesh && !c.userData.cap && c.visible);
    const hit = this.ray(e).intersectObjects(meshes, false)[0];
    return hit ? (hit.object.userData.body as string) : null;
  }

  private click(e: PointerEvent) {
    if (this.pickMode === "none") {
      // si se ha soltado sobre las flechas, no cambia la elección
      if ((this.gizmo as unknown as { axis: string | null } | null)?.axis) return;
      this.events.onBodyClick?.(this.pickBody(e));
      return;
    }
    if (this.pickMode === "edge") {
      const p = this.pickEdge(e);
      if (p) this.events.onEdgePick?.([p.x, p.y, p.z]);
    } else if (this.pickMode === "face") {
      const f = this.pickFace(e);
      if (f) this.events.onFacePick?.([f.point.x, f.point.y, f.point.z], [f.normal.x, f.normal.y, f.normal.z]);
    } else if (this.pickMode === "measure") {
      const it = this.pickMeasureItem(e);
      if (!it) return;
      // un círculo o un cilindro se mide solo, con un clic; si ya había dos cosas, empieza de nuevo
      const alone = it.kind === "circle" || (it.kind === "face" && it.face.kind === "cylinder");
      if (this.measureItems.length >= 2 || alone || this.measureItems.some((m) => m.kind === "circle" || (m.kind === "face" && m.face.kind === "cylinder"))) this.measureItems = [];
      this.measureItems.push(it);
      this.measurePts = this.measureItems.map((m) => (m.kind === "circle" ? m.circle.center : m.p));
      this.drawMeasure();
      this.events.onMeasure?.(this.measureItems);
    }
  }

  private hover(e: PointerEvent) {
    if (this.hoverObj) {
      this.scene.remove(this.hoverObj);
      (this.hoverObj as THREE.Mesh).geometry?.dispose();
      this.hoverObj = null;
    }
    this.renderer.domElement.style.cursor = "";
    if (this.pickMode === "none" || e.buttons) return;
    const hoverColor = new THREE.Color(css("--hover"));
    if (this.pickMode === "edge") {
      const p = this.pickEdge(e);
      if (!p) return;
      const seg = this.nearestEdge(p, 1e-3 + this.worldPerPixel());
      if (!seg) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(seg, 3));
      this.hoverObj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: hoverColor }));
    } else if (this.pickMode === "face") {
      const f = this.pickFace(e);
      if (!f) return;
      const tris = this.faceTriangles(f.point);
      if (!tris) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(tris, 3));
      this.hoverObj = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: hoverColor, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
    } else {
      const p = this.pickMeasure(e);
      if (!p) return;
      this.hoverObj = new THREE.Mesh(new THREE.SphereGeometry(this.dotSize(), 12, 8), new THREE.MeshBasicMaterial({ color: hoverColor, depthTest: false }));
      this.hoverObj.position.copy(p);
      this.hoverObj.renderOrder = 11;
    }
    this.renderer.domElement.style.cursor = "pointer";
    this.scene.add(this.hoverObj);
  }

  private modelSize() {
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
    return box.isEmpty() ? 50 : box.getSize(new THREE.Vector3()).length();
  }

  /** Caja que envuelve todos los cuerpos (mm) */
  bounds() {
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
    return box.isEmpty() ? null : box;
  }

  fit() {
    // solo lo que se ve: con piezas ocultas, encaja las que quedan
    const box = new THREE.Box3();
    for (const c of this.bodiesGroup.children) if (c.visible) box.expandByObject(c);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 30));
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center);
    const dist = size * 1.6 + 10;
    if (this.isOrtho) {
      this.setOrthoHeight(dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
    }
    this.camera.position.copy(center).addScaledVector(dir, dist);
    const want = Math.max(200, Math.ceil((size * 3) / 100) * 100);
    if (want !== this.gridSize) this.buildGrid(want);
  }

  /** Vista estándar. La 3D respeta perspectiva/paralela; el resto siempre en paralela. */
  view(name: ViewName) {
    this.useCamera(name === "iso" ? !this.perspective3d : true);
    const d = new THREE.Vector3(...VIEW_DIRS[name]).normalize();
    const t = this.controls.target.clone();
    this.camera.position.copy(t).addScaledVector(d, 100);
    this.fit();
  }

  /** Cambia la vista 3D entre perspectiva y paralela */
  setPerspective3d(on: boolean) {
    this.perspective3d = on;
    this.view("iso");
  }

  refit() { this.needsFit = true; }

  /**
   * Miniatura de la pieza (JPEG en base64) para la galería: solo los cuerpos, en vista 3D.
   * Se dibuja en el mismo lienzo y se vuelve a dibujar la vista normal en el mismo instante,
   * así que no se ve ningún parpadeo.
   */
  thumbnail(w = 240, hgt = 180): string | null {
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
    if (box.isEmpty()) return null;
    const canvas = this.renderer.domElement;
    const cw = canvas.width, ch = canvas.height;
    if (cw < 4 || ch < 4) return null;
    const cam = new THREE.PerspectiveCamera(30, cw / ch, 0.1, 100000);
    cam.up.set(0, 0, 1);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 10;
    // que quepa en el recorte 4:3 del centro del lienzo
    const cropA = w / hgt, canvasA = cw / ch;
    const vFov = THREE.MathUtils.degToRad(cam.fov / 2);
    const visibleHalfH = canvasA > cropA ? 1 : canvasA / cropA; // parte de la altura que queda tras recortar
    const dist = radius / (Math.tan(vFov) * visibleHalfH) * 1.08;
    cam.position.copy(center).addScaledVector(new THREE.Vector3(1, -1.25, 0.9).normalize(), dist);
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    const hide = [this.sketchGroup, this.markGroup, this.measureGroup, this.checkGroup, this.refGroup, this.clashGroup, this.grid, this.axes];
    const was = hide.map((o) => o.visible);
    const gz = this.gizmo?.getHelper();
    const gzWas = gz?.visible;
    hide.forEach((o) => (o.visible = false));
    if (gz) gz.visible = false;
    const light = this.light.position.clone();
    this.light.position.copy(cam.position).add(new THREE.Vector3(0, 0, dist * 0.6));
    this.light.target.position.copy(center);
    let url: string | null = null;
    try {
      this.renderer.render(this.scene, cam);
      const out = document.createElement("canvas");
      out.width = w; out.height = hgt;
      const ctx = out.getContext("2d");
      if (ctx) {
        let sw = cw, sh = ch;
        if (canvasA > cropA) sw = ch * cropA; else sh = cw / cropA;
        ctx.drawImage(canvas, (cw - sw) / 2, (ch - sh) / 2, sw, sh, 0, 0, w, hgt);
        url = out.toDataURL("image/jpeg", 0.82);
      }
    } finally {
      hide.forEach((o, i) => (o.visible = was[i]));
      if (gz && gzWas !== undefined) gz.visible = gzWas;
      this.light.position.copy(light);
      this.renderer.render(this.scene, this.camera);
    }
    return url;
  }
}
