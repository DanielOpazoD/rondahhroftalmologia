# Hoja de Atención Oftalmológica · Hospital Hanga Roa

Registro de atenciones de las **rondas y operativos de oftalmología**. Es un solo archivo HTML que funciona **sin conexión**, en computador o celular. Los datos se guardan en el navegador de cada equipo. Opcionalmente, varios PC se sincronizan a través de Netlify con cifrado de extremo a extremo: el servidor no puede leer los datos.

## Uso en terreno

1. Abre la app desde su dirección en Netlify. Si vas a trabajar sin sincronización, también puedes abrir **`dist/Hoja_Atencion_Oftalmologica.html`** con doble clic (Chrome, Edge o Safari).
2. **Atención**: elige el operativo y el médico de la lista (o crea uno nuevo desde la misma lista) y completa la hoja. La edad se calcula sola si ingresas la fecha de nacimiento. La barra superior muestra al paciente y si hay cambios sin guardar. Sus botones son:
   - **＋** nueva atención;
   - **copiar** la nota para Eloísa;
   - **PDF** de la hoja oficial;
   - **✓ Guardar** (también Ctrl/⌘ + S).

3. **Pacientes**: lista de los atendidos, agrupados por día. Toca una fila para abrirla.
4. Al final de cada jornada: **Ajustes → Descargar respaldo** (no es necesario si la sincronización está activa).

| Pestaña | Para qué sirve |
|---|---|
| Atención | Formulario. Valida el RUT (dígito verificador), la edad y la PIO, y avisa si el paciente ya tiene una atención ese día. |
| Pacientes | Atendidos por día, con diagnósticos y número de procedimientos. Busca por nombre (sin tildes) o RUT y filtra por operativo. En cada fila: copiar nota, PDF o eliminar. |
| Estadística | Indicadores, procedimientos por ojo, diagnósticos, solicitados, gestiones, edad y sexo, por día. |
| Exportar | ZIP con todos los PDF, Excel de estadística, datos seudonimizados para IA. |
| Ajustes | Médicos y operativos (compartidos entre PC), sincronización, lista de procedimientos, opciones del PDF y respaldo. |

### Exportaciones

| Exportación | Archivo | Contenido |
|---|---|---|
| PDF por paciente | `Oftalmo_AAAA-MM-DD_RUT_Nombre.pdf` | Hoja oficial rellena. Si un texto no cabe, se agrega una **hoja complementaria**. Formulario aplanado (no editable) y pie con el ID de atención. |
| PDF en lote | `pdf_oftalmo_<filtro>.zip` | Un PDF por atención del filtro, para subirlos uno por uno. |
| Estadística | `estadistica_oftalmo_<filtro>.xlsx` | Hojas *Resumen*, *Atenciones*, *Prestaciones*, *Por día* y *Edad y sexo*. |
| Seudonimizado | `.xlsx` o `.json` | Sin datos identificatorios. Cada paciente lleva el código `P-XXXXXXXX`. Ver [docs/ANONIMIZACION.md](docs/ANONIMIZACION.md). |
| Correspondencia | `CONFIDENCIAL_correspondencia_….xlsx` | Código ↔ nombre y RUT. **No se comparte.** |

### Varios PC trabajando a la vez

Hay dos formas de trabajar con varios PC:

- **Sincronización cifrada (recomendada).** Requiere tener la app publicada en Netlify. Los PC se mantienen iguales en forma automática. Cada atención se cifra en el PC con la contraseña del equipo antes de enviarse, así que Netlify no puede leer nombres, RUT ni datos clínicos. Sin internet se sigue trabajando y se sincroniza al volver la conexión. La puesta en marcha está en [docs/SINCRONIZACION.md](docs/SINCRONIZACION.md).
- **Respaldos.** También sirve con el archivo abierto con doble clic. Cada PC descarga su respaldo (`respaldo_oftalmo_AAAA-MM-DD.json`) y en un solo PC se usa **Ajustes → Importar respaldo** con cada archivo. Las atenciones se suman sin duplicar. Si una atención existe en ambos, queda la versión editada más recientemente.

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

`npm run build` genera el sitio en `dist/`: `index.html`, la copia `Hoja_Atencion_Oftalmologica.html` para usar con doble clic, y el service worker. `npm run check` ejecuta los tests y luego el build.

Para probar la sincronización en local sin Netlify:

```bash
SYNC_TOKEN_SHA256=<valor> npm run dev
```

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
  sync/                  sincronización cifrada: crypto, protocolo, cliente, servidor
  storage/store.js       acceso a localStorage
  ui/                    vistas y controlador (context.js)
  index.html, styles.css, main.js
assets/plantilla_hoja_atencion.pdf   plantilla oficial con campos rellenables
public/                  service worker, manifest e icono (uso sin conexión desde la web)
netlify/functions/       función de Netlify para la sincronización
netlify.toml             configuración de despliegue
scripts/build.mjs        empaqueta todo en un HTML
scripts/dev-server.mjs   servidor local con sincronización en memoria
tests/                   tests con node:test
docs/                    arquitectura, modelo de datos, anonimización
```

Más detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) y [docs/MODELO_DATOS.md](docs/MODELO_DATOS.md).
