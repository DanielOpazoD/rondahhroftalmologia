# Cambios

## 2.16.1 — 2026-11-15

### Cambios visuales
- **Logo del Hospital Hanga Roa** (amarillo) en el encabezado, la pantalla de ingreso y la de bloqueo. Va dentro del archivo de la app, sin cargar nada externo.

## 2.16.0 — 2026-11-15

### Nuevo: cuentas de usuario ([ADR 0014](docs/adr/0014.md))
- **Cada persona entra con su RUT y su clave** (#45, #46).
  - La clave inicial es el RUT sin dígito verificador: sirve solo para el primer ingreso, que obliga a crear una clave personal (6 o más caracteres, una mayúscula y un número), y vence a los 7 días.
  - 5 intentos fallidos bloquean la cuenta 15 minutos.
  - Se puede entrar **sin conexión** en un PC donde la persona ya entró.
  - El bloqueo por inactividad pide la clave de la persona.
- **Sistema propio**, sin servicios externos: se mantiene el **cifrado de extremo a extremo**.
  - El servidor no guarda RUT, nombres ni claves en claro.
  - La clave del equipo va **envuelta** por cuenta.
- **Roles** (#48):
  - administradores (puede haber varios; siempre queda al menos uno activo);
  - clínicos, que editan las atenciones;
  - **administrativos**, que **ven las atenciones sin editarlas**, hacen el ingreso y editan los datos del paciente.
  - Solo los administradores cambian los ajustes del sistema.
- **Administración de usuarios** (#47, Ajustes → Usuarios): crear, también desde los perfiles existentes; editar; restablecer clave; desactivar y reactivar.
- **Registro de accesos** (#49, Ajustes, solo administradores):
  - quién entró y cuánto tiempo;
  - qué fichas y atenciones abrió, qué descargó o exportó, qué guardó;
  - la administración de cuentas.
  - Lo escribe el servidor con su hora y no se puede editar. Filtros y descarga a Excel.
- **Identidad verificada** en el historial de cambios: el autor es la persona que entró, y no se pregunta «¿Quién registra?».

### Cómo empezar
- **Nada cambia hasta que un administrador active las cuentas**: Ajustes → Cuentas de usuario → Activar, desde un PC que ya sincroniza.
- Desde ese momento, todos los PC piden RUT y clave, y la contraseña del equipo deja de servir para sincronizar.
- **Guarda la contraseña del equipo:** sigue siendo la llave de respaldo y permite recuperar un administrador (`scripts/recover-admin.mjs`).

### Respaldo
- Las cuentas van en el respaldo diario del servidor, y el registro de accesos en el respaldo incremental.
- Restaurar repone lo que falte sin pisar cuentas vigentes.

### A tener en cuenta
- Los permisos de lectura y de edición clínica se aplican en la app y en el servidor donde este puede verlos: todos comparten la clave de cifrado del equipo. Lo disuade el registro de accesos.
- Desactivar a alguien corta su acceso al servidor; lo que ya tiene en su PC sigue allí.

## 2.15.0 — 2026-11-15

### Nuevo
- **Los adjuntos entran en los respaldos**:
  - **Servidor** (#38): una función cada hora copia el contenido (cifrado) de los adjuntos, de forma incremental: cada parte una sola vez.
    - El contenido de un adjunto eliminado se conserva 30 días.
    - `scripts/restore-backup.mjs` también lo repone.
  - **«Descargar respaldo»** (#39): con adjuntos, se descarga un **ZIP** con las atenciones y el contenido de cada adjunto.
    - Al importarlo, el contenido se acepta solo si coincide con su huella SHA-256.
    - Sin adjuntos, sigue siendo el JSON de siempre. Los respaldos anteriores se siguen importando.
- **Eliminar fichas creadas por error** (#40): en Pacientes, «Fichas sin atenciones» lista las fichas que sobran y permite eliminarlas.
  - Desaparecen en todos los equipos.
  - Si una atención vuelve a usar la ficha, reaparece sola.
  - Los datos no se borran, porque la ficha es común a todas las especialidades.
- **Aviso de cambios de otro equipo** (#41): si otro PC cambia la atención que tienes abierta, un aviso dice quién y qué cambió (por ejemplo, «Plan: vacío → Control en 3 meses»). Los campos cambiados se resaltan un momento.
- **Miniaturas** (#42): al adjuntar una imagen se guarda una miniatura pequeña con sus datos.
  - Se ve en los otros PC antes de que llegue la foto.
  - A las imágenes anteriores se les crea al abrirlas.

### Mejoras
- **Procedimientos según la lista configurada** (#44): uno que se quita de la lista en Ajustes deja de mostrarse y de contarse.
  - Afecta: el contador de la tarjeta, la estadística, los reportes, el PDF y la nota.
  - El dato queda en la atención: si se restaura el procedimiento, vuelve con su valor.
- **«PIO» solo donde corresponde** (#44): en Ajustes, la etiqueta aparece solo en los procedimientos que piden la presión intraocular.
  - Corrige un error por el que todos se veían apagados.
- **Sincronización silenciosa** (#44): ya no aparece «Sincronizado: N cambios recibidos»; solo hay mensaje al pulsar «Sincronizar ahora».
- **Menú al descargar el PDF** (#44): «PDF» o «PDF + adjuntos», desde la atención y desde Pacientes.
- **Pacientes** (#44):
  - la lista marca «Por atender»;
  - la ficha muestra un resumen y el botón «Nueva atención»;
  - cada atención muestra sus procedimientos y sus adjuntos.

### A tener en cuenta
- La lista de procedimientos se configura **en cada PC** (no se sincroniza).
- El respaldo ZIP de «Descargar respaldo» **no está cifrado**, igual que el JSON: guárdalo como cualquier documento clínico.
- El primer respaldo de adjuntos en el servidor puede tardar algunas horas si hay muchos: cada hora copia lo que alcanza.

### Sin cambios
- PDF, Excel, nota y exportación seudonimizada: idénticos (pruebas de referencia).

## 2.14.1 — 2026-11-15

### Seguridad
- **Adjuntos: solo se abren en el navegador tipos pasivos** (JPEG, PNG, GIF, WebP y PDF), y sin miniatura para el resto. Cualquier otro tipo, en particular SVG o HTML, que pueden llevar scripts, se **descarga** como binario genérico: un adjunto nunca se interpreta dentro de la app. El tipo de los metadatos se normaliza. Lo detectó una revisión de seguridad automática; se agregó una prueba unitaria y una en navegador (un SVG con script se descarga y no se abre).

## 2.14.0 — 2026-11-15

### Nuevo
- **Archivos adjuntos en cada atención** (#33, #34): imágenes, PDF, Word…
  - Tarjeta «Adjuntos»: adjuntar con el botón o arrastrando, con miniaturas; abrir y eliminar.
  - Las fotos grandes se reducen solas (lado mayor 2400 px, JPEG).
  - Viajan **cifrados** a los otros PC, en partes, y al bajarlos se verifica su huella SHA-256.
  - Límites: 20 MB por archivo, y 60 MB y 30 archivos por atención.
  - Quedan en el historial de cambios. Eliminar la atención elimina sus adjuntos.
- **PDF con anexos** (#35): el botón PDF de una atención con adjuntos ofrece «Con anexos» o «Solo la hoja».
  - Con anexos: la hoja, un índice, las imágenes como páginas y los PDF adjuntos con sus páginas, en un solo documento.
  - Word y Excel van **dentro del PDF** (panel de adjuntos del visor).
  - «Solo la hoja» es el PDF de siempre.

### A tener en cuenta
- El respaldo diario del servidor no incluye el contenido de los adjuntos (puede pesar gigabytes). Está en cada PC que sincroniza y en los respaldos de cada PC.
- Sin IndexedDB (navegadores muy antiguos o modo privado estricto) no se pueden adjuntar archivos.

### Sin cambios
- El PDF «Solo la hoja», Excel, nota y exportación seudonimizada: idénticos (pruebas de referencia).

## 2.13.0 — 2026-11-15

### Nuevo
- **Guardado automático** (#27):
  - cada cambio se guarda solo tras una pausa al escribir (1,2 s), y también al ocultar o cerrar la página;
  - la barra dice «Guardando…» y «Guardada», o por qué aún no se puede guardar;
  - nunca duplica una atención del mismo paciente ese día;
  - «¿Quién registra?» se pregunta al abrir la app, para no interrumpir la escritura;
  - el historial junta en una entrada las ediciones seguidas de la misma persona.
- **Cabecera sin superposiciones y diseño más compacto** (#24):
  - con poco espacio, la cabecera se compacta por pasos (solo el logo, luego pestañas con ícono);
  - tarjetas, filas y áreas de texto más compactas;
  - Ajustes con los procedimientos en columnas.
- **Respaldos diarios del servidor** (#28):
  - automáticos y cifrados, con 30 días disponibles;
  - script de restauración con modo de prueba;
  - guía en `docs/OPERACION.md`.
- **Límite de intentos fallidos de contraseña** por red (#29). La contraseña correcta nunca se bloquea.

### Accesibilidad
- Probado como lo anuncia un **lector de pantalla** (#30):
  - los íconos ya no se leen como «imagen»;
  - el sexo se lee con su nombre completo;
  - el estado del guardado se anuncia.
- `docs/ACCESIBILIDAD.md` trae una guía de prueba manual con VoiceOver o NVDA.

### Arquitectura e ingeniería
- **Segunda especialidad piloto (otorrinolaringología)**, construida en la CI. Demuestra que la plataforma admite otras especialidades y lista lo que aún asume de oftalmología (#25).
- **Tipos completos** (`noImplicitAny`) en las capas puras: de 435 avisos a 0 (#26).
- **Rama `main` protegida** (solo por PR con la CI en verde) y **versiones etiquetadas**: cada versión crea su etiqueta y release desde el CHANGELOG (#31).

### Sin cambios
- PDF, Excel, nota y exportación seudonimizada: idénticos (pruebas de referencia).

## 2.12.1 — 2026-11-15

### Interfaz
- **Aviso de cambios sin guardar en el equipo** (#20). Si el almacenamiento falla (p. ej. disco lleno):
  - aparece una barra roja con «Reintentar»;
  - el chequeo del equipo lo marca en rojo, con la acción «Descargar respaldo»;
  - al liberar espacio, todo se guarda y la barra desaparece.

### Arquitectura y documentación
- La correspondencia entre datos locales y elementos sincronizados pasa a la capa de aplicación (`app/syncData.js`), con pruebas de ida y vuelta (#21).
- Diagramas de capas, de una pasada de sincronización y de dos PC editando el mismo paciente. Se corrige ARQUITECTURA, que aún decía «last-write-wins» (#22).

## 2.12.0 — 2026-11-15

Versión de calidad: arquitectura, sincronización e ingeniería, en 14 PR revisados por la CI (#5 a #18). No cambian las salidas (PDF, Excel, nota ni exportación seudonimizada) ni la forma de usar la app.

### Datos y sincronización
- **Lector tolerante entre versiones** (#6, ADR 0012):
  - ningún PC borra los campos que agregue una versión más nueva;
  - un rol de perfil desconocido ya no se convierte en «médico».
- **Red poco confiable** (#8):
  - tiempo máximo de 20 s por solicitud;
  - reintentos con retroceso exponencial solo ante errores transitorios.
- **Versión de protocolo** entre cliente y servidor (#9):
  - el servidor puede exigir una mínima (`426`, «recarga la página»);
  - la app avisa si el servidor es más nuevo.
- **Motor de sincronización en etapas** con estado explícito (#17), sin cambio de comportamiento.
- **Almacenamiento resiliente** (#16):
  - corregido: una escritura que fallaba en IndexedDB quedaba marcada como guardada y el dato podía perderse al cerrar;
  - ahora se reintenta y queda pendiente hasta guardarse;
  - se pide al navegador almacenamiento persistente.

### Servidor
- Límite de tamaño por solicitud (`413`), `405` con cabecera `Allow`, errores con código estable.
- `x-request-id` y registro estructurado sin datos (#15).
- La marca del índice de cambios se fecha al escribirla (#14).

### Interfaz
- **Aviso de versión nueva** mientras la app está abierta, con «Recargar» (#10).
- **Registro local de errores** en Ajustes, para enviar a soporte (#11).
- **Bus de eventos:** las acciones anuncian qué cambió y las listas se re-dibujan una sola vez (#12).

### Seguridad
- **CSP sin `'unsafe-inline'` en estilos:** solo la hoja de la app, por su hash; el HTML no tiene atributos `style` (#18).

### Arquitectura e ingeniería
- **Registro de decisiones de arquitectura** (`docs/adr/`, 12 ADR) (#5).
- **Capa de aplicación pura** (`src/app/`): las reglas de guardar, preingresar y re-vincular se prueban sin navegador (#7).
- **Tipos estrictos** en las capas puras y modelo de dominio tipado (`src/domain.d.ts`) (#13).
- **Pruebas:**
  - cada prueba en navegador empieza con el servidor vacío;
  - cobertura mínima exigida en la CI (líneas 95 %, ramas 85 %, funciones 87 %);
  - `npm audit` de dependencias de producción (#14).

### Al actualizar
- Recarga la app en todos los PC. A partir de esta versión, los PC se avisan solos cuando hay una versión nueva.

## 2.11.0 — 2026-11-15

### Nuevo
- **Chequeo del equipo antes del operativo** (Ajustes → Antes del operativo). Revisa:
  - si el PC tiene la última versión publicada (el sitio publica `version.json` y la app conoce su compilación);
  - si la sincronización funciona y la hora del equipo es correcta;
  - si hay nombre del equipo, perfiles y operativo;
  - el almacenamiento (y pide al navegador protegerlo del borrado automático), el último respaldo y el bloqueo con PIN.

  Cada punto pendiente trae su botón para resolverlo. Aparece solo al abrir la app tras 7 días o más sin uso.
- **Modo práctica** para capacitar.
  - Pacientes de ejemplo con historial y la lista del día, perfiles y un operativo.
  - Almacenamiento separado: los datos reales no se leen ni se tocan.
  - Nunca se sincroniza, y las descargas llevan el prefijo `PRACTICA_`.
  - «Reiniciar» y «Salir».
- **Bloqueo con PIN por equipo.**
  - Se bloquea al abrir, tras 5 a 30 minutos sin uso y con el candado del encabezado.
  - Código de recuperación, o la contraseña del equipo con la sincronización activa.
  - Espera creciente tras 5 intentos fallidos.
  - Solo se guarda una derivación PBKDF2 del PIN. Es una protección de pantalla, no cifra los datos.

### Accesibilidad
- **Revisión automática WCAG 2.1 A/AA** (axe-core) en todas las pestañas, diálogos, la pantalla de bloqueo y el modo práctica, en tema claro, oscuro y en celular: sin infracciones.
- **Contraste:** el texto secundario pasó de 3,0:1 a 4,7:1 o más (oscuro: 4,3:1 a 5,6:1 o más).
- **Teclado:**
  - enlace «Saltar al contenido»;
  - pestañas con el patrón estándar (flechas, Inicio, Fin; solo la activa en el orden de Tab);
  - foco visible en el chip de perfil, la sincronización y los enlaces.
- **Lectores de pantalla:** cada mensaje de error o advertencia queda asociado a su campo (`aria-describedby`).

### Revisión independiente (bloqueo y modo práctica)
- Corregido, con una prueba en navegador para cada punto:
  - con el equipo bloqueado, **Ctrl+P** imprimía la atención de detrás: ahora todo lo que no es la pantalla de bloqueo se oculta, en pantalla y al imprimir;
  - **Escape dos veces** cerraba el bloqueo un instante: se reabre en el acto y la app sigue oculta;
  - un diálogo abierto encima del bloqueo (p. ej. un aviso de sincronización) le quitaba el foco: el bloqueo queda siempre arriba, sin intervalos;
  - **otras pestañas:** bloquear una bloquea todas; la actividad se comparte, así una pestaña inactiva no bloquea a la que se está usando, y abrir una pestaña nueva no bloquea las demás;
  - el perfil elegido en el modo práctica quedaba como la sesión de la app real: ahora cada modo tiene el suyo;
  - un respaldo del modo práctica se podía importar a los datos reales: ahora los respaldos de práctica van marcados y se rechazan fuera de ella (y al revés);
  - el chequeo decía «Al día» sin conexión porque `version.json` venía de la caché: ahora siempre se pide a la red.
- Confirmado sin problemas: aislamiento del modo práctica (cero llamadas al servidor y datos reales intactos tras practicar, reiniciar y salir), límite de intentos, recuperación y cambio o retiro del PIN.
- Límites conocidos:
  - el PIN protege la pantalla, no cifra los datos del navegador;
  - una copia antigua del archivo abierta con doble clic no tiene bloqueo.

### Sin cambios
- PDF, Excel, nota y exportación seudonimizada: idénticos (pruebas de referencia).

## 2.10.0 — 2026-11-15

### Nuevo
- **Quién registra.**
  - Los perfiles ahora tienen rol: médico, enfermería, TENS, tecnólogo, admisión u otro.
  - La primera vez que se guarda en una sesión, la app pregunta quién registra, proponiendo el último perfil del equipo. El chip del encabezado lo muestra y permite cambiarlo.
  - El historial de cambios guarda quién y desde qué equipo.
  - Si quien registra es médico, las atenciones nuevas lo traen como médico. En el menú Médico solo aparecen perfiles médicos.
- **Identidad del paciente a lo largo de los años.**
  - Al paciente se lo encuentra por su RUT entre las fichas existentes. Si fue ingresado primero sin RUT y después con RUT, sigue siendo una sola ficha.
  - Pacientes avisa de **posibles duplicados**: mismo RUT, o mismo nombre sin datos que los distingan.
  - Se pueden **unir** (las atenciones pasan a una ficha y nada se borra) o marcar como personas distintas. Las uniones se sincronizan; si dos equipos unen al mismo tiempo, el resultado es el mismo en todos.

### Rendimiento
- **Sincronización incremental:** después de la primera sincronización al abrir la app, solo se pide al servidor lo cambiado, y no se recalculan huellas ya verificadas. Con 20.000 atenciones, una sincronización sin cambios pasa de 2,1 s a 0,14 s, y la respuesta del servidor de 1,1 MB a 45 bytes. Cada 30 minutos se pide la lista completa como autocorrección.

### Mantenibilidad y seguridad
- **HTML seguro en toda la interfaz:** la plantilla `html\`…\`` escapa sola cada dato, y ESLint prohíbe escribir `innerHTML` directamente. Desaparecen los 26 escapes manuales.
- `ui/context.js` se dividió en acciones por área (`ui/actions/`): de 541 a 158 líneas.

### Al actualizar
- **Recarga la app en todos los PC** antes de usar perfiles con rol o de unir fichas. Un PC con una versión anterior no conoce esos campos, y si edita esa ficha o perfil podría borrarlos.

### Revisión independiente
- Un revisor sin contexto encontró y se corrigió:
  - una bitácora importada desde un respaldo podía quedar sin sincronizar con la caché nueva: ahora el respaldo sube su versión y las huellas se re-verifican en cada lista completa;
  - el cambio de ficha de una atención al agregarle el RUT no quedaba fechado, y la fusión entre equipos podía elegir la ficha anterior;
  - «＋ Nuevo perfil…» desde la pregunta «¿Quién registra?» no abría el formulario;
  - la marca del índice de cambios ahora se escribe antes que la versión, así un reintento nunca la pierde.
- Cada corrección tiene su prueba, y se verificó que la prueba falla sin la corrección.

### Sin cambios
- PDF, Excel, nota y exportación seudonimizada: idénticos (pruebas de referencia).

## 2.9.2 — 2026-11-15

### Seguridad
- **Los perfiles de médico también se sincronizan con id opaco.** Su id local es una huella del RUT del médico y era visible en el servidor. El riesgo era bajo (el RUT de los profesionales de salud es público), pero ahora el servidor ve solo un HMAC con una subclave de la contraseña del equipo.
- **Migración automática:** cada equipo vuelve a subir los perfiles existentes con id opaco y después borra del servidor los ids antiguos (`POST /api/sync/purge`, que solo acepta ids antiguos en claro). Si un equipo aún sin actualizar sube un cambio con el id antiguo, se fusiona antes de borrarlo. No hace falta hacer nada a mano.

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
