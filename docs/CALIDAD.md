# Calidad del código

Cada práctica de este proyecto tiene **dónde se hace cumplir** (una herramienta que falla en la integración continua) y **cómo se mide** (`npm run calidad`, `npm run perf`, `npm run deps`). Una regla que solo está escrita se olvida; una que rompe el build, no.

```bash
npm run check     # lint, formato, tipos, pruebas y build (lo mismo que la CI, sin e2e)
npm run calidad   # informe: tipos estrictos, complejidad, capas, manejo de errores
npm run perf      # tamaño y rendimiento con datos sintéticos (docs/RENDIMIENTO.md)
npm run deps      # mapa de capas y paquetes (docs/DEPENDENCIAS.md)
```

## Prácticas y dónde se hacen cumplir

| Práctica | Se hace cumplir en | Detalle |
| --- | --- | --- |
| **Tipos estrictos en todo `src/`** | `npm run typecheck` (`jsconfig.json`, `strict: true`) | JSDoc + `tsc --checkJs --strict`: sin `any` implícito ni nulos sin revisar. Sin `@ts-ignore`. Los tipos del dominio están en `src/domain.d.ts`. |
| **Capas sin ciclos** | `tests/deps.test.js` | `core/` y `lib/` son puros (sin DOM ni almacenamiento); `ui/` solo la usa `main.js`; la especialidad se usa a través de `specialties/activa/`. Ver `scripts/deps.mjs` (`LAYERS`). |
| **Pocas dependencias, conocidas** | `tests/deps.test.js` | Cada paquete externo está en `package.json` con versión fija y documentado en `scripts/deps.mjs` (`EXTERNAL`): para qué y dónde. Máximo 5. |
| **Funciones simples** | ESLint `complexity` y `max-depth` | Tope de complejidad ciclomática por función y de anidamiento. El tope solo baja: al simplificar una función, se baja el número en `eslint.config.js`. |
| **Errores que no se pierden** | ESLint `no-empty` + revisión | Cada `catch` relanza, informa (registro de errores o aviso), sigue con una alternativa o explica en un comentario por qué se ignora. |
| **HTML seguro** | ESLint `no-restricted-syntax` + CSP | Sin `innerHTML`: plantillas `html\`…\`` que escapan solas. CSP sin `unsafe-inline` (verificada en e2e). |
| **Pruebas** | CI: cobertura mínima, e2e, estrés | `node:test` con cobertura mínima (líneas, ramas, funciones); 200 escenarios de sincronización concurrente; Playwright en escritorio y celular, incluido lector de pantalla. |
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

La regla general: una función hace una cosa; si para explicarla hace falta «y además», son dos.

## Lo que encontraron los tipos estrictos (2.23.0)

Activar la revisión de nulos en todo `src/` (antes, una opción heredada la dejaba apagada sin que nadie lo notara; ahora `tests/calidad.test.js` lo impide) mostró casos reales, no solo anotaciones faltantes:

- **Ingreso sin identidad**: con un RUT incompleto (p. ej. «1») y sin nombre, se guardaba una atención sin ficha de paciente. Ahora pide el nombre o un RUT completo.
- **Desactivar la sincronización mientras sincroniza**: al terminar, guardaba una configuración incompleta y volvía a mostrarla como activa. Ahora respeta la desactivación.
- **Dos sincronizaciones que se cruzan**: una respuesta parcial (solo lo cambiado) podía quedar como si fuera toda la lista del servidor. Ahora pide la lista completa (prueba de regresión en `tests/sync.test.js`, verificada: falla sin el arreglo).
- **Unir fichas o corregir datos**: una ficha con id inválido devolvía `null` donde se esperaba una ficha; ahora falla con un mensaje claro en vez de guardar un nulo.
- **Atributos `data-*` faltantes** en la interfaz se usaban como clave `undefined` en silencio; ahora `dataOf()` (en `src/ui/dom.js`) falla con el nombre del atributo.

Una revisión que confía en el informe de quien hizo el cambio no basta: el arreglo de las sincronizaciones cruzadas se revisó a mano, se encontró que no hacía lo que decía, y se corrigió con su prueba.

