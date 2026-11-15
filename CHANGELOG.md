# Cambios

## 2.9.1 — 2026-11-15

### Seguridad
- **Las fichas de pacientes se sincronizan con un id opaco.** En la 2.9.0, el id de la ficha (una huella del RUT, sin clave) quedaba visible en el servidor y permitía recuperar el RUT probando todos los posibles. Ahora el servidor ve solo un HMAC con una subclave de la contraseña del equipo, y cada equipo verifica que el contenido cifrado corresponda a su id. No había fichas en el servidor de producción, así que no se expuso ningún dato.

## 2.9.0 — 2026-11-15

### Nuevo
- **El paciente es la unidad.** Cada paciente tiene una ficha (RUT, nombre, fecha de nacimiento, sexo, fono), y cada atención es un episodio de su historial, en la fecha y especialidad que corresponda.
  - La ficha se identifica por el RUT (sin importar el formato) o, sin RUT, por el nombre: dos equipos no la duplican.
  - Las fichas van en un espacio común del servidor, listo para que un paciente reciba atenciones de varias especialidades.
  - Las atenciones existentes se vinculan solas a su paciente (esquema v4).
- **Pestaña Ingreso** para trabajar varios a la vez:
  - una persona preingresa a los pacientes del día;
  - la lista del día muestra a cada uno como **Por atender** o **Atendido**;
  - médicos y otros profesionales abren al paciente desde la lista y registran solo lo suyo (la PIO, el diagnóstico…); todo se fusiona campo a campo;
  - si el RUT ya existe, se completan sus datos y se avisa cuántas atenciones previas tiene; no se agrega dos veces el mismo paciente el mismo día.
- **Pacientes** es ahora un registro de pacientes: cada ficha muestra sus datos y su historial de atenciones, y permite crear una nueva atención para ese paciente.
- **La atención muestra las atenciones previas** del paciente.
- **Verificador de RUT:** ✓ verde si el dígito verificador es correcto, ✗ roja si no.
- **Respaldos** incluyen las fichas de pacientes (los anteriores se siguen aceptando).

### Sin cambios
- PDF, Excel, nota y exportación seudonimizada: idénticos (pruebas de referencia).

### Pruebas
- Unitarias: modelo de paciente, migración v4, fichas en IndexedDB y localStorage, sincronización de fichas entre dos equipos (el servidor no ve nombre ni RUT), respaldo con fichas.
- En navegador: verificador de RUT y **trabajo simultáneo en tres PC** (admisión ingresa, el médico anota diagnóstico y plan, enfermería la PIO; los tres terminan con todo y el paciente pasa a Atendido).

## 2.8.0 — 2026-11-15

### Arquitectura (sin cambios visibles; las salidas son idénticas, verificado)
- **Especialidad como módulo** (`src/specialties/oftalmologia/`): catálogos, clínica, formulario, plantilla PDF, nota, Excel y seudonimización.
- La plataforma la usa solo a través de `src/specialties/activa/`. ESLint lo exige.
- **Contrato de especialidad** (`src/specialties/contrato.js`), validado en las pruebas y antes de cada build.
- `ESPECIALIDAD=<id> npm run build` construye otra especialidad. Ver `docs/ESPECIALIDADES.md`.
- La seudonimización genérica pasa a `core/pseudonym.js`.
- **Pruebas de referencia** (`tests/golden.test.js`): nota, Excel, exportación seudonimizada y campos del PDF quedan congelados.

### Seguridad
- **CSP sin `'unsafe-inline'` para scripts**: solo se ejecuta el script de la app, identificado por su hash SHA-256, que el build calcula.
- La misma política se envía como cabecera HTTP (`dist/_headers`), con `frame-ancestors 'none'`.
- Prueba en navegador de que un script inyectado se bloquea.

## 2.7.0 — 2026-11-14

### Nuevo
- **Historial de cambios (bitácora de auditoría)** en cada atención:
  - qué equipo, cuándo y qué campo cambió, con su valor anterior y el nuevo;
  - se sincroniza cifrado entre los PC, y las entradas simultáneas se unen sin perder ninguna;
  - se incluye en los respaldos.
