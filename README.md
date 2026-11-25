# Geometría

CAD 3D paramétrico que funciona en el navegador, para diseñar piezas y mandarlas a la
impresora 3D. Dibujas un boceto con medidas, lo conviertes en sólido y cada paso queda
guardado en una lista: si cambias una medida, toda la pieza se recalcula.

Todo se calcula **en tu navegador**. El servidor solo entrega la página: no hay base de datos
ni subidas. Las piezas se guardan en el navegador del equipo donde trabajas (y puedes
descargarlas como `.json` para pasarlas a otro).

## Qué hace

| Paso | Qué hace |
|---|---|
| **Boceto** | Dibujo 2D sobre el suelo (XY), el frente (XZ), el lado (YZ) o una cara plana de la pieza. Líneas, rectángulos (con esquinas redondeadas), círculos y polígonos regulares. Cualquier tramo de una polilínea se puede curvar. Los perfiles que quedan dentro de otro se vuelven agujeros. |
| **Extruir** | Da grosor al boceto. Hacia un lado, al contrario o simétrico. |
| **Revolución** | Gira el boceto alrededor de su eje X o Y (jarrones, pomos, arandelas…). |
| **Caja, Cilindro, Esfera** | Formas básicas con medidas y posición. |
| **Engranaje** | Rueda dentada recta de evolvente (20°): dientes, módulo, grosor, agujero del eje y holgura. Te dice a qué distancia poner otra rueda para que engrane. |
| **Muelle** | Muelle de compresión: diámetro, hilo, paso y vueltas, con puntas planas para que apoye. |
| **Sumar / Restar / Intersecar** | Cada sólido puede crear un cuerpo nuevo o combinarse con uno existente. Al restar desde una cara, va hacia dentro de la pieza. |
| **Redondeo y Chaflán** | Eliges las aristas con un clic en la vista 3D. |
| **Vaciado** | Convierte el sólido en una carcasa; eliges con un clic las caras que quedan abiertas. |
| **Patrón** | Repite un paso en fila, rejilla, círculo o a lo largo de un camino (girando con él si quieres), o lo refleja (simetría). |
| **Agujeros** | Tornillería métrica M2–M20: de paso, avellanado, con caja, para inserto térmico, directo al plástico, hueco para tuerca y rosca hembra. Con holgura para la impresora. |
| **Varilla roscada** | Rosca macho que sale de una cara. |
| **Barrido** | Un perfil que recorre un camino (tubos, asas, aros). El camino se dibuja con la herramienta *Camino*. |
| **Transición** | Pasa suavemente de la forma de un boceto a la de otro (de cuadrado a círculo…). |
| **Texto** | Letras en relieve o grabadas sobre una cara (tipografías libres Inter y JetBrains Mono). |
| **Importar** | Trae una pieza STEP o STL de otro programa para sumarla, restarla o modificarla. Los archivos se guardan en el navegador y van dentro del proyecto `.json` al descargarlo. |
| **Importar SVG** | Dentro de un boceto: trae un dibujo (logo, silueta…) de Inkscape, Illustrator o Figma, escalado al ancho que digas. |
| **Restricciones** | En el boceto, elige un tramo (o dos con `Mayús`+clic) y ponle Horizontal, Vertical, Igual largo, Paralelas o Perpendiculares. Se mantienen al mover puntos. |
| **Planos inclinados** | Cada boceto tiene «Desfase», «Inclinación» y «Giro»: dibuja a cualquier altura y con cualquier ángulo. |
| **Redondeo/Chaflán por caras** | Elige caras enteras (todas sus aristas a la vez) o aristas sueltas, cada una con su propia medida si quieres. |
| **Apoyar** | Gira la pieza para que la cara elegida (o la plana más grande) quede sobre la cama. |
| **Comprobar para imprimir** | En «Tu pieza»: si cabe en la cama, voladizos de más de 45° (en rojo) y paredes finas (en morado). La cama y los límites se ajustan. |
| **Plantillas** | Caja con tapa a presión, bisagra imprimible ya montada, pareja de engranajes, muelle, clip para tubo y tornillo con tuerca M10, todas con variables y holguras. |
| **Pieza** | Mete dentro una de tus piezas guardadas (copia), cambiando sus variables, posición y giro. |
| **Corte** | Corta la vista con un plano X, Y o Z que mueves con una barra, para ver el interior. Solo cambia la vista, no la pieza. |
| **Plano** | Hoja A4 con las vistas de frente, arriba, derecha y 3D, aristas ocultas en discontinua, medidas generales, escala y cajetín. Se imprime o se guarda como PDF desde el navegador, o se descarga en SVG. |
| **Colores** | En «Tu pieza», un color para cada cuerpo. Se ve en la vista y se guarda en el 3MF (cada cuerpo, un objeto con su color) para asignar filamentos del AMS. |
| **Móvil** | La vista 3D ocupa toda la pantalla, con botones flotantes a los lados (medir, corte, plano, vistas) y un dock abajo (Añadir, Pasos, Editar, Variables) que abre paneles desde abajo. En el boceto, la barra de herramientas va abajo y se usa con dos dedos para zoom y mover. |
| **Medir** | Distancia entre vértices, aristas o caras, con X, Y, Z por separado. |
| **Tu pieza** | Tamaño, volumen, peso en PLA/PETG y metros de filamento. |
| **Variables** | `grosor = 3` y luego escribes `grosor * 2` en cualquier medida. Admite `+ - * / ^ ( )`, `sqrt`, `sin`, `cos`, `tan` (en grados), `abs`, `round` y `pi`. |
| **Exportar** | **3MF** (Bambu Studio, Orca, Prusa; guarda unidades y piezas separadas), **STL** y **STEP** (Rhino, Fusion, FreeCAD). |

Además: deshacer/rehacer (`Ctrl+Z` / `Ctrl+Y`), apagar un paso sin borrarlo, reordenar pasos,
varias piezas guardadas, tema claro y oscuro, vista 3D en perspectiva o isométrica (las vistas
Arriba, Frente, etc. son siempre isométricas).

### Atajos en el boceto

| Tecla | Herramienta |
|---|---|
| `S` | Elegir y mover |
| `L` | Líneas (clic en el primer punto o `Intro` para cerrar) |
| `R` | Rectángulo |
| `C` | Círculo |
| `P` | Polígono |
| `W` | Camino: línea abierta para un barrido (`Intro` para terminar) |
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
