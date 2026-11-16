# Calidad del código

Cada práctica de este proyecto tiene **dónde se hace cumplir** (una herramienta que falla en la integración continua) y **cómo se mide** (`npm run calidad`, `npm run perf`, `npm run deps`). Una regla que solo está escrita se olvida; una que rompe el build, no.

```bash
npm run check     # lint, formato, tipos, pruebas y build (lo mismo que la CI, sin e2e)
npm run calidad   # informe: tipos estrictos, complejidad, capas, código muerto, manejo de errores
npm run perf      # tamaño y rendimiento con datos sintéticos (docs/RENDIMIENTO.md)
npm run deps      # mapa de capas y paquetes (docs/DEPENDENCIAS.md)
```

## Prácticas y dónde se hacen cumplir

| Práctica | Se hace cumplir en | Detalle |
| --- | --- | --- |
| **Tipos estrictos en todo el código** | `npm run typecheck` (`jsconfig.json`, `strict: true`) + `tests/calidad.test.js` | JSDoc + `tsc --checkJs --strict`: sin `any` implícito ni nulos sin revisar. Sin `@ts-ignore`. Los tipos del dominio están en `src/domain.d.ts`. Tres configuraciones, cada una con las APIs de donde corre el código: `jsconfig.json` (la app, navegador), `jsconfig.node.json` (scripts y funciones de Netlify, con `@types/node`) y `jsconfig.sw.json` (service worker). Ambas heredan el modo estricto; una prueba exige que cubran todo su código. |
| **Capas sin ciclos** | `tests/deps.test.js` | `core/` y `lib/` son puros (sin DOM ni almacenamiento); `ui/` solo la usa `main.js`; la especialidad se usa a través de `specialties/activa/`. Ver `scripts/deps.mjs` (`LAYERS`). |
| **Sin código muerto** | `tests/deps.test.js` (`exportUsage`) | Cada `export` de `src/` lo importa otro archivo. Si solo se usa en su archivo, no se exporta: la interfaz de cada módulo es lo que de verdad usan los demás. Las que solo usan las pruebas se cuentan en `npm run calidad`. |
| **Pocas dependencias, conocidas** | `tests/deps.test.js` | Cada paquete externo está en `package.json` con versión fija y documentado en `scripts/deps.mjs` (`EXTERNAL`): para qué y dónde. Máximo 5. |
| **Funciones simples** | ESLint `complexity` (12) y `max-depth` (4) | Tope de complejidad ciclomática por función y de anidamiento, también en `scripts/`. El tope solo baja: al simplificar una función, se baja el número en `eslint.config.js` (108 → 25 en 2.23.0, → 18 en 2.24.0, → 15 en 2.25.0, → 12 en 2.27.0). `npm run calidad` cuenta las que pasan de 10: la próxima meta. |
| **Errores que no se pierden** | ESLint `no-empty` + revisión | Cada `catch` relanza, informa (registro de errores o aviso), sigue con una alternativa o explica en un comentario por qué se ignora. |
| **HTML seguro** | ESLint `no-restricted-syntax` + CSP | Sin `innerHTML`: plantillas `html\`…\`` que escapan solas, y fuera de `src/ui/html.js` no hay forma de marcar un texto como HTML sin escapar. CSP sin `unsafe-inline` (verificada en e2e). |
| **Pruebas** | CI: cobertura mínima, e2e, estrés | `node:test` con cobertura mínima (líneas 97 %, ramas 91 %, funciones 92 %; el mínimo sube con la cobertura, no baja); 200 escenarios de sincronización concurrente; Playwright en escritorio y celular, incluido lector de pantalla. |
| **Presupuesto de tamaño** | `tests/presupuesto.test.js` | Las plantillas PDF no pueden traer peso invisible ni pasar su tope. |
| **Rendimiento medido** | `npm run perf` | Con 3.000 atenciones sintéticas; cambios de rendimiento se justifican con un antes y un después. |
| **Formato uniforme** | Prettier (`format:check` en CI) | El estilo no se discute: lo decide la herramienta. |
| **`dist/` al día** | CI | El HTML publicado corresponde exactamente al código. |