- **Nombre de este equipo** en Ajustes (aparece en el historial).
- **Almacenamiento en IndexedDB**:
  - un documento por atención, sin el límite de ~5 MB de localStorage;
  - cada guardado escribe solo lo que cambió;
  - migración automática de los datos existentes, con localStorage como respaldo si IndexedDB no está disponible.
- **Migraciones de esquema versionadas** (`core/migrations.js`). Los datos de una versión más nueva de la app se conservan intactos y se pide recargar, en vez de degradarlos.
- **Importar un respaldo** ahora fusiona campo a campo, como la sincronización.

### Rendimiento
- Guardar una atención: unos 25 ms.
- Sincronización sin cambios con 3.000 atenciones: menos de 200 ms.
- Descarga inicial de 3.000 atenciones: 0,3 s (antes 8,5 s, porque escribía una por una).

### Pruebas
- 118 unitarias:
  - repositorio sobre IndexedDB y localStorage;
  - migración;
  - versiones futuras;
  - bitácora;
  - respaldo v3;
  - convergencia de la bitácora con 4 PC concurrentes.
- 14 en navegador: se agregan la migración a IndexedDB y el historial (propio y de otro equipo).

## 2.6.0 — 2026-11-14

### Calidad y proceso (sin cambios visibles para el usuario)
- **CI en GitHub Actions** en cada push y pull request:
  - ESLint, Prettier y `tsc --checkJs`;
  - pruebas y estrés de sincronización (200 escenarios);
  - build, y verificación de que `dist/` esté al día;
  - pruebas en navegador con Playwright.
- **ESLint** con reglas de corrección y de capas: el núcleo no puede usar el DOM ni `localStorage`, y la interfaz no puede usar `alert`, `confirm` ni `prompt`.
- **Prettier**: formato uniforme en todo el código (reformateo único).
- **Verificación de tipos** sobre JSDoc. Se corrigieron 50 inconsistencias de tipos.
- **Pruebas en navegador (Playwright)**, 11 escenarios:
  - guardar y ver en Pacientes;
  - validación;
  - edad desde la fecha de nacimiento;
  - descarga del PDF y de Excel;
  - copiar la nota;
  - eliminar con el diálogo propio;
  - crear un médico;
  - dos PC que editan el mismo paciente y se fusionan;
  - continuar en una atención existente;
  - vista de celular.
- **Versión con una sola fuente** (`package.json`). Todas las dependencias con versión exacta.
- **Dependabot** para proponer actualizaciones mensuales.
- `CONTRIBUTING.md` con el proceso y las reglas de la base de código.

## 2.5.1 — 2026-11-14

### Corregido (crítico)
- **Pérdida de ediciones con 3 o más PC sincronizando a la vez.** Dos PC que fusionaban a la vez podían quedar con el mismo número de versión y distinto contenido, y ninguno lo detectaba. Ahora:
  - cada versión lleva una huella HMAC de su contenido (clave `…/<versión>.<huella>` en el servidor), atada al id y a la versión y con una subclave propia: el servidor no puede comparar registros ni distinguir eliminaciones;
  - si el número coincide y la huella no, el PC baja, fusiona y sube una versión nueva;
  - la versión rechazada por el servidor provoca otra pasada inmediata.

### Nuevo
- **Reloj lógico** (`core/clock.js`): una edición posterior a otra recibida siempre queda con fecha posterior, aunque el reloj del PC esté atrasado.
- **Aviso de hora desajustada** (más de 3 minutos respecto del servidor).
- **Pruebas de convergencia** (`tests/convergence.test.js`):
  - el caso reproducido de 3 PC;
  - 8 escenarios aleatorios de 4 PC sincronizando en paralelo;
  - 4 escenarios de conflictos en los mismos campos;
  - modo estrés `SEMILLAS=200`, con 200 de 200 escenarios correctos.
- Tests del reloj lógico. 102 pruebas en total.

## 2.5.0 — 2026-11-14

