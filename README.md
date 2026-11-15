# Hoja de Atención Oftalmológica · Hospital Hanga Roa

Registro de atenciones de las **rondas y operativos de oftalmología**. Es un solo archivo HTML que funciona **sin conexión**, en computador o celular. Los datos quedan solo en el navegador del equipo.

## Uso en terreno

1. Abre **`dist/Hoja_Atencion_Oftalmologica.html`** con doble clic (Chrome, Edge o Safari).
2. **Atención**: completa la hoja y presiona **Guardar** (o Ctrl/Cmd + S). Nombre, RUT del médico y operativo quedan recordados.
3. **PDF**: descarga la hoja oficial rellena para subirla a la ficha del paciente.
4. **Nota**: texto listo para copiar y pegar en Eloísa.
5. Al final de cada jornada: **Ajustes → Descargar respaldo**.

| Pestaña | Para qué sirve |
|---|---|
| Atención | Formulario. Valida el RUT (dígito verificador), la edad y la PIO, y avisa si el paciente ya tiene una atención ese día. |
| Nota | Texto clínico para la ficha electrónica. |
| Registro | Buscar (por nombre sin tildes o RUT), abrir, descargar PDF, copiar nota o eliminar. |
| Estadística | Indicadores, procedimientos por ojo, diagnósticos, solicitados, gestiones, edad y sexo, por día. |
| Exportar | ZIP con todos los PDF, Excel de estadística, datos seudonimizados para IA. |
| Ajustes | Lista de procedimientos, opciones del PDF, respaldo e importación, zona de cuidado. |

### Exportaciones

| Exportación | Archivo | Contenido |
|---|---|---|
| PDF por paciente | `Oftalmo_AAAA-MM-DD_RUT_Nombre.pdf` | Hoja oficial rellena. Si un texto no cabe, se agrega una **hoja complementaria**. Formulario aplanado (no editable) y pie con el ID de atención. |
| PDF en lote | `pdf_oftalmo_<filtro>.zip` | Un PDF por atención del filtro, para subirlos uno por uno. |
| Estadística | `estadistica_oftalmo_<filtro>.xlsx` | Hojas *Resumen*, *Atenciones*, *Prestaciones*, *Por día* y *Edad y sexo*. |
| Seudonimizado | `.xlsx` o `.json` | Sin datos identificatorios. Cada paciente lleva el código `P-XXXXXXXX`. Ver [docs/ANONIMIZACION.md](docs/ANONIMIZACION.md). |
| Correspondencia | `CONFIDENCIAL_correspondencia_….xlsx` | Código ↔ nombre y RUT. **No se comparte.** |

### Juntar datos de varios equipos

Cada equipo descarga su respaldo (`respaldo_oftalmo_AAAA-MM-DD.json`). En un solo equipo: **Ajustes → Importar respaldo** con cada archivo. Las atenciones se suman sin duplicar; si una atención existe en ambos, queda la versión editada más recientemente.

> Los datos viven en el almacenamiento del navegador. Si se borran los datos del navegador, se pierden: **descarga respaldos**.

## Desarrollo

Requiere Node.js 20 o superior.

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

`npm run build` genera `dist/Hoja_Atencion_Oftalmologica.html`, el archivo que se distribuye. `npm run check` ejecuta los tests y luego el build.

```
src/
  config/catalogs.js     catálogos clínicos, claves de almacenamiento, ajustes por defecto
  core/                  lógica pura (sin DOM), probada en Node
    format.js            fechas, RUT, texto
    record.js            modelo de la atención: crear, migrar, validar
    clinical.js          derivaciones clínicas (procedimientos, PIO, listas)
    note.js              nota para Eloísa
    stats.js             filtros y agregados
    reports.js           hojas del Excel de estadística
    anonymize.js         seudonimización y verificación de fugas
    backup.js            respaldo y unión de equipos
  lib/                   utilidades sin dependencias: sha256, zip, xlsx
  pdf/attentionPdf.js    relleno de la plantilla PDF y hoja complementaria
  storage/store.js       acceso a localStorage
  ui/                    vistas y controlador (context.js)
  index.html, styles.css, main.js
assets/plantilla_hoja_atencion.pdf   plantilla oficial con campos rellenables
scripts/build.mjs        empaqueta todo en un HTML
tests/                   tests con node:test
docs/                    arquitectura, modelo de datos, anonimización
```

Más detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) y [docs/MODELO_DATOS.md](docs/MODELO_DATOS.md).
