// Tipos del documento. Todos los números que escribe el usuario se guardan
// como texto ("expresión") para poder usar variables: "ancho / 2 + 3".

/** Texto con una medida (puede llevar variables). La "marca" sirve solo para los tipos. */
export type Expr = string & { readonly __expr?: true };
export type Vec3 = [number, number, number];

export type StdPlane = "XY" | "XZ" | "YZ";

export type PlaneDef =
  | { kind: "std"; name: StdPlane; offset: Expr }
  | { kind: "face"; origin: Vec3; normal: Vec3; xDir: Vec3; offset: Expr };

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
  | (ProfileBase & { kind: "poly"; pts: PolyPoint[] });

export type BoolOp = "new" | "add" | "cut" | "intersect";

interface FeatureBase {
  id: string;
  name: string;
  /** Paso apagado: se salta al reconstruir */
  off?: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: PlaneDef;
  profiles: Profile[];
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
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | BoxFeature
  | CylinderFeature
  | SphereFeature
  | EdgeFeature;

export interface Variable {
  name: string;
  value: Expr;
}

export interface Doc {
  version: 1;
  name: string;
  variables: Variable[];
  features: Feature[];
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
  | { kind: "export"; seq: number; features: Resolved<Feature>[]; format: "stl" | "step" | "3mf" };

export type WorkerOut =
  | { kind: "ready" }
  | { kind: "fatal"; message: string }
  | ({ kind: "built" } & BuildResult)
  | { kind: "exported"; seq: number; format: string; data: ArrayBuffer | null; error?: string };