### Nuevo
- **Fusión campo a campo** cuando varios PC editan al mismo paciente: si uno anota la PIO y otro un diagnóstico, se conservan ambos. Solo si editan el mismo campo gana la edición más reciente.
  - Cada atención guarda la fecha de edición de cada campo (`ft`).
  - Antes de subir, el PC fusiona con la versión del servidor, así nunca sobrescribe lo de otro.
  - Al bajar, fusiona con lo local; los cambios de otros PC aparecen en la atención abierta sin perder lo que se está escribiendo.
  - La fusión es determinista: todos los PC llegan al mismo resultado.
- **Mismo paciente, mismo día:**
  - al escribir el RUT de un paciente que ya tiene una atención ese día, aparece un aviso con «Continuar en esa atención» (lo escrito se agrega);
  - al guardar se ofrece «Combinar» o «Guardar aparte».
- **Avisos y confirmaciones con diálogos propios de la app** (ya no los del navegador).
- **«Generar» contraseña** solo aparece si el servidor aún no tiene una.

### Pruebas
- 84 tests, entre ellos dos PC que editan campos distintos sin conexión (en ambos órdenes) y el caso del mismo campo.

## 2.4.1 — 2026-11-14 (incluida en 2.5.0)

### Corregido
- **«Generar» ya no aparece cuando el servidor tiene contraseña.** Antes se podía generar una contraseña nueva que no coincidía con la del equipo («Esta contraseña no coincide…»). La app ahora consulta al servidor:
  - si ya tiene contraseña, pide la del equipo;
  - si no tiene, muestra «Generar» (primera configuración).
- Mensaje de contraseña incorrecta más claro, con qué hacer.

### Cambiado
- **Todos los avisos y confirmaciones usan diálogos propios de la app**, con icono, título y botones claros; ya no usan los del navegador. Las acciones destructivas se confirman con botón rojo.
- Si el navegador no permite copiar la nota, se muestra el texto seleccionado para copiarlo a mano.
- Test que impide volver a usar `alert`/`confirm`/`prompt`.

## 2.4.0 — 2026-11-14

### Nuevo
- **Perfiles de médico y lista de operativos**, que se comparten entre los PC a través del servidor (cifrados):
  - en la atención se eligen de un menú, y elegir un médico rellena su nombre y RUT;
  - se crean desde el mismo menú («＋ Nuevo…») o en Ajustes;
  - al actualizar, se crean solos a partir de las atenciones existentes.
- **Fecha de nacimiento**: la edad se calcula sola a la fecha de atención (y queda de solo lectura).
- **Separación por especialidad** en todos los niveles:
  - cada atención guarda `especialidad`;
  - en el servidor, cada especialidad tiene su espacio (`<especialidad>/r/...`) y puede tener su propia contraseña;
  - en el navegador, las claves de almacenamiento llevan el prefijo de la especialidad.

### Cambiado
- **Estadística** más simple:
  - filtro en una línea;
  - indicadores con gestiones en una sola línea;
  - tablas en dos columnas;
  - se quitó el botón Imprimir (la impresión del navegador sigue funcionando).
- **Exportar** más simple: tres filas (PDF, Estadística, Seudonimizados), con las opciones de seudonimización plegadas.
- **Ajustes** reordenado: médicos y operativos primero, y la zona de cuidado plegada.
- Se quitó el texto «Médico y operativo se recuerdan…».
- La sincronización ahora lleva atenciones, médicos y operativos, y lee el formato de la versión anterior.
- PDF, Excel y exportaciones no cambian.

## 2.3.0 — 2026-11-14

### Cambiado (solo interfaz; PDF, Excel y exportaciones no cambian)
- Formulario más **compacto**:
  - datos del paciente, operativo y fecha en una sola tarjeta;
  - examen por ojo en una fila (AV, PIO, otro, resultado);
  - procedimientos en dos columnas.
