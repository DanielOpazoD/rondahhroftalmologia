# Cambios

## 2.5.1 — 2026-11-14

### Corregido (crítico)
- **Pérdida de ediciones con 3 o más PC sincronizando a la vez.** Dos PC que fusionaban a la vez podían quedar con el mismo número de versión y distinto contenido, y ninguno lo detectaba. Ahora:
  - cada versión lleva una huella HMAC de su contenido (clave `…/<versión>.<huella>` en el servidor);
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
