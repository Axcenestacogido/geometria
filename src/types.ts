// Tipos del documento. Todos los números que escribe el usuario se guardan
// como texto ("expresión") para poder usar variables: "ancho / 2 + 3".

/** Texto con una medida (puede llevar variables). La "marca" sirve solo para los tipos. */
export type Expr = string & { readonly __expr?: true };
export type Vec3 = [number, number, number];

export type StdPlane = "XY" | "XZ" | "YZ";

/** tilt = inclinación alrededor del eje X del plano; turn = giro alrededor de su normal (grados) */
export type PlaneDef =
  | { kind: "std"; name: StdPlane; offset: Expr; tilt?: Expr; turn?: Expr }
  | { kind: "face"; origin: Vec3; normal: Vec3; xDir: Vec3; offset: Expr; tilt?: Expr; turn?: Expr }
  /** sobre un plano de referencia tuyo (paso «Plano»), por su id */
  | { kind: "ref"; ref: string; offset: Expr; tilt?: Expr; turn?: Expr };

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
      /** true = curva suave (spline) que pasa por todos los puntos, en vez de tramos rectos o arcos */
      smooth?: boolean;
    });

export type BoolOp = "new" | "add" | "cut" | "intersect";

interface FeatureBase {
  id: string;
  name: string;
  /** Paso apagado: se salta al reconstruir */
  off?: boolean;
  /** Carpeta de la lista de pasos (solo para ordenar la lista: no cambia la pieza) */
  group?: string;
}

/** Un tramo de una polilínea: perfil `p`, tramo que sale del punto `i` */
export interface SegRef { p: string; i: number }

/** Restricciones entre tramos de polilíneas. Se cumplen moviendo los puntos que son números sueltos. */
export type SketchConstraint =
  | { id: string; kind: "h" | "v"; s: SegRef }
  | { id: string; kind: "equal" | "parallel" | "perp"; s: SegRef; t: SegRef };

