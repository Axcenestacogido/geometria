// Vista 3D con three.js. Z hacia arriba, como en Rhino y en los programas de impresión.
// Dos cámaras: en perspectiva (como la ve el ojo) y paralela/isométrica (las medidas no
// se deforman con la distancia). Las vistas Arriba, Frente, etc. van siempre en paralela.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { BodyMesh, Vec3 } from "./types";
import type { Basis } from "./geom";

export type PickMode = "none" | "edge" | "face" | "measure";
export type ViewName = "iso" | "top" | "bottom" | "front" | "back" | "left" | "right";

export interface ViewportEvents {
  onEdgePick?: (point: Vec3) => void;
  onFacePick?: (point: Vec3, normal: Vec3) => void;
  onMeasure?: (points: Vec3[]) => void;
}

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
  private textures = new Map<string, THREE.Texture>();
  private grid!: THREE.GridHelper;
  private axes!: THREE.Group;
  private hoverObj: THREE.Object3D | null = null;
  private edgeObjects: { line: THREE.LineSegments; pts: Float32Array; groups: { start: number; count: number }[] }[] = [];
  private bodyData: BodyMesh[] = [];
  measurePts: Vec3[] = [];
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
  private gizmoDone: ((d: { dx: number; dy: number; dz: number; rz: number }) => void) | null = null;

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
    this.scene.add(hemi, this.light, this.light.target, this.bodiesGroup, this.sketchGroup, this.markGroup, this.measureGroup, this.checkGroup, this.refGroup);
    this.buildGrid(200);
    this.applyTheme();

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => { this.down = { x: e.clientX, y: e.clientY }; this.touch = e.pointerType === "touch"; });
    el.addEventListener("pointerup", (e) => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved < (this.touch ? 12 : 5) && e.button === 0) this.click(e);
    });
    el.addEventListener("pointermove", (e) => this.hover(e));

    const loop = () => {
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
  setGizmo(g: { body: string; center: Vec3; mode: "translate" | "rotate"; onDone: (d: { dx: number; dy: number; dz: number; rz: number }) => void } | null) {
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
    tc.showX = g.mode === "translate"; tc.showY = g.mode === "translate"; tc.showZ = true;
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
    const d = { dx: p.x - st[0], dy: p.y - st[1], dz: p.z - st[2], rz: THREE.MathUtils.radToDeg(this.gizmoObj.rotation.z) };
    if (Math.hypot(d.dx, d.dy, d.dz) < 1e-6 && Math.abs(d.rz) < 1e-6) return;
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
    for (const g of [this.bodiesGroup, this.checkGroup, this.markGroup]) g.traverse((o) => {
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
      this.edgeObjects.push({ line: lines, pts: b.lines, groups: b.edgeGroups });
      // la "tapa" del corte: las caras de dentro, en color plano
      // (más oscura que el cuerpo, para que se distinga del resto)
      const capColor = (colors[b.id] ? new THREE.Color(colors[b.id]) : new THREE.Color(css("--cap"))).multiplyScalar(colors[b.id] ? 0.55 : 1);
      const cap = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: capColor, side: THREE.BackSide }));
      cap.userData.cap = true;
      cap.userData.body = b.id;
      this.bodiesGroup.add(mesh, lines, cap);
    }
    this.applyClip();
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
    this.drawMeasure();
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
      for (const eo of this.edgeObjects) for (const g of eo.groups) {
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
    const hits = rc.intersectObjects(this.edgeObjects.map((o) => o.line), false).filter((h) => !this.section || this.section.distanceToPoint(h.point) >= -1e-6);
    if (!hits.length) return null;
    // proyectar el punto exactamente sobre el segmento tocado
    const h = hits[0];
    const pts = (h.object as THREE.LineSegments).geometry.getAttribute("position");
    const i = h.index!;
    const a = new THREE.Vector3().fromBufferAttribute(pts, i), b = new THREE.Vector3().fromBufferAttribute(pts, i + 1);
    const out = new THREE.Vector3();
    new THREE.Line3(a, b).closestPointToPoint(h.point, true, out);
    return out;
  }

  private pickFace(e: PointerEvent) {
    const rc = this.ray(e);
    const meshes = this.bodiesGroup.children.filter((c) => (c as THREE.Mesh).isMesh && !c.userData.cap);
    // con corte, lo que está al otro lado del plano no se puede tocar
    const hit = rc.intersectObjects(meshes, false).find((h) => !this.section || this.section.distanceToPoint(h.point) >= -1e-6);
    if (!hit || !hit.face) return null;
    return { point: hit.point, normal: hit.face.normal.clone() };
  }

  private click(e: PointerEvent) {
    if (this.pickMode === "edge") {
      const p = this.pickEdge(e);
      if (p) this.events.onEdgePick?.([p.x, p.y, p.z]);
    } else if (this.pickMode === "face") {
      const f = this.pickFace(e);
      if (f) this.events.onFacePick?.([f.point.x, f.point.y, f.point.z], [f.normal.x, f.normal.y, f.normal.z]);
    } else if (this.pickMode === "measure") {
      const p = this.pickMeasure(e);
      if (!p) return;
      if (this.measurePts.length >= 2) this.measurePts = [];
      this.measurePts.push([p.x, p.y, p.z]);
      this.drawMeasure();
      this.events.onMeasure?.(this.measurePts);
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
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
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
}