## Cómo se simplificó una función compleja (ejemplos)

- **Servidor de cuentas** (`src/sync/accounts.js`): `handle` tenía complejidad 108 (un `if` por ruta, con la verificación de sesión y de administrador entremezclada). Ahora cada acción es una función y una tabla `ROUTES` declara su método y su **acceso** (`publica`, `sesion`, `usuario`, `admin`); `handle` solo valida y delega. Quién puede usar cada ruta se lee en una línea.
- **Servidor de sincronización** (`src/sync/server.js`): `route` (37, anidamiento 6) pasó a `list` / `getItems` / `putItems` / `purge`, con `listSince` / `listAll` y `putOne`.
- **Respaldo** (`src/core/backup.js`): `mergeBackup` (36) une cada tipo de dato con su propia función (`mergeRecordsById`, `mergeFuture`, `mergeAuditById`, `mergePatientsById`).
- **Validación** (`src/core/record.js`): `validateRecord` separa identidad, fechas y datos demográficos.
- **PDF de la atención** (`src/specialties/oftalmologia/pdf.js`): las funciones para llenar campos pasan a `createFiller` y cada sección de la hoja es una función (`fillHeader`, `fillExam`, `fillObservations`, `fillPlan`, `fillChecks`).
- **Excel seudonimizado**: cada columna define encabezado y valor juntos (`wideColumns`), así no se pueden desalinear.
- **Chequeo del equipo** (`src/ui/checkView.js`): una función por punto revisado.
- **Sincronizar** (`src/ui/syncController.js`, 2.24.0): `syncNow` (25) solo orquesta; las dos pasadas (`syncSpaces`), lo que dijo el servidor (`checkServer`) y el mensaje de cada error (`syncFailed`) son funciones aparte.
- **Huella de contenido** (`src/core/merge.js`): una cadena de `if` por tipo pasó a una tabla `CONTENT_OF` (tipo → qué cuenta como contenido).
- **Aplicar lo bajado** (`src/sync/protocol.js`): `applyPulled` usa `replacesLocal` (¿gana lo bajado?) y `resolvePulled` (fusión y si hay que volver a subir).
- **Adjuntar anexos al PDF** (`src/core/pdfAnexos.js`, 2.27.0): `appendAnnexes` (15) delega cada tipo de anexo (`addImagePage`, `addPdfPages`) y el índice (`drawIndex`).
- **Sincronización** (`src/sync/client.js`, 2.27.0): la versión que se sube de cada id (`pushVersion`) y su huella (`localHash`) se calculan en un solo lugar, compartido por la comparación y la subida.
- **Servidor local** (`scripts/dev-server.mjs`, 2.27.0): el manejador de solicitudes (13) pasó a `route`, que elige entre `apiFor` + `toRequest` (la solicitud de Node como `Request` estándar) y `serveFile`.
- **Acceso a las rutas de cuentas** (2.25.0): `handle` delega en `accessDenied(acceso, sesión)`, la regla completa en dos líneas (clave inicial → solo rutas de sesión; `admin` → solo administradores). Una prueba de mutación confirma que quitar cualquiera de las dos hace fallar las pruebas.
- **Código repetido entre especialidades**: las dos seudonimizaciones tenían las mismas funciones copiadas; ahora están una vez en `core/pseudonym.js`.

La regla general: una función hace una cosa; si para explicarla hace falta «y además», son dos.

## Lo que encontraron los tipos estrictos (2.23.0)

Activar la revisión de nulos en todo `src/` (antes, una opción heredada la dejaba apagada sin que nadie lo notara; ahora `tests/calidad.test.js` lo impide) mostró casos reales, no solo anotaciones faltantes:

