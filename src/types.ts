// Tipos del documento. Todos los números que escribe el usuario se guardan
// como texto ("expresión") para poder usar variables: "ancho / 2 + 3".

/** Texto con una medida (puede llevar variables). La "marca" sirve solo para los tipos. */
export type Expr = string & { readonly __expr?: true };
export type Vec3 = [number, number, number];

export type StdPlane = "XY" | "XZ" | "YZ";

/** tilt = inclinación alrededor del eje X del plano; turn = giro alrededor de su normal (grados) */
export type PlaneDef =
  | { kind: "std"; name: StdPlane; offset: Expr; tilt?: Expr; turn?: Expr }
  | { kind: "face"; origin: Vec3; normal: Vec3; xDir: Vec3; offset: Expr; tilt?: Expr; turn?: Expr };

export interface PolyPoint {
  x: Expr;
  y: Expr;
  /** Curvatura (flecha) del tramo que sale de este punto. 0 = recto. */
  s?: Expr;
}

interface ProfileBase {
  id: string;
  /** true = agujero: se resta del resto de perfiles del boceto */
  hole: boolean;
}

export type Profile =
  | (ProfileBase & { kind: "rect"; x: Expr; y: Expr; w: Expr; h: Expr; r: Expr })
  | (ProfileBase & { kind: "circle"; cx: Expr; cy: Expr; r: Expr })
  | (ProfileBase & { kind: "ngon"; cx: Expr; cy: Expr; r: Expr; n: Expr })
  | (ProfileBase & {
      kind: "poly";
      pts: PolyPoint[];
      /** true = línea abierta (no encierra nada): sirve de camino para un barrido */
      open?: boolean;
    });

export type BoolOp = "new" | "add" | "cut" | "intersect";

interface FeatureBase {
  id: string;
  name: string;
  /** Paso apagado: se salta al reconstruir */
  off?: boolean;
}

/** Un tramo de una polilínea: perfil `p`, tramo que sale del punto `i` */
export interface SegRef { p: string; i: number }

/** Restricciones entre tramos de polilíneas. Se cumplen moviendo los puntos que son números sueltos. */
export type SketchConstraint =
  | { id: string; kind: "h" | "v"; s: SegRef }
  | { id: string; kind: "equal" | "parallel" | "perp"; s: SegRef; t: SegRef };

export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: PlaneDef;
  profiles: Profile[];
  constraints?: SketchConstraint[];
}

interface SolidOpBase extends FeatureBase {
  op: BoolOp;
  /** Cuerpo sobre el que suma/resta. Vacío = el último cuerpo. */
  target?: string;
}

export interface ExtrudeFeature extends SolidOpBase {
  type: "extrude";
  sketch: string;
  distance: Expr;
  symmetric: boolean;
  reverse: boolean;
}

export interface RevolveFeature extends SolidOpBase {
  type: "revolve";
  sketch: string;
  axis: "x" | "y";
  angle: Expr;
}

export interface BoxFeature extends SolidOpBase {
  type: "box";
  x: Expr; y: Expr; z: Expr;
  w: Expr; d: Expr; h: Expr;
}

/** Engranaje recto (evolvente, 20°) */
export interface GearFeature extends SolidOpBase {
  type: "gear";
  /** centro de la cara de abajo */
  x: Expr; y: Expr; z: Expr;
  module: Expr;
  teeth: Expr;
  thickness: Expr;
  /** agujero del eje (0 = sin agujero) */
  bore: Expr;
  fit: Expr;
  /** giro alrededor de Z (°), para que dos ruedas encajen */
  angle: Expr;
}

/** Muelle helicoidal (de compresión) */
export interface SpringFeature extends SolidOpBase {
  type: "spring";
  x: Expr; y: Expr; z: Expr;
  /** diámetro exterior */
  diameter: Expr;
  /** grosor del hilo */
  wire: Expr;
  /** distancia entre vueltas */
  pitch: Expr;
  turns: Expr;
  /** puntas planas para que apoye bien */
  flat: boolean;
}

export interface CylinderFeature extends SolidOpBase {
  type: "cylinder";
  x: Expr; y: Expr; z: Expr;
  r: Expr; h: Expr;
}

