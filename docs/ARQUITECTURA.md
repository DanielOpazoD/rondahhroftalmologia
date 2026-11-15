# Arquitectura

## Restricciones que guían el diseño

1. **Sin conexión y sin instalación.** Se usa en terreno (Rapa Nui), a veces sin internet, abriendo un archivo con doble clic (`file://`). Por eso el producto final es **un único HTML** con todo incrustado: código, estilos, pdf-lib y la plantilla PDF.
2. **Datos sensibles.** Los datos de pacientes no salen del equipo **sin cifrar**. La política CSP (`connect-src 'self'`) solo permite conectarse con el propio servidor. A ese servidor llegan únicamente atenciones cifradas en el PC (ver [SINCRONIZACION.md](SINCRONIZACION.md)).
3. **Varios PC a la vez.** Cada PC es la fuente de verdad local (*local-first*). La sincronización intercambia versiones y queda la más reciente (*last-write-wins*), igual que la unión de respaldos.
3. **Mantenible.** El código fuente está en módulos ES pequeños con responsabilidades claras. Un *build* los une en el HTML final.

## Capas

```
            ┌──────────────────────────────────────────────┐
  ui/       │ vistas: intake, attention, registry, stats,  │  DOM, eventos
            │ export, settings · context.js (controlador)  │
            └───────────────┬──────────────────────────────┘
                            │ llama a
     ┌──────────────────────┼─────────────────────────┐
     ▼                      ▼                         ▼
  storage/repo.js      core/* (lógica pura)       specialties/activa/*
  storage/store.js     record, patient, merge,    (catálogos, clínica,
  IndexedDB            migrations, audit, clock,   nota, PDF, Excel)
                       backup, format
                            │
                            ▼
                     lib/* (sha256, zip, xlsx) · config/catalogs.js
```

- **`core/` y `lib/` no tocan el DOM ni `localStorage`.** Reciben datos y devuelven datos, así que se prueban directamente en Node (`tests/`).
- **Almacenamiento:**
  - `storage/repo.js` maneja los datos clínicos (atenciones, fichas de pacientes, eliminaciones, bitácora). Los mantiene en memoria y persiste en **IndexedDB** solo lo que cambió (`storage/backends.js`, con localStorage como respaldo).
  - `storage/store.js` guarda lo pequeño: ajustes, catálogos, borrador y sincronización. Recibe el `storage` por parámetro, y en las pruebas se usa uno en memoria (IndexedDB simulado con `fake-indexeddb`).
  - **Rendimiento medido:** guardar una atención toma unos 25 ms; una sincronización sin cambios con 20.000 atenciones, unos 140 ms (solo pide lo cambiado); la descarga inicial de 3.000 atenciones, unos 0,3 s.
- **`ui/context.js`** guarda el estado (atención en edición, registros, filtro, ajustes) y lo transversal (persistir, re-dibujar, pestañas). Las acciones están en **`ui/actions/`**: `attention.js` (guardar, abrir, eliminar), `patients.js` (preingreso, fichas, unir duplicados), `catalogs.js` y `outputs.js` (PDF, nota). Las vistas llaman a esas acciones; nunca escriben en el almacenamiento directamente.
- **HTML seguro** (`ui/html.js`): toda la interfaz arma su HTML con la plantilla `html\`…\``, que escapa sola cada dato interpolado, y lo escribe con `setHtml`. ESLint prohíbe asignar `innerHTML` directamente, así que un nombre de paciente con `<` o `&` nunca se interpreta como HTML.

- **Paciente como unidad** (`core/patient.js`): cada atención es un episodio vinculado a la ficha de su paciente (`pacienteId`). Ver [MODELO_DATOS.md](MODELO_DATOS.md).

Flujo típico: `evento → acción del contexto → store → render de las vistas afectadas`.

## Decisiones

| Decisión | Motivo |
|---|---|
| Escritor `.xlsx` propio (`lib/xlsx.js`) en vez de SheetJS | Unas 250 líneas contra ~1 MB de librería. Solo necesitamos texto, números, negrita, anchos y filtros. Se valida en los tests con el `zipfile` de Python como lector independiente. |
| ZIP propio, sin compresión (`lib/zip.js`) | Los PDF ya vienen comprimidos. Es simple y sin dependencias. |
| SHA-256/HMAC propio (`lib/sha256.js`) | `crypto.subtle` no está garantizado en `file://` en todos los navegadores. Se compara contra `node:crypto` en los tests. |
| pdf-lib empaquetado con esbuild | Es la misma librería que usaba la v1, ahora como dependencia versionada (1.17.1) y no pegada a mano. |
| Plantilla PDF como asset | Se edita o reemplaza como archivo (`assets/`). El build la incrusta en base64. |
| Mismas claves de `localStorage` que la v1 | Las atenciones existentes se leen sin migración manual (`normalizeRecord` las actualiza). |
| Validación con «errores» y «advertencias» | En terreno los datos pueden quedar incompletos. Solo se bloquea si falta lo mínimo (nombre/RUT y fecha). |

## Cambiar la plantilla PDF

Los nombres de los campos del PDF deben coincidir con las claves de `config/catalogs.js` (casillas) y con los que usa `pdf/attentionPdf.js` (textos). Para listar los campos de una plantilla nueva:

```bash
node -e "import('pdf-lib').then(async({PDFDocument})=>{const d=await PDFDocument.load(require('fs').readFileSync('assets/plantilla_hoja_atencion.pdf'));d.getForm().getFields().forEach(f=>console.log(f.constructor.name,f.getName()))})"
```

Un campo que falta en la plantilla se ignora sin error.

## Tests

`npm test` corre `node:test` sobre `tests/*.test.js`:

| Archivo | Cubre |
|---|---|
| `lib.test.js` | SHA-256/HMAC contra `node:crypto`, CRC-32, ZIP y XLSX leídos con Python |
| `core.test.js` | formato (RUT, fechas, texto), modelo, validación, derivaciones clínicas, nota |
| `stats.test.js` | filtros, agregados, grupos etarios, libro de estadística |
| `anonymize.test.js` | códigos estables, limpieza de textos, opciones, que no queden identificadores en la salida |
| `storage.test.js` | store en memoria, compatibilidad v1, errores de cuota, respaldo y unión |
| `pdf.test.js` | relleno de campos, casillas, hoja complementaria, aplanado |
| `build.test.js` | HTML único, CSP, sin recursos externos, sitio con service worker |
| `sync.test.js` | cifrado (clave incorrecta o datos alterados fallan), servidor (autenticación, validación, versiones), 4 PC que convergen sin que el servidor vea datos |

La interfaz (DOM) se verifica manualmente abriendo `dist/` en el navegador: guardar, validar, registro, estadística y cada exportación.
