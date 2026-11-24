// Vista 3D con three.js. Z hacia arriba, como en Rhino y en los programas de impresión.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BodyMesh, Vec3 } from "./types";
import type { Basis } from "./geom";

export type PickMode = "none" | "edge" | "face";

export interface ViewportEvents {
  onEdgePick?: (point: Vec3) => void;
  onFacePick?: (point: Vec3, normal: Vec3) => void;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private bodiesGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private markGroup = new THREE.Group();
  private grid!: THREE.GridHelper;
  private axes!: THREE.Group;
  private hoverLine: THREE.Line | null = null;
  private edgeObjects: { line: THREE.LineSegments; pts: Float32Array; groups: { start: number; count: number }[] }[] = [];
  pickMode: PickMode = "none";
  events: ViewportEvents = {};
  private needsFit = true;
  private down: { x: number; y: number } | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -160, 110);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1.4);
    hemi.position.set(0, 0, 1);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(1, -1.5, 2.5);
    this.camera.add(dir);
    this.scene.add(hemi, this.camera, this.bodiesGroup, this.sketchGroup, this.markGroup);
    this.buildGrid(200);
    this.applyTheme();

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved < 5 && e.button === 0) this.click(e);
    });
    el.addEventListener("pointermove", (e) => this.hover(e));

    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setBodies(bodies: BodyMesh[], opts: { dim?: boolean } = {}) {
    for (const c of [...this.bodiesGroup.children]) {
      this.bodiesGroup.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    this.edgeObjects = [];
    const bodyColor = new THREE.Color(css("--body"));
    const edgeColor = new THREE.Color(css("--edge"));
    for (const b of bodies) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(b.vertices, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(b.normals, 3));
      g.setIndex(new THREE.BufferAttribute(b.triangles, 1));
      const mat = new THREE.MeshStandardMaterial({
        color: bodyColor, metalness: 0.05, roughness: 0.55,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        transparent: !!opts.dim, opacity: opts.dim ? 0.35 : 1,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.body = b.id;
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.BufferAttribute(b.lines, 3));
      const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: edgeColor }));
      this.edgeObjects.push({ line: lines, pts: b.lines, groups: b.edgeGroups });
      this.bodiesGroup.add(mesh, lines);
    }
    if (this.needsFit && bodies.length) {
      this.needsFit = false;
      this.fit();
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

  /** Marcas: aristas elegidas y plano de boceto */
  setMarks(edgePoints: Vec3[], plane?: Basis | null) {
    this.clearGroup(this.markGroup);
    const accent = new THREE.Color(css("--accent"));
    // resaltar la arista entera más cercana a cada punto
    for (const p of edgePoints) {
      const seg = this.nearestEdge(new THREE.Vector3(...p), 1.0);
      if (seg) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(seg, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: accent, linewidth: 3 }));
        this.markGroup.add(l);
      }
      const dot = new THREE.Mesh(new THREE.SphereGeometry(this.modelSize() / 120, 12, 8), new THREE.MeshBasicMaterial({ color: accent }));
      dot.position.set(...p);
      this.markGroup.add(dot);
    }
    if (plane) {
      const S = this.gridSize * 0.35;
      const geo = new THREE.PlaneGeometry(S, S);
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...plane.x), new THREE.Vector3(...plane.y), new THREE.Vector3(...plane.n));
      m.setPosition(new THREE.Vector3(...plane.origin));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      mesh.applyMatrix4(m);
      this.markGroup.add(mesh);
    }
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

  private ray(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(v, this.camera);
    // umbral de líneas proporcional a la distancia
    rc.params.Line = { threshold: this.camera.position.distanceTo(this.controls.target) / 120 };
    return rc;
  }

  private pickEdge(e: PointerEvent): THREE.Vector3 | null {
    const rc = this.ray(e);
    const hits = rc.intersectObjects(this.edgeObjects.map((o) => o.line), false);
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
    const meshes = this.bodiesGroup.children.filter((c) => (c as THREE.Mesh).isMesh);
    const hit = rc.intersectObjects(meshes, false)[0];
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
    }
  }

  private hover(e: PointerEvent) {
    if (this.hoverLine) { this.scene.remove(this.hoverLine); this.hoverLine.geometry.dispose(); this.hoverLine = null; }
    if (this.pickMode !== "edge" || e.buttons) return;
    const p = this.pickEdge(e);
    this.renderer.domElement.style.cursor = p ? "pointer" : "";
    if (!p) return;
    const seg = this.nearestEdge(p, 1e-3 + this.gridSize / 2000);
    if (!seg) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(seg, 3));
    this.hoverLine = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(css("--hover")) }));
    this.scene.add(this.hoverLine);
  }

  private modelSize() {
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
    return box.isEmpty() ? 50 : box.getSize(new THREE.Vector3()).length();
  }

  fit() {
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 30));
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, size * 1.6 + 10);
    const want = Math.max(200, Math.ceil((size * 3) / 100) * 100);
    if (want !== this.gridSize) this.buildGrid(want);
  }

  view(name: "iso" | "top" | "front" | "right") {
    const dirs: Record<string, Vec3> = { iso: [1, -1.3, 0.9], top: [0, -0.0001, 1], front: [0, -1, 0], right: [1, 0, 0] };
    const d = new THREE.Vector3(...dirs[name]).normalize();
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(d, dist);
    this.fit();
  }

  refit() { this.needsFit = true; }
}
