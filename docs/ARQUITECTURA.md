# Arquitectura

## Restricciones que guían el diseño

1. **Sin conexión y sin instalación.** Se usa en terreno (Rapa Nui), a veces sin internet, abriendo un archivo con doble clic (`file://`). Por eso el producto final es **un único HTML** con todo incrustado: código, estilos, pdf-lib y la plantilla PDF.
2. **Datos sensibles.** Los datos de pacientes no deben salir del equipo. Una política CSP (`connect-src 'none'`) impide cualquier conexión de red desde la página.
3. **Mantenible.** El código fuente está en módulos ES pequeños con responsabilidades claras. Un *build* los une en el HTML final.

## Capas

```
            ┌──────────────────────────────────────────────┐
  ui/       │ vistas: attention, registry, stats, export,  │  DOM, eventos
            │ settings · context.js (controlador)          │
            └───────────────┬──────────────────────────────┘
                            │ llama a
     ┌──────────────────────┼─────────────────────────┐
     ▼                      ▼                         ▼
  storage/store.js     core/* (lógica pura)       pdf/attentionPdf.js
  localStorage         record, clinical, note,    pdf-lib + plantilla
                       stats, reports, anonymize,
                       backup, format
                            │
                            ▼
                     lib/* (sha256, zip, xlsx) · config/catalogs.js
```

- **`core/` y `lib/` no tocan el DOM ni `localStorage`.** Reciben datos y devuelven datos, así que se prueban directamente en Node (`tests/`).
- **`storage/store.js`** es la única puerta a `localStorage`. Recibe el `storage` por parámetro: en los tests se usa uno en memoria.
- **`ui/context.js`** guarda el estado (atención en edición, registros, filtro, ajustes) y expone acciones (`save`, `openRecord`, `downloadPdf`…). Las vistas llaman a esas acciones; nunca escriben en el almacenamiento directamente.

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
| `build.test.js` | HTML único, CSP, sin recursos externos |

La interfaz (DOM) se verifica manualmente abriendo `dist/` en el navegador: guardar, validar, registro, estadística y cada exportación.