- **Barra de la atención** fija arriba, con iconos para nueva, copiar nota, PDF y Guardar. Muestra el nombre del paciente y si hay cambios sin guardar. Reemplaza la barra inferior.
- La pestaña **Registro** pasa a ser **Pacientes**: lista agrupada por día, con diagnósticos y número de procedimientos. Se abre tocando la fila, y cada fila tiene acciones con iconos.
- Se quitó la pestaña **Nota**: la nota para Eloísa se copia con el botón de la barra o desde la lista.
- La PIO de cada procedimiento indica el ojo («PIO OD», «PIO OI»).
- Navegación en la misma línea que la marca en escritorio, y barra de pestañas inferior en el celular.

## 2.2.0 — 2026-11-14

### Cambiado
- **Interfaz rediseñada**, más limpia y minimalista:
  - superficies neutras, un solo color de acento y tipografía más sobria;
  - navegación con iconos (barra inferior en el celular);
  - controles segmentados y casillas con estado claro;
  - barra de acciones flotante;
  - modo oscuro automático.
- Las salidas (PDF, Excel, nota, exportaciones) no cambian.

### Despliegue
- Sitio en producción: https://hhr-rondas.netlify.app, con despliegue automático desde `main`.
- Variable `SYNC_TOKEN_SHA256` configurada en Netlify.

## 2.1.0 — 2026-11-14

### Nuevo
- **Sincronización cifrada de extremo a extremo** entre varios PC, mediante una Netlify Function y Netlify Blobs:
  - AES-256-GCM, con la clave derivada de una contraseña del equipo que nunca sale del PC;
  - el servidor solo guarda un id, la versión y el texto cifrado;
  - sincroniza en segundo plano, sigue funcionando sin conexión y propaga las eliminaciones;
  - un indicador en la cabecera muestra el estado.
- **Instalable y sin conexión desde la web** (service worker y manifest).
- `netlify.toml` con cabeceras de seguridad, y `npm run dev` para un servidor local con sincronización.
- Documentación en `docs/SINCRONIZACION.md`.

### Cambiado
- CSP: `connect-src 'self'`, porque ahora la app se conecta a su propio servidor.
- El build genera `dist/index.html` (para Netlify) además de la copia para usar con doble clic.
- 58 tests.

## 2.0.0 — 2026-11-14

Reescritura modular de `Hoja_Atencion_Oftalmologica.html` (v1). Lee los datos existentes de la v1 sin migración manual.

### Nuevo
- **Exportación seudonimizada** (Excel y JSON para IA) con código estable por paciente (`P-XXXXXXXX`), limpieza de textos libres, opciones de fecha, edad y texto, verificación automática de fugas y tabla de correspondencia confidencial aparte.
- **ZIP con todos los PDF** del filtro, nombrados `Oftalmo_fecha_RUT_nombre.pdf`.
- **Excel real (.xlsx)** de estadística, que reemplaza a los CSV. Trae las hojas Resumen, Atenciones (incluye columnas 0/1 por diagnóstico), Prestaciones (una fila por procedimiento), Por día, y Edad y sexo.
- Campo **Sexo** y estadística por grupo etario y sexo, con edad promedio y mediana.
- Estadística por día, por operativo y por médico, más porcentajes.
- **Validación**: dígito verificador del RUT, rangos de edad y PIO, fecha futura, catarata sin ojo y aviso de atención duplicada el mismo día.
- Pestaña **Exportar** con un filtro compartido con Estadística.
- Ajustes: PDF aplanado o editable, pie de página, texto de la línea final de la nota, alternar PIO por procedimiento.

### PDF mejorado
- Los textos que no caben con letra legible (mínimo 7 pt) ya no se encogen hasta 4 pt ni se cortan: pasan a una **hoja complementaria**.
- Los procedimientos realizados se listan en una tabla (procedimiento, ojo, PIO OD/OI) cuando no caben en la hoja 1.
- Pie con el ID de atención, la fecha de emisión y «Página X de Y».
- Metadatos del documento (título, autor, asunto).
- Formulario aplanado (no editable) por defecto.

### Técnico
- Código en módulos ES (`src/`): lógica pura separada de la interfaz y del almacenamiento.
- Build con esbuild a un solo HTML que funciona sin conexión.
- Política CSP que bloquea toda conexión de red.
- 48 tests con `node:test`.
- Documentación en `docs/`.
