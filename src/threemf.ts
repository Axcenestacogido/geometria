// 3MF = un zip con un XML dentro. Es el formato que mejor entienden
// Bambu Studio, PrusaSlicer y Orca (guarda unidades y varias piezas).
import { zipSync, strToU8 } from "fflate";

export interface MeshObj { name: string; vertices: number[] | Float32Array; triangles: number[] | Uint32Array; color?: string }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const n = (v: number) => (Math.round(v * 1e5) / 1e5).toString();

export function buildModel3mf(objs: MeshObj[]): ArrayBuffer {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="es" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n');
  // colores (estándar 3MF: un material base por cuerpo con su color)
  const colored = objs.some((o) => o.color);
  const MAT = objs.length + 1;
  if (colored) {
    parts.push(`<basematerials id="${MAT}">\n`);
    objs.forEach((o, i) => parts.push(`<base name="${esc(o.name)}" displaycolor="${/^#[0-9a-f]{6}$/i.test(o.color ?? "") ? o.color!.toUpperCase() : "#9AA7B8"}FF"/>\n`));
    parts.push("</basematerials>\n");
  }
  objs.forEach((o, i) => {
    parts.push(`<object id="${i + 1}" name="${esc(o.name)}" type="model"${colored ? ` pid="${MAT}" pindex="${i}"` : ""}><mesh><vertices>\n`);
    const v = o.vertices;
    for (let k = 0; k < v.length; k += 3) parts.push(`<vertex x="${n(v[k])}" y="${n(v[k + 1])}" z="${n(v[k + 2])}"/>\n`);
    parts.push("</vertices><triangles>\n");
    const t = o.triangles;
    for (let k = 0; k < t.length; k += 3) parts.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>\n`);
    parts.push("</triangles></mesh></object>\n");
  });
  parts.push("</resources>\n<build>\n");
  objs.forEach((_, i) => parts.push(`<item objectid="${i + 1}"/>\n`));
  parts.push("</build>\n</model>\n");

  const files = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    "3D/3dmodel.model": strToU8(parts.join("")),
  };
  const zipped = zipSync(files, { level: 6 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}