export interface SphereFeature extends SolidOpBase {
  type: "sphere";
  x: Expr; y: Expr; z: Expr;
  r: Expr;
}

export interface EdgeFeature extends FeatureBase {
  type: "fillet" | "chamfer";
  size: Expr;
  /** Un punto sobre cada arista elegida (así sobrevive a cambios de medida) */
  edges: Vec3[];
  /** Medida propia de cada arista (mismo orden que `edges`); vacío = la general */
  sizes?: Expr[];
  /** Un punto sobre cada cara elegida: se redondean todas sus aristas */
  faces?: Vec3[];
}

/** Vaciado: deja paredes de `thickness` y quita las caras elegidas */
export interface ShellFeature extends FeatureBase {
  type: "shell";
  thickness: Expr;
  /** Un punto sobre cada cara que queda abierta */
  faces: Vec3[];
}

export type PatternKind = "linear" | "circular" | "mirror" | "path";
export type Axis = "x" | "y" | "z";

/** Repetir o reflejar un paso (o el cuerpo entero) */
export interface PatternFeature extends FeatureBase {
  type: "pattern";
  kind: PatternKind;
  /** id del paso a repetir; "" = el último cuerpo entero */
  source: string;
  // en fila
  axis: Axis;
  count: Expr;
  spacing: Expr;
  /** segunda dirección (rejilla). count2 = 1 la desactiva */
  axis2: Axis;
  count2: Expr;
  spacing2: Expr;
  // en círculo (alrededor de un eje paralelo a `axis` que pasa por cx, cy, cz)
  cx: Expr; cy: Expr; cz: Expr;
  angle: Expr;
  // simetría: plano perpendicular a `axis` que pasa por `offset`
  offset: Expr;
  // a lo largo de un camino: boceto con el camino y si las copias giran con él
  path?: string;
  align?: boolean;
}

/** Punto sobre una cara, con su normal hacia fuera */
export interface FacePoint { x: Expr; y: Expr; z: Expr; n: Vec3 }

export type HoleKind = "clearance" | "countersink" | "counterbore" | "insert" | "pilot" | "nut" | "thread";

/** Agujeros para tornillo, colocados con un clic sobre una cara */
export interface HoleFeature extends FeatureBase {
  type: "hole";
  kind: HoleKind;
  /** "M3", "M4"… */
  size: string;
  depth: Expr;
  through: boolean;
  /** holgura extra para la impresora (mm, se suma al diámetro) */
  fit: Expr;
  points: FacePoint[];
  target?: string;
}

/** Varilla roscada que sale de una cara */
export interface RodFeature extends FeatureBase {
  type: "rod";
  size: string;
  length: Expr;
  fit: Expr;
  points: FacePoint[];
  target?: string;
}

export type TextFont = "sans" | "sans-bold" | "mono";

/** Texto en 3D: en relieve (sumar) o grabado (restar) sobre una cara */
export interface TextFeature extends SolidOpBase {
  type: "text";
  text: string;
  font: TextFont;
  /** alto de las letras (mm) */
  size: Expr;
  depth: Expr;
  /** giro del texto sobre la cara (grados) */
  angle: Expr;
  /** dónde va el centro del texto (clic en una cara). Vacío = en el suelo, en el origen */
  points: FacePoint[];
}

/** Barrido: un perfil que recorre un camino */
export interface SweepFeature extends SolidOpBase {
  type: "sweep";
  /** boceto con la forma (se coloca al principio del camino, centrada en su origen) */
  sketch: string;
  /** boceto con el camino (una línea abierta o un contorno cerrado) */
  path: string;
}

/** Transición (loft) entre varios bocetos */
export interface LoftFeature extends SolidOpBase {
  type: "loft";
  sketches: string[];
  /** true = caras rectas entre bocetos; false = transición suave */
  ruled: boolean;
}

/** Pieza traída de otro programa (STEP o STL) */
export interface ImportFeature extends SolidOpBase {
  type: "import";
  /** id del archivo guardado en este navegador */
  file: string;
  fileName: string;
  format: "step" | "stl";
  x: Expr; y: Expr; z: Expr;
  scale: Expr;
}