- **Ingreso sin identidad**: con un RUT incompleto (p. ej. «1») y sin nombre, se guardaba una atención sin ficha de paciente. Ahora pide el nombre o un RUT completo.
- **Desactivar la sincronización mientras sincroniza**: al terminar, guardaba una configuración incompleta y volvía a mostrarla como activa. Ahora respeta la desactivación.
- **Dos sincronizaciones que se cruzan**: una respuesta parcial (solo lo cambiado) podía quedar como si fuera toda la lista del servidor. Ahora pide la lista completa (prueba de regresión en `tests/sync.test.js`, verificada: falla sin el arreglo).
- **Unir fichas o corregir datos**: una ficha con id inválido devolvía `null` donde se esperaba una ficha; ahora falla con un mensaje claro en vez de guardar un nulo.
- **Atributos `data-*` faltantes** en la interfaz se usaban como clave `undefined` en silencio; ahora `dataOf()` (en `src/ui/dom.js`) falla con el nombre del atributo.

## Lo que encontraron las pruebas de ramas (2.25.0)

Probar las ramas sin cubrir del servidor de cuentas, la sesión, las fichas y la bitácora (135 → 4 sin probar) mostró cuatro errores reales. Cada uno tiene su prueba, verificada: falla sin el arreglo.

- **Activación a medias**: si se guardaba la cuenta del primer administrador pero no la configuración, reintentar respondía «ya existe una cuenta con ese RUT» para siempre. Ahora el reintento reemplaza la cuenta que quedó a medias (antes de activar no puede haber otras).
- **Clave nueva igual a la actual**: se aceptaba. El servidor recibe la clave ya derivada con otra sal y no puede compararlas; la regla vive ahora donde se puede revisar, en el cliente (`passwordProblem`, y `changeMyPassword` antes de ir al servidor).
- **Ficha con `f: null`** (respaldo o sincronización manipulados): rompía con un TypeError; ahora se limpia como cualquier dato inválido.
- **Solicitud demasiado grande** al servidor de cuentas: respondía 500 y se registraba como falla del servidor; ahora 413, como el de sincronización.

Una revisión que confía en el informe de quien hizo el cambio no basta: el arreglo de las sincronizaciones cruzadas se revisó a mano, se encontró que no hacía lo que decía, y se corrigió con su prueba.


## Lo que encontraron los tipos fuera de `src/` (2.27.0)

Los scripts, las funciones de Netlify (la puerta de entrada del servidor) y el service worker quedaban fuera de la revisión de tipos. Al incluirlos:

- **Service worker sin nada guardado**: sin red, si ni la página pedida ni la app estaban en caché, entregaba `respondWith(undefined)`, que el navegador trata como una falla del propio service worker. Ahora responde un error de red explícito. Es la primera vez que el service worker tiene pruebas (`tests/sw.test.js`, que ejecuta el archivo real con caché y red simuladas; verificadas: fallan sin el arreglo y sin la regla de otros orígenes).
- **Tablas sin tipo** en `scripts/deps.mjs` (`LAYERS`, `EXTERNAL`) se leían con conversiones a `any`; ahora tienen su tipo y las conversiones sobran.
- **Servidor local**: pasaba las cabeceras de Node (que pueden ser listas o faltar) directo a `Request`; ahora las convierte de forma explícita.
- **Dos guardados a la vez** (`src/ui/actions/attention.js`, `src/ui/userView.js`): una prueba en navegador fallaba «a veces». En vez de reintentarla, se buscó la causa: el guardado automático llegaba mientras «¿Quién registra?» estaba abierta y abría una segunda pregunta que reemplazaba la primera. Ahora los guardados se hacen de a uno y la pregunta se comparte. Una prueba nueva lo reproduce siempre (espera más que la pausa del guardado automático con la pregunta abierta) y falla sin el arreglo.