/** Imagen de referencia de fondo en un boceto (se guarda aparte, como los archivos importados) */
export interface RefImage {
  file: string;
  /** esquina de abajo a la izquierda y ancho, en mm del boceto; el alto sale de la proporción */
  x: number; y: number; w: number;
  /** proporción alto/ancho de la imagen */
  aspect: number;
  opacity: number;
  /** también se ve en la vista 3D */
  show3d?: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: PlaneDef;
  profiles: Profile[];
  constraints?: SketchConstraint[];
  image?: RefImage;
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

/** Empujar o tirar de una cara plana: la pieza crece (o se hunde) esa distancia */
export interface PushPullFeature extends FeatureBase {
  type: "pushpull";
  /** un punto sobre la cara (null = aún sin elegir) */
  face: Vec3 | null;
  /** hacia fuera de la pieza en ese punto */
  normal: Vec3;
  /** mm: positivo = crece, negativo = se hunde */
  distance: Expr;
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
  /** seguir la curva de una cara cilíndrica (letra a letra alrededor del cilindro) */
  wrap?: boolean;
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

/** Relieve desde una imagen: un logo extruido (o grabado) o una litofanía / mapa de alturas */
export interface ReliefFeature extends SolidOpBase {
  type: "relief";
  /** id de la imagen guardada en este navegador */
  file: string;
  fileName: string;
  /** alto / ancho de la imagen */
  aspect: number;
  /** logo = contornos de lo oscuro, extruidos; relief = alturas según lo oscuro */
  mode: "logo" | "relief";
  /** ancho de la imagen entera en mm */
  width: Expr;
  /** logo: alto de la extrusión · relieve: diferencia entre lo más claro y lo más oscuro */
  height: Expr;
  /** relieve: grosor de la placa por debajo */
  base: Expr;
  /** logo: % de oscuridad a partir del cual cuenta como logo */
  threshold: Expr;
  /** puntos en el lado largo de la imagen (más = más detalle y más lento) */
  detail: Expr;
  invert: boolean;
  x: Expr; y: Expr; z: Expr;
}

/** Plano de referencia: un plano con nombre para dibujar bocetos encima (no crea volumen) */
export interface RefPlaneFeature extends FeatureBase {
  type: "plane";
  plane: PlaneDef;
  /** lado del cuadrado que lo dibuja en 3D (mm) */
  size: Expr;
}

/** Apoyar la pieza sobre una cara para imprimir (gira todos los cuerpos y los baja a Z = 0) */
export interface LayFlatFeature extends FeatureBase {
  type: "layflat";
  /** un punto sobre la cara que va abajo; vacío = la cara plana más grande */
  face: Vec3 | null;
}

/** Mueve, gira o escala un cuerpo que ya existe (o una copia suya) */
export interface TransformFeature extends FeatureBase {
  type: "transform";
  /** cuerpo a mover; vacío = el último */
  body: string;
  dx: Expr; dy: Expr; dz: Expr;
  rx: Expr; ry: Expr; rz: Expr;
  scale: Expr;
  /** true = deja el original y crea un cuerpo nuevo movido */
  copy: boolean;
}

/**
 * Unión de un ensamblaje: mueve uno o varios cuerpos como lo haría una bisagra (girar
 * alrededor de un eje) o una guía (deslizar a lo largo de él). «value» es la posición
 * actual; min y max, hasta dónde llega.
 */
export interface JointFeature extends FeatureBase {
  type: "joint";
  kind: "hinge" | "slide";
  bodies: string[];
  axis: "x" | "-x" | "y" | "-y" | "z" | "-z";
  /** un punto del eje (para la bisagra) */
  x: Expr; y: Expr; z: Expr;
  value: Expr; min: Expr; max: Expr;
}

/** Pieza comprada de catálogo (rodamiento, imán, inserto…), o el hueco para meterla */
export interface CatalogFeature extends SolidOpBase {
  type: "catalog";
  part: string;
  x: Expr; y: Expr; z: Expr;
  /** giro sobre X (180 = boca abajo) y sobre Z */
  rx: Expr; rz: Expr;
  /** solo perfiles: largo */
  length: Expr;
  /** holgura del hueco (diámetro) */
  fit: Expr;
}

/** Parte un cuerpo en dos por un plano, con espigas para unir las partes */
export interface SplitFeature extends FeatureBase {
  type: "split";
  body: string;
  axis: "x" | "y" | "z";
  /** coordenada del corte (mm) */
  at: Expr;
  pins: "none" | "loose" | "fixed";
  pinD: Expr; pinL: Expr; count: Expr; fit: Expr;
  /** separación entre las partes para verlas (mm) */
  gap: Expr;
}

/** Suma, resta o interseca cuerpos que ya existen */
export interface CombineFeature extends FeatureBase {
  type: "combine";
  op: "add" | "cut" | "intersect";
  /** el que se queda con el resultado */
  target: string;
  /** los que se suman/restan a él */
  tools: string[];
  /** false = las herramientas desaparecen al combinarlas */
  keep: boolean;
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
  | TransformFeature
  | JointFeature
  | CatalogFeature
  | SplitFeature
  | CombineFeature
  | EdgeFeature
  | ShellFeature
  | PushPullFeature
  | PatternFeature
  | HoleFeature
  | RodFeature
  | TextFeature
  | SweepFeature
  | LoftFeature
  | ImportFeature
  | ReliefFeature
  | RefPlaneFeature
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
  files?: Record<string, { name: string; format: "step" | "stl" | "image"; data: string }>;
  /** Cotas que añades tú en el plano 2D */
  dims?: DrawingDim[];
  /** Ficha BIM de cada cuerpo (id del cuerpo → material, cantidad…) */
  bim?: Record<string, BodyInfo>;
  /** Familia: la misma pieza en varios tamaños */
  family?: Family;
  /** carpetas de la lista de pasos que están plegadas */
  folded?: string[];
  /** Etiqueta de versión: la última vez que se exportó para imprimir (número y fecha «25-nov») */
  label?: { n: number; date: string };
}

/** Tabla de tamaños: qué variables cambian y sus valores en cada fila */
export interface Family {
  vars: string[];
  rows: { name: string; values: Record<string, Expr> }[];
}

/** Ficha de una pieza para el listado: material, si se imprime o se compra, cantidad… */
export interface BodyInfo {
  material?: string;
  kind?: "print" | "make" | "buy";
  qty?: number;
  ref?: string;
  notes?: string;
  /** precio por unidad (€), para las que se compran */
  price?: number;
}

/**
 * Una cota del plano, en milímetros de la vista (Y hacia abajo, como el SVG).
 * h/v/a: de a a b (horizontal, vertical o alineada), con la línea separada «off» mm.
 * d/r: diámetro o radio del círculo de centro c y radio r; la etiqueta va hacia el punto a.
 */
export interface DrawingDim {
  id: string;
  view: "front" | "top" | "right";
  kind: "h" | "v" | "a" | "d" | "r";
  a: [number, number];
  b: [number, number];
  off: number;
  c?: [number, number];
  r?: number;
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
  /** imagen ya pasada a grises (0 = negro, 255 = blanco), para los relieves */
  | { kind: "gray"; id: string; w: number; h: number; data: Uint8Array }
  | { kind: "export"; seq: number; features: Resolved<Feature>[]; format: "stl" | "step" | "3mf"; colors?: Record<string, string> }
  | { kind: "drawing"; seq: number; features: Resolved<Feature>[] }
  | { kind: "collide"; seq: number; features: Resolved<Feature>[]; mesh: boolean };

export type WorkerOut =
  | { kind: "ready" }
  | { kind: "fatal"; message: string }
  | ({ kind: "built" } & BuildResult)
  | { kind: "exported"; seq: number; format: string; data: ArrayBuffer | null; error?: string }
  | { kind: "file"; id: string; error?: string; triangles?: number }
  | { kind: "drawing"; seq: number; views?: DrawingView[]; error?: string }
  | { kind: "collide"; seq: number; clashes: Clash[]; error?: string };

/** Dos cuerpos que se meten uno en otro */
export interface Clash {
  a: string; b: string; nameA: string; nameB: string;
  /** volumen que comparten (mm³) */
  volume: number;
  /** triángulos de la zona en común, para pintarla en rojo */
  tris?: Float32Array;
}

/** Una vista de un plano 2D: trazos visibles y ocultos (SVG, en mm, Y hacia abajo) */
export interface DrawingView {
  name: "front" | "top" | "right" | "iso";
  visible: string[];
  hidden: string[];
  /** caja de la vista: [xmin, ymin, xmax, ymax] */
  box: [number, number, number, number];
}
