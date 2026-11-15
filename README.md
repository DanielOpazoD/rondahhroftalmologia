# Hoja de Atención Oftalmológica · Hospital Hanga Roa

Registro de atenciones de las **rondas y operativos de oftalmología**. Es un solo archivo HTML que funciona **sin conexión**, en computador o celular. Los datos se guardan en el navegador de cada equipo. Opcionalmente, varios PC se sincronizan a través de Netlify con cifrado de extremo a extremo: el servidor no puede leer los datos.

## Uso en terreno

1. Abre la app desde su dirección en Netlify. Si vas a trabajar sin sincronización, también puedes abrir **`dist/Hoja_Atencion_Oftalmologica.html`** con doble clic (Chrome, Edge o Safari).
2. **Ingreso** (opcional, para trabajar en paralelo): una persona preingresa a los pacientes del día con sus datos (RUT, nombre, fecha de nacimiento, sexo, fono). Quedan en la lista como **Por atender**. Los médicos y otros profesionales abren a cada paciente desde esa lista y registran solo lo clínico; al guardar algún dato clínico pasa a **Atendido**. Si el RUT ya está registrado, se completan sus datos y se avisa cuántas atenciones previas tiene.
3. **Atención** (se guarda sola: cada cambio queda guardado tras una pausa al escribir; la barra dice «Guardando…» / «Guardada», o por qué aún no se puede guardar): elige el operativo y el médico de la lista (o crea uno nuevo desde la misma lista) y completa la hoja. La edad se calcula sola si ingresas la fecha de nacimiento. La barra superior muestra al paciente y si hay cambios sin guardar. Sus botones son:
   - **＋** nueva atención;
   - **copiar** la nota para Eloísa;
   - **PDF** de la hoja oficial;
   - **✓ Guardar** (también Ctrl/⌘ + S).

4. **Pacientes**: registro de pacientes. Cada paciente es una ficha con su historial de atenciones (una por día). Desde la ficha se abre cualquier atención o se crea una nueva para ese paciente.
5. Al final de cada jornada: **Ajustes → Descargar respaldo** (no es necesario si la sincronización está activa).

| Pestaña | Para qué sirve |
|---|---|
| Ingreso | Preingreso de pacientes y lista del día (Por atender / Atendido), para trabajar varios a la vez. |
| Atención | Formulario. Muestra las atenciones previas del paciente. Valida la edad y la PIO, y avisa si el paciente ya tiene una atención ese día. |
| Pacientes | Registro de pacientes: busca por nombre (sin tildes) o RUT y filtra por operativo. Cada ficha muestra sus datos y su historial; en cada atención: copiar nota, PDF o eliminar. |

Los campos de RUT muestran **✓ verde** si el dígito verificador es correcto y **✗ roja** si no lo es.

**Quién registra:** en Ajustes → Perfiles se crean los perfiles de médicos y otros profesionales (enfermería, TENS, tecnólogo, admisión). La primera vez que se guarda en una sesión, la app pregunta quién registra; el chip del encabezado lo muestra y permite cambiarlo. El historial de cambios guarda quién y desde qué equipo. Si quien registra es médico, las atenciones nuevas lo traen como médico.

**Posibles duplicados:** si un paciente quedó registrado dos veces (por ejemplo, primero sin RUT), Pacientes lo avisa y permite unir las fichas sin perder atenciones, o marcarlas como personas distintas.

### Antes de cada operativo

La app se usa de forma ocasional, así que conviene revisar los equipos antes de empezar:

- **Chequeo del equipo** (Ajustes → Antes del operativo). Revisa:
  - si el PC tiene la última versión publicada;
  - si la sincronización funciona y la hora del equipo es correcta;
  - si hay nombre del equipo, perfiles y operativo;
  - el almacenamiento, el respaldo y el bloqueo con PIN.

  Cada punto pendiente trae su botón para resolverlo. **Aparece solo** al abrir la app después de 7 días o más sin uso.
- **Modo práctica** (Ajustes → Abrir modo práctica): la misma app con pacientes de ejemplo, para capacitar al personal.
  - Usa un almacenamiento aparte: los datos reales no se leen ni se tocan.
  - Nunca se sincroniza, y los archivos descargados llevan el prefijo `PRACTICA_`.
  - «Reiniciar» vuelve a los datos de ejemplo y «Salir» regresa a la app real.
- **Bloqueo con PIN** (Ajustes → Bloqueo con PIN, por equipo). La pantalla se bloquea:
  - al abrir la app;
  - tras 5 a 30 minutos sin uso;
  - con el candado del encabezado.

  Al configurarlo se entrega un **código de recuperación**: guárdalo con la contraseña del equipo. Si se olvida el PIN, desbloquea con ese código o, con la sincronización activa, con la contraseña del equipo. Tras 5 intentos fallidos hay que esperar, cada vez más. Es una protección de pantalla: evita que otra persona vea los pacientes, pero no cifra los datos guardados en el navegador.
| Estadística | Indicadores, procedimientos por ojo, diagnósticos, solicitados, gestiones, edad y sexo, por día. |
| Exportar | ZIP con todos los PDF, Excel de estadística, datos seudonimizados para IA. |
| Ajustes | Chequeo del equipo, modo práctica, bloqueo con PIN, perfiles y operativos (compartidos entre PC), nombre de este equipo y sincronización, lista de procedimientos, opciones del PDF y respaldo. |

Cada atención guardada muestra al final su **Historial de cambios**: quién (qué equipo), cuándo, y qué campo cambió de qué valor a cuál.

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

Varias personas pueden trabajar al mismo tiempo sobre el mismo paciente: por ejemplo, admisión ingresa, enfermería anota la PIO y el médico el diagnóstico. Cada campo se guarda por separado y se conservan todos.

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

Antes de subir un cambio: `npm run check`, que corre lint, formato, tipos, pruebas y build. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

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