/** Apoyar la pieza sobre una cara para imprimir (gira todos los cuerpos y los baja a Z = 0) */
export interface LayFlatFeature extends FeatureBase {
  type: "layflat";
  /** un punto sobre la cara que va abajo; vacío = la cara plana más grande */
  face: Vec3 | null;
}

/** Una pieza guardada metida dentro de esta (copia), con sus variables cambiables */
export interface ComponentFeature extends SolidOpBase {
  type: "component";
  /** de qué pieza guardada salió (para «actualizar») */
  sourceId: string;
  source: { name: string; variables: Variable[]; features: unknown[] };
  /** valor nuevo para algunas variables de la pieza (vacío = el suyo) */
  params: Record<string, Expr>;
  x: Expr; y: Expr; z: Expr;
  /** giro alrededor de Z (grados) */
  rz: Expr;
  /** lo rellena resolveDoc: los pasos de la pieza ya con números */
  resolved?: unknown[];
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | BoxFeature
  | CylinderFeature
  | SphereFeature
  | GearFeature
  | SpringFeature
  | EdgeFeature
  | ShellFeature
  | PatternFeature
  | HoleFeature
  | RodFeature
  | TextFeature
  | SweepFeature
  | LoftFeature
  | ImportFeature
  | LayFlatFeature
  | ComponentFeature;

export interface Variable {
  name: string;
  value: Expr;
}

export interface Doc {
  version: 1;
  name: string;
  variables: Variable[];
  features: Feature[];
  /** Color de cada cuerpo (id del cuerpo → "#rrggbb") */
  colors?: Record<string, string>;
  /** Solo en el .json descargado: archivos importados (base64), para llevarlos a otro equipo */
  files?: Record<string, { name: string; format: "step" | "stl"; data: string }>;
}

// ---------- Mensajes con el trabajador (motor geométrico) ----------

/** Lo que recibe el motor: igual que el documento pero con números ya calculados */
export type Resolved<T> = T extends string
  ? T extends { readonly __expr?: true } ? (string extends T ? (T extends Expr ? number : T) : T) : T
  : T extends (infer U)[]
    ? Resolved<U>[]
    : T extends object
      ? { [K in keyof T]: Resolved<T[K]> }
      : T;

export interface BodyMesh {
  id: string;
  name: string;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  lines: Float32Array;
  /** inicio/cantidad (en floats de `lines`) de cada arista */
  edgeGroups: { start: number; count: number }[];
  /** inicio/cantidad (en índices de `triangles`) de cada cara */
  faceGroups: { start: number; count: number }[];
  volume: number;
  area: number;
}

export interface BuildResult {
  seq: number;
  bodies: BodyMesh[];
  /** error por id de paso */
  errors: Record<string, string>;
  /** cuerpos que existen ANTES de cada paso (para elegir objetivo) */
  bodiesBefore: Record<string, { id: string; name: string }[]>;
  ms: number;
}

export type WorkerIn =
  | { kind: "build"; seq: number; features: Resolved<Feature>[]; upTo?: string }
  | { kind: "file"; id: string; format: "step" | "stl"; data: ArrayBuffer }
  | { kind: "export"; seq: number; features: Resolved<Feature>[]; format: "stl" | "step" | "3mf"; colors?: Record<string, string> }
  | { kind: "drawing"; seq: number; features: Resolved<Feature>[] };

export type WorkerOut =
  | { kind: "ready" }
  | { kind: "fatal"; message: string }
  | ({ kind: "built" } & BuildResult)
  | { kind: "exported"; seq: number; format: string; data: ArrayBuffer | null; error?: string }
  | { kind: "file"; id: string; error?: string; triangles?: number }
  | { kind: "drawing"; seq: number; views?: DrawingView[]; error?: string };

/** Una vista de un plano 2D: trazos visibles y ocultos (SVG, en mm, Y hacia abajo) */
export interface DrawingView {
  name: "front" | "top" | "right" | "iso";
  visible: string[];
  hidden: string[];
  /** caja de la vista: [xmin, ymin, xmax, ymax] */
  box: [number, number, number, number];
}
