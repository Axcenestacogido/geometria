// Engranaje recto de evolvente: el contorno 2D (en mm), centrado en el origen.
// Módulo m: tamaño del diente (dos ruedas engranan si tienen el mismo módulo).
// Ángulo de presión 20°, el estándar.

export interface GearParams {
  /** módulo (mm) */
  m: number;
  /** número de dientes */
  z: number;
  /** holgura total entre dientes de la pareja (mm); cada rueda pone la mitad */
  fit: number;
}

export const gearPitchDiameter = (m: number, z: number) => m * z;

/** Contorno cerrado (sin repetir el primer punto). Diente 0 apuntando a +X. */
export function gearOutline({ m, z, fit }: GearParams): [number, number][] {
  if (!(m > 0)) throw new Error("el módulo debe ser mayor que 0");
  if (!Number.isInteger(z) || z < 6 || z > 300) throw new Error("los dientes tienen que ser un número entero entre 6 y 300");
  const alpha = (20 * Math.PI) / 180;
  const rp = (m * z) / 2, rb = rp * Math.cos(alpha), ra = rp + m, rf = rp - 1.25 * m;
  const inv = (a: number) => Math.tan(a) - a;
  // media anchura angular del diente a un radio r (a lo largo de la evolvente)
  const half0 = Math.PI / (2 * z) + inv(alpha) - Math.max(0, fit) / 4 / rp;
  const half = (r: number) => half0 - inv(Math.acos(Math.min(1, rb / r)));
  if (half(ra) <= 0) throw new Error("con tanta holgura los dientes se quedan sin punta");
  const r0 = Math.max(rb, rf);
  const N = 8;
  const flank: number[] = [];
  for (let i = 0; i <= N; i++) flank.push(r0 + ((ra - r0) * i) / N);
  const pts: [number, number][] = [];
  const at = (r: number, a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];
  const step = (2 * Math.PI) / z;
  for (let k = 0; k < z; k++) {
    const c = k * step;
    // pie del diente (si la circunferencia base queda por encima del fondo, tramo recto)
    if (rf < rb) pts.push(at(rf, c - half(rb)));
    for (const r of flank) pts.push(at(r, c - half(r)));
    for (const r of [...flank].reverse()) pts.push(at(r, c + half(r)));
    if (rf < rb) pts.push(at(rf, c + half(rb)));
    // fondo entre este diente y el siguiente
    const a0 = c + half(r0), a1 = c + step - half(r0);
    for (let j = 1; j < 4; j++) pts.push(at(rf, a0 + ((a1 - a0) * j) / 4));
  }
  return pts;
}
