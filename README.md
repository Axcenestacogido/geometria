# Geometría

CAD 3D paramétrico que funciona en el navegador, para diseñar piezas y mandarlas a la
impresora 3D. Dibujas un boceto con medidas, lo conviertes en sólido y cada paso queda
guardado en una lista: si cambias una medida, toda la pieza se recalcula.

Todo se calcula **en tu navegador**. El servidor solo entrega la página: no hay base de datos
ni subidas. Las piezas se guardan en el navegador del equipo donde trabajas (y puedes
descargarlas como `.json` para pasarlas a otro).

## Qué hace (v1)

| Paso | Qué hace |
|---|---|
| **Boceto** | Dibujo 2D sobre el suelo (XY), el frente (XZ), el lado (YZ) o una cara plana de la pieza. Líneas, rectángulos (con esquinas redondeadas), círculos y polígonos regulares. Cualquier tramo de una polilínea se puede curvar. Los perfiles que quedan dentro de otro se vuelven agujeros. |
| **Extruir** | Da grosor al boceto. Hacia un lado, al contrario o simétrico. |
| **Revolución** | Gira el boceto alrededor de su eje X o Y (jarrones, pomos, arandelas…). |
| **Caja, Cilindro, Esfera** | Formas básicas con medidas y posición. |
| **Sumar / Restar / Intersecar** | Cada sólido puede crear un cuerpo nuevo o combinarse con uno existente. Al restar desde una cara, va hacia dentro de la pieza. |
| **Redondeo y Chaflán** | Eliges las aristas con un clic en la vista 3D. |
| **Variables** | `grosor = 3` y luego escribes `grosor * 2` en cualquier medida. Admite `+ - * / ^ ( )`, `sqrt`, `sin`, `cos`, `tan` (en grados), `abs`, `round` y `pi`. |
| **Exportar** | **3MF** (Bambu Studio, Orca, Prusa; guarda unidades y piezas separadas), **STL** y **STEP** (Rhino, Fusion, FreeCAD). |

Además: deshacer/rehacer (`Ctrl+Z` / `Ctrl+Y`), apagar un paso sin borrarlo, reordenar pasos,
varias piezas guardadas, tema claro y oscuro.

### Atajos en el boceto

| Tecla | Herramienta |
|---|---|
| `S` | Elegir y mover |
| `L` | Líneas (clic en el primer punto o `Intro` para cerrar) |
| `R` | Rectángulo |
| `C` | Círculo |
| `P` | Polígono |
| `Supr` | Borrar el perfil elegido |
| `Esc` | Cancelar / salir |
| Doble clic en una cota | Escribir la medida exacta |
| `Mayús` mientras dibujas | No ajustar a la rejilla |

En los campos de medida, las flechas ↑ ↓ suman o restan 1 (con `Mayús`, 10).

## Cómo está hecho

- **Motor geométrico:** [OpenCascade](https://dev.opencascade.org/) (el núcleo de FreeCAD)
  compilado a WebAssembly, a través de [replicad](https://replicad.xyz) (MIT). Corre en un
  *worker* aparte para que la pantalla no se congele mientras calcula.
- **Vista 3D:** [three.js](https://threejs.org). Z hacia arriba, como en Rhino y en los
  programas de impresión.
- **Código:** TypeScript + Vite, sin framework.

| Fichero | Para qué |
|---|---|
| `src/types.ts` | Cómo es un documento: pasos, perfiles, variables |
| `src/state.ts` | Documento nuevo, ejemplo, deshacer, guardado en el navegador |
| `src/expr.ts` | La calculadora de medidas (sin `eval`) |
| `src/cad.worker.ts` | El motor: reconstruye la pieza paso a paso y exporta |
| `src/sketcher.ts` | El editor de bocetos 2D |
| `src/viewport.ts` | La vista 3D y la selección de aristas y caras |
| `src/threemf.ts` | Escritor de 3MF |
| `src/main.ts` | La pantalla y cómo encaja todo |

## Trabajar en local

```bash
npm install
npm run dev      # http://localhost:4380
npm test         # pruebas de la calculadora
npm run build    # comprobación de tipos + compilación a dist/
```

## Servidor 24/7 (solo por la VPN)

Igual que BeatReel: Caddy sirve la página en `https://10.8.0.20:4380` con el certificado de
la CA de casa. Contenedor de solo lectura, usuario 1000, sin capacidades extra, 128 MB.

### Instalar (una sola vez)

```bash
git clone https://github.com/Axcenestacogido/geometria /srv/apps/geometria
cd /srv/apps/geometria
sh deploy/instalar.sh                  # copia el certificado de 10.8.0.20
docker compose up -d --build           # la primera vez tarda un par de minutos (compila)
docker compose ps                      # tiene que decir (healthy)
sudo ufw allow from 10.8.0.0/24 to any port 4380 proto tcp comment 'Geometria (VPN)'
```

En Uptime Kuma: monitor HTTP(s) `Geometría · por VPN (servidor)`, URL
`https://10.8.0.20:4380/`, con «Ignorar errores TLS/SSL» marcado.

### Actualizar

```bash
cd /srv/apps/geometria && git pull --ff-only && docker compose up -d --build
```

### Seguridad

- CSP estricta en la página: solo scripts propios y WebAssembly, nada de código en línea,
  `connect-src 'self'` (la página no puede hablar con ningún otro sitio).
- El motor (`cad.worker`) tiene además `'unsafe-eval'`, porque OpenCascade crea funciones al
  arrancar. Ese permiso va solo en la respuesta del *worker*, no en la página.
- Sin estado en el servidor: no hay nada que copiar por la noche.
