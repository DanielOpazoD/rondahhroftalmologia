# Rendimiento

La app es **un solo archivo HTML** que cada equipo descarga, guarda sin conexión y abre muchas veces al día. Su rendimiento se mide con datos, no a ojo:

```bash
npm run perf              # mide y muestra
npm run perf -- --write   # además actualiza la sección «Última medición» de este documento
```

`scripts/perf.mjs` usa siempre el mismo conjunto **sintético** (semilla fija, sin datos reales): **3.000 atenciones de ~1.100 pacientes**, más de lo que acumula un año de operativos. Mide:

1. **Tamaño** de la app publicada: total, comprimido y la composición del script por origen (cada paquete, las plantillas y cada carpeta de `src/`).
2. **Núcleo en Node**: estadística, Excel, posibles duplicados, seudonimización, nota, PDF y respaldo.
3. **La app real en Chromium** (`npm run dev` + Playwright): inicio vacío y con los datos (hasta la marca `performance.mark('hhr:listo')` del final de `main()`), cambio de pestaña, búsqueda y memoria. Mediana de 5 repeticiones.

> Los tiempos en Node varían hasta ×2 según la carga del equipo: compáralos en la misma máquina y en la misma sesión. Los del navegador son más estables.

## 2.22.0: de dónde salió la mejora

| Medida | 2.21.0 | 2.22.0 | Causa |
| --- | ---: | ---: | --- |
| App (HTML) | 4.299 KB | 1.262 KB | plantillas PDF y fuentes (abajo) |
| App comprimida (gzip) | 2.810 KB | 634 KB | |
| Plantillas PDF (base64) | 3.497 KB | 545 KB | `scripts/plantillas-livianas.mjs` |
| JS sin plantillas | 691 KB | 605 KB | medidas de fuentes PDF sin uso |
| Inicio sin datos | 217 ms | ~60 ms | menos que leer y compilar |
| Inicio con 3.000 atenciones | 1.170 ms | ~360 ms | identidad de fichas O(n) y catálogos |
| Pestaña Pacientes | 368 ms | ~55 ms | identidad de fichas O(n), orden en caché |
| Buscar en Pacientes | 571 ms | ~30 ms | ídem |

Lo encontró el perfil de CPU (no la intuición):

- **Plantillas PDF** (85 % del archivo): un perfil de color de imprenta de 1,3 MB, credenciales de contenido (C2PA) y metadatos XMP que ningún lector usa; dos fuentes TrueType completas (~200 KB c/u) con las mismas medidas que la Helvetica que trae todo lector; imágenes guardadas como texto (ASCII85, +25 %) y una imagen en gris guardada en color (×3). `scripts/plantillas-livianas.mjs` las aligera **sin pérdida**: la plantilla de atención, la IPD y la GES se ven idénticas píxel a píxel; la receta usa Helvetica estándar, igual que el PDF de atención. `tests/presupuesto.test.js` falla si una plantilla nueva o editada vuelve a traer ese peso.
- **`isCanonicalPatient`** armaba un `Map` de todas las fichas en **cada** consulta: O(n²) al filtrar la lista de Pacientes (y al iniciar, porque se dibujaba aunque estuviera oculta). Ahora quien consulta muchas fichas pasa el `Map` (`patientsById`).
- **`loadPatients`** ordenaba todas las fichas con `localeCompare(…, 'es')` en cada llamada (crea un comparador por comparación). Ahora usa un `Intl.Collator` (`compareEs`) y guarda el orden hasta que cambie una ficha.
- **`seedCatalogs`** calculaba un hash (HMAC-SHA-256) por atención al iniciar; ahora uno por médico u operativo distinto.
- **Pestañas ocultas**: un cambio de datos (p. ej. por sincronización) re-dibujaba Pacientes e Ingreso aunque no se vieran; ahora solo la pestaña visible (las demás se dibujan al abrirlas).
- **Fuentes estándar**: pdf-lib incluye las medidas de las 14 fuentes estándar; la app usa Helvetica y Helvetica-Bold. El build deja fuera las demás (~85 KB; `PDF_FONTS` en `scripts/build.mjs`, verificado por `tests/build.test.js`).

## Cómo mantenerlo

- Antes de agregar o reemplazar una plantilla PDF: `node scripts/plantillas-livianas.mjs` (la prueba de presupuesto lo exige).
- Ante una lista lenta: `npm run perf` y un perfil de CPU (`SIN_MINIFICAR=1 npm run build` deja nombres legibles).
- Para ordenar nombres usar `compareEs`; para fechas ISO, `compareCode` (ambos en `src/core/format.js`).

<!-- mediciones -->

## Última medición (2026-11-18, versión 2.34.0)

```text
Tamaño: 1285 KB (gzip 643 KB, brotli 592 KB) · JS 624 KB · plantillas PDF 545 KB · CSS 54 KB

Composición del script (KB, minificado):
  plantillas PDF                      545 KB
  pdf-lib                             221 KB
  ui/                                 116 KB
  core/                                55 KB
  pako                                 45 KB
  @pdf-lib/standard-fonts              41 KB
  specialties/oftalmologia/            31 KB
  @pdf-lib/upng                        24 KB
  sync/                                23 KB
  ui/actions/                          18 KB
  storage/                             17 KB
  lib/                                 11 KB
  config/                               9 KB
  src/ (main.js)                        5 KB

Núcleo en Node (3000 atenciones, 1112 fichas; mediana):
  Normalizar 3.000 atenciones        33 ms
  Estadística (3.000)                11 ms
  Excel de estadística (3.000)       190 ms
  Posibles duplicados (fichas)       2.3 ms
  Seudonimizar (3.000)               292 ms
  Nota de una atención               0.0 ms
  PDF de una atención                46 ms
  Respaldo JSON (3.000)              13 ms

App en el navegador (Chromium, mediana de 5):
  Inicio sin datos                   68 ms
  Inicio con 3.000 atenciones        326 ms
  Pestaña Pacientes                  83 ms
  Pestaña Reportes                   40 ms
  Pestaña Ingreso                    13 ms
  Buscar en Pacientes                45 ms
  Memoria JS sin datos (MB)          7 MB
  Memoria JS con datos (MB)          19 MB
```
