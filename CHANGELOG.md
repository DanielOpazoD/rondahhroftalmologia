# Cambios

## 2.34.0 — 2026-11-18

### Interfaz: fase 3 de la deuda (accesibilidad y listas grandes)
- **Los errores ya no se pierden:** un fallo al guardar, al sincronizar o al unir fichas queda en un aviso rojo hasta que se cierra (antes desaparecía en 2 segundos). Se anuncia al lector de pantalla, queda por encima de los diálogos, se cierra con Escape y devuelve el foco a donde estaba.
- **Pacientes sin tope de 500:** con más pacientes se muestran de a 500 con «Mostrar N más». Antes, los más antiguos solo se alcanzaban buscando. «Ver ficha» desde «Posibles duplicados» abre al paciente aunque esté más allá de la página.
- **Foco de teclado visible** en campos y botones.
- **Botones de 44 px en pantallas táctiles.** La atención compacta queda solo para mouse.
- **Texto sobre rojo legible en el tema oscuro:** el botón Eliminar tenía contraste 2,69:1; ahora 6,87:1.

### Operación
- docs/OPERACION.md: custodia de la contraseña del equipo y qué hacer si se pierde o se filtra.
- Pruebas en navegador sin esperas fijas (reloj simulado), menos frágiles.

## 2.33.0 — 2026-11-18

### Operación: fase 2 de la deuda (docs/OPERACION.md)
- **El respaldo diario lee en paralelo** (16 lecturas a la vez, en el mismo orden). De a una, con miles de versiones, la función programada podía quedarse sin tiempo y no respaldar.
- **La app muestra cuándo fue el último respaldo del servidor** (Ajustes → Este equipo) y avisa con ⚠ si tiene más de 48 horas. Antes, un respaldo que dejaba de correr pasaba inadvertido.
- **Restaurar un respaldo ya no repone cuentas** salvo que se pida con `--cuentas`. Así una cuenta descartada no vuelve sola al restaurar datos clínicos.
- Al desactivar una cuenta se cierran sus sesiones revisando solo los días en que pueden estar abiertas (hoy y ayer), no todas las sesiones guardadas.

## 2.32.0 — 2026-11-18

### Cimientos: fase 1 de la deuda (arquitectura; docs/ARQUITECTURA.md)
- **Contrato tipado del contexto de la interfaz** (`ui/contract.d.ts`): las acciones y el servicio de cuentas declaran su forma, y reciben el contexto con su tipo en vez de `any`. Al quitarlo aparecieron 20 inconsistencias reales, corregidas.
- **Servidor de cuentas en módulos**: de 888 líneas a 187 más siete piezas (validación, HTTP, secretos, almacén, ingreso, sesión, administración). Se comparó en 194 solicitudes con el código anterior: las respuestas y lo guardado son idénticos.
- **Sin `any` en los bordes**: respaldos, adjuntos, servidor y archivo de la llave del PC se validan con guardas de tipo. Quedan 2 en la interfaz (el ayudante `$` del DOM).
- **Temas de eventos cerrados**: un nombre mal escrito ya no pasa la revisión de tipos.
- **Especialidad activa con el alias `#especialidad/`** (package.json): si falta un archivo, el build falla con un mensaje claro. Antes, la redirección dependía de la ruta de la carpeta y podía fallar sin aviso.

### Correcciones
- El servidor de sincronización aceptaba elementos sin id (guardados como `r/undefined/1`) o con id numérico; ahora exige texto. Lo mismo para los ids de cuenta, que aceptaban una lista.
- El HTML publicado incluía `package.json` entero (scripts y dependencias de desarrollo); ahora solo la versión.

## 2.31.0 — 2026-11-17

### Seguridad y sincronización (fase 0 de la deuda; docs/CALIDAD.md)
- **El bloqueo por intentos ya no se puede saltar** enviando muchos a la vez. Antes, 100 intentos simultáneos con una clave mala no bloqueaban la cuenta; ahora la clave se revisa como máximo 5 veces y la cuenta queda bloqueada. Lo mismo para el límite por red.
- **Un dato dañado en el servidor ya no detiene la sincronización:** se omite, se avisa una vez y el resto se sincroniza. Se puede recuperar del respaldo diario.
- Un campo con una fecha de edición muy adelantada (reloj malo o dato manipulado) ya no gana para siempre al fusionar.
- **La clave inicial (RUT sin dígito verificador) vence a las 24 horas** en vez de 7 días.

## 2.30.0 — 2026-11-17

### Interfaz
- **Pacientes en una sola lista:** cada paciente se despliega en su lugar, con sus datos, «Editar datos», «Nueva atención» y su historial de atenciones. Ya no hay otra pantalla ni botón «← Pacientes». Se despliega uno a la vez; tocarlo de nuevo lo pliega.
- Filas más claras: iniciales, RUT, edad y sexo, la última fecha y cuántas atenciones tiene, y una flecha que muestra si está desplegado.
- **Atención más compacta** en pantallas anchas: alrededor de un 10 % menos de alto, con los mismos campos. En el celular se mantienen los tamaños para tocar con el dedo.
- Se quitó el aviso «Nombre anterior… Completa apellidos y nombres para organizarlo» de Atención e Ingreso.
- El botón de formularios (Constancia GES, IPD, receta) usa un ícono de herramientas.

## 2.29.0 — 2026-11-17

### Seguridad: datos de cada PC cifrados con la clave personal ([ADR 0016](docs/adr/0016.md))
- Con cuentas de usuario, lo que la app guarda en cada PC (atenciones, fichas, bitácora, adjuntos, borrador, perfiles) queda **cifrado con una llave del PC**, que se abre con la clave personal de quien entra. También la **clave del equipo**, que antes quedaba legible en el navegador.
- Antes de entrar no se carga ningún dato. Antes, la pantalla de ingreso solo los tapaba.
- **Recargar la página pide la clave**: la llave del PC no se guarda en ningún lado.
- La primera vez, al entrar con conexión, la app cifra lo que ya estaba guardado. Si se interrumpe, termina en el siguiente ingreso, sin pisar lo guardado mientras tanto.
- Una clave restablecida por el administrador o una persona que nunca entró en ese PC abren los datos al entrar con conexión. Sin conexión, entra quien ya entró antes en ese PC.

## 2.28.0 — 2026-11-17

### Seguridad
- **Claves personales más fuertes:** al menos 8 caracteres, con una mayúscula, un número y un símbolo (antes, 6 caracteres sin símbolo).
- Quien tenga una clave anterior que no cumple la regla debe crear una nueva al entrar con conexión. Sin conexión puede entrar igual, y se le pide al volver a entrar con conexión.

## 2.27.1 — 2026-11-17

### Receta para lentes
- El nombre se escribe **nombres, apellido paterno y apellido materno** (antes, apellidos primero), para el paciente y el profesional. Una receta ya abierta que guardó el orden antiguo se reabre con el nuevo; un nombre escrito a mano se respeta.
- Cada texto queda **centrado en su casilla** (antes, nombre, RUT, prescripción y profesional partían pegados al borde izquierdo).

## 2.27.0 — 2026-11-16

### Correcciones
- **«¿Quién registra?» ya no se reemplaza a sí misma**: si el guardado automático llegaba mientras la pregunta estaba abierta (por ejemplo, creando un perfil nuevo), abría una segunda que borraba lo que se estaba escribiendo. Ahora los guardados van de a uno y la pregunta se hace una sola vez. (Venía de 2.26.0; la prueba en navegador que lo mostraba fallaba solo a veces.)
- **Sin conexión y sin nada guardado**, la app ahora recibe un error de red claro en vez de una falla del service worker.
- Un adjunto con identificadores que no son texto (respaldo o sincronización manipulados) se descarta en vez de romper la carga.

### Cimientos (docs/CALIDAD.md)
- **Tipos estrictos en todo el código**, no solo en `src/`: también los scripts, las funciones de Netlify (la entrada del servidor) y el service worker (137/137 módulos). Cada uno se revisa con las APIs de donde corre; una prueba impide que quede código fuera.
- **Complejidad máxima 12** (antes 15): 33 funciones simplificadas; ninguna función del código pasa de 12.
- **Primeras pruebas del service worker** (`tests/sw.test.js`): con red, sin red, la app guardada y lo que no debe tocar.

## 2.26.0 — 2026-11-16

### Nuevo
- **Botón circular de formularios**, fijo abajo a la derecha: abre Constancia GES, IPD y Receta para lentes para el paciente de la atención. En celular se ubica sobre la navegación.
- **Guardado automático por atención** de los tres formularios: al cerrar, recargar o volver al paciente se recuperan los datos. Otro paciente y una atención nueva empiezan con sus propios valores. También se conservan los campos borrados expresamente.
- Los borradores viajan en respaldos y sincronización con fechas por campo, sin reemplazar datos demográficos ni perfiles profesionales. El esquema v6 conserva los datos anteriores y protege los formularios frente a versiones antiguas.


## 2.25.0 — 2026-11-16

### Correcciones (encontradas al probar ramas sin cubrir)
- Si la activación de cuentas se interrumpía a medias, ahora se puede reintentar (antes respondía «ya existe una cuenta con ese RUT» para siempre).
- «Cambiar mi clave» ya no acepta como nueva la misma clave actual.
- Una ficha de paciente dañada (sin datos como objeto) en un respaldo o en la sincronización ya no rompe la carga: se limpia.
- Una solicitud demasiado grande al servidor de cuentas responde 413 en vez de un error interno.

### Cimientos (docs/CALIDAD.md)
- **Complejidad máxima 15** (antes 18): ninguna función de `src/` ni de `scripts/` pasa de 15. `npm run calidad` muestra la próxima meta (funciones sobre 10).
- **Cobertura de ramas 87 % → 91 %**: 81 pruebas nuevas del servidor de cuentas, la sesión, las fichas y la bitácora (acceso por rol, clave inicial, bloqueos por intentos, sesiones adulteradas, validación de cada acción). El mínimo exigido sube a 91 %.
- Sin código repetido entre especialidades en la seudonimización.

## 2.24.0 — 2026-11-16

### Cimientos (docs/CALIDAD.md)
- **Sin código muerto**: una prueba exige que cada `export` del código lo use otro archivo. Sobraban 37 exportaciones (526 → 489): 34 se usaban solo dentro de su propio archivo y 3 eran una re-exportación duplicada.
- **HTML seguro, más estricto**: la función que marca un texto como HTML sin escapar ya no se puede usar fuera de su módulo.
- **Funciones más simples**: la complejidad máxima bajó de 25 a 18 (sincronización, huella de contenido, bitácora, estadísticas ORL, ajustes, apertura de datos…); funciones sobre 15: de 35 a 23. El tope ahora también rige para `scripts/`.
- **Cobertura mínima más alta**: líneas 97 %, ramas 87 %, funciones 92 % (antes 95 / 85 / 87).
- Sin cambios de comportamiento: salidas (PDF, nota, Excel) idénticas y 200 escenarios de sincronización concurrente sin diferencias.

## 2.23.0 — 2026-11-16

### Correcciones (encontradas al revisar los tipos)
- Ingresar un paciente con un RUT incompleto y sin nombre ya no guarda una atención sin ficha: pide el nombre o un RUT completo.
- Desactivar la sincronización mientras sincroniza ya no la reactiva al terminar.
- Dos sincronizaciones que se cruzan ya no pueden tomar una lista parcial del servidor como completa.

### Cimientos (docs/CALIDAD.md)
- **Tipos estrictos en todo el código** (120 de 120 módulos, antes 41): sin `any` implícito y con revisión de nulos. Una prueba impide desactivarlos o silenciarlos con `@ts-ignore`.
- **Funciones simples**: la más compleja bajó de 108 a 25 (servidor de cuentas, sincronización, respaldo, PDF, nota, seudonimización, chequeo del equipo…). ESLint ahora pone tope a la complejidad y al anidamiento.
- `npm run calidad`: informe de tipos, complejidad, capas y manejo de errores.
- Salidas idénticas: PDF, nota y Excel verificados con las pruebas «golden».

## 2.22.0 — 2026-11-16

### Rendimiento (medido: `npm run perf`, detalle en docs/RENDIMIENTO.md)
- **La app pesa 3,4 veces menos**: 4,3 MB → 1,26 MB (comprimida 2,8 MB → 0,63 MB). Se descarga, se guarda sin conexión y se abre más rápido.
  - Las plantillas PDF traían peso que no se ve (perfil de color de imprenta, metadatos, fuentes completas, imágenes guardadas como texto). Se ven igual: la de atención, la IPD y la GES idénticas píxel a píxel.
- **Con muchos pacientes, todo responde al instante** (medido con 3.000 atenciones de 1.100 pacientes):
  - abrir la app: 1,2 s → 0,37 s;
  - pestaña Pacientes: 0,37 s → 0,06 s;
  - buscar un paciente: 0,57 s → 0,04 s.
- Un cambio que llega de otro equipo solo re-dibuja la pestaña que se está viendo.

### Visual
- **Datos del paciente en dos filas** (Ingreso y Atención): RUT, apellidos y nombres; nacimiento, edad, sexo y fono. En el celular, de a pares, sin campos sueltos.
- En el celular, AV · AVcc · PIO de cada ojo en una sola fila.
- **Reportes** muestra solo lo que tiene datos: sin tarjetas vacías, sin contadores en cero y sin columnas de sexo vacías (el Excel sigue trayendo todo).

### Cimientos
- `npm run perf`: mide tamaño, composición del script, núcleo y la app real en el navegador con datos sintéticos.
- `scripts/plantillas-livianas.mjs` y una prueba de presupuesto que impide que una plantilla vuelva a traer peso invisible.
- Se quitaron reglas CSS y funciones sin uso; tamaño de letra base y fondo de diálogos como variables del diseño (`--fs-base`, `--scrim`).
- `@playwright/test` documentado como dependencia de desarrollo (pruebas e2e y medición).

## 2.21.0 — 2026-11-16

### Nuevo
- **Editar los datos personales de un paciente** (Pacientes → ficha → «Editar datos»): RUT, apellidos, nombres, fecha de nacimiento, sexo y teléfono.
  - La ficha **conserva su identidad**, así que no se pierde la continuidad: sigue con todas sus atenciones, y una atención nueva con el RUT corregido llega a la misma ficha.
  - La corrección se aplica también a cada atención de ese paciente; la edad se recalcula con la fecha de cada atención y el cambio queda en su historial.
  - Si el RUT nuevo ya es de otra ficha, ofrece **unir** las dos.
  - Se sincroniza campo a campo, sin pisar otros cambios.
- **Reportes**: Estadística y Exportar en **una sola pestaña**, con un mismo filtro arriba y un menú **Descargar** con:
  - Excel de estadística;
  - PDF de cada atención (ZIP);
  - datos seudonimizados (Excel o JSON).
  - Las opciones de seudonimización quedan en una tarjeta plegable al final.
- **Ajustes se abre tocando el logo del hospital**, con un pequeño engranaje como pista. Las pestañas quedan en cuatro: Ingreso, Atención, Pacientes y Reportes.

### Visual
- En el celular, el filtro de Reportes ordenado: operativo arriba, fechas lado a lado y «Descargar» a la derecha.
- Decimales con coma (por ejemplo, edad promedio «68,4»).

## 2.20.0 — 2026-11-15

### Nuevo
- **Receta para lentes** desde el menú PDF de cada atención: propone nombre, RUT y edad del paciente, profesional y fecha actual de Rapa Nui. Todos los datos se pueden revisar y corregir.
- Campos manuales para Lejos y Cerca (OD, OI y distancia pupilar) y ejes TABO. La graduación no se deduce de la agudeza visual ni de otros textos clínicos.
- Descarga editable sobre la plantilla proporcionada por el hospital, con firma vacía, y vista del PDF con impresión del navegador. Disponible sin conexión, con los mismos permisos y protección por bloqueo que GES e IPD.

## 2.19.0 — 2026-11-15

### Nuevo
- **Constancia GES** desde el menú PDF de una atención de oftalmología: autocompleta paciente, teléfono y profesional, con los datos del Hospital Hanga Roa.
- Selector con los siete títulos oficiales de patologías oftalmológicas GES. La previsión se elige al revisar el formulario.
- Fecha y hora de notificación actuales de **Rapa Nui**, aunque el PC esté en otra zona horaria; se pueden corregir antes de descargar.
- PDF de una página sobre la plantilla IF/N°469 de la Superintendencia de Salud, disponible sin conexión. Firmas en blanco para completar en papel.

- **Impresión GES e IPD**: PDF visible y solicitud del diálogo de impresión del navegador, conservando la descarga. Revisión GES compacta, sin desplazamiento vertical en 1024 × 768.
- **IPD** autocompletado y editable sobre el formulario original: datos fijos del hospital, 90 problemas GES por área, subgrupos oftalmológicos documentados, clínica libre y X en Sí. La fecha y hora de Rapa Nui se distribuyen dígito por casilla; administrativos opcionales vacíos.
- **Apellidos y nombres separados** para pacientes, perfiles y cuentas. Las listas y formularios usan apellido paterno, apellido materno y nombres. Migración v5 conserva el texto y la ficha anteriores sin inferir apellidos.

## 2.18.1 — 2026-11-15

### Descripción por ojo (FO y BMC)
- La descripción del **fondo de ojo** y de la **BMC** es ahora **por ojo**:
  - OD u OI: una descripción, la de ese ojo;
  - AO: dos, una por ojo, y no hay descripción común.
- En el PDF, la del OD va en el recuadro del OD y la del OI en el del OI («FO: …», «BMC: …»).
- En la nota: «Fondo de ojo (FO) AO: OD …; OI …».
- En el seudonimizado van `descripcion_od` y `descripcion_oi`.
- Una atención guardada con la 2.18.0 (una sola descripción) se sigue mostrando en cada ojo marcado; al editarla, pasa a quedar por ojo.

## 2.18.0 — 2026-11-15

### Examen físico y procedimientos
- **AVcc** (agudeza visual con corrección) por ojo, después de AV.
- Se quitan **«Otro» y «Result.»** del examen físico. Si una atención antigua los tiene, se conservan en los datos y en el historial, pero ya no se muestran.
- **Fondo de ojo (FO) y BMC con descripción** (texto opcional), que aparece al marcar el procedimiento.
  - En Ajustes → Listas, el botón «Texto» permite agregar descripción a cualquier otro procedimiento, igual que «PIO».

### PDF
- La plantilla tiene ahora, por ojo, **AV · AVcc · PIO**.
- Las descripciones van en el **recuadro del examen físico** del ojo, con la abreviatura: «FO: …», «BMC: …». Si el procedimiento es AO, van en ambos ojos.
- También aparecen en la nota («Fondo de ojo (FO) AO: …»), en el Excel (columnas AVcc OD y AVcc OI) y en la exportación seudonimizada, donde la descripción pasa por el mismo filtro de identificadores que el resto del texto libre.

### A tener en cuenta
- Recarga la app en todos los PC: una versión anterior no conoce la descripción de los procedimientos y podría perderla al editar esa atención.

## 2.17.0 — 2026-11-15

### Más limpio y compacto (#52)
- **Ajustes en 4 secciones**:
  - **Este equipo**: chequeo, sesión o PIN, sincronización, cuentas, PDF y nota, errores;
  - **Listas**: perfiles, operativos, procedimientos;
  - **Datos**: respaldo y zona de cuidado;
  - **Administración**: usuarios y registro de accesos; solo la ven los administradores.
- **Escala visual única**: 5 tamaños de letra y 4 radios para toda la app (antes había 13 y 10), y los colores como variables.
- La barra de la atención muestra «Nueva», «Copiar nota» y «PDF» con su nombre en escritorio.

### Coherencia (#53)
- **Una sola identidad**: con cuentas, quien entra aparece solo entre los profesionales del formulario.
  - El chequeo del equipo muestra la sesión y el bloqueo de sesión, en vez de perfiles y PIN.
- **Datos del paciente con una sola plantilla** para Ingreso y Atención, y un solo selector de sexo.

### Arquitectura (#54, y esta versión)
- La **sesión de las cuentas** funciona sin pantalla (`sync/accountSession.js`), con pruebas contra el servidor en memoria.
- La **sincronización** separa el motor de la vista.
- Ayudantes compartidos (íconos, acciones con botón ocupado) y servicios del contexto declarados en un solo lugar.
- **Dependencias conocidas**: `npm run deps` y [docs/DEPENDENCIAS.md](docs/DEPENDENCIAS.md) muestran:
  - las capas y qué puede usar cada una;
  - el mapa real de dependencias;
  - los 3 paquetes externos y para qué se usan.
- Las pruebas fallan si aparece un ciclo, una dependencia no permitida o un paquete sin documentar. Se eliminaron los 2 ciclos que había: bitácora ↔ fusión y avisos ↔ utilidades de pantalla.

### Corrección
- **Registro de accesos en hora local**: en Rapa Nui, los eventos de la tarde (desde las 19:00) no aparecían en el día consultado, porque el servidor agrupa por día UTC. Ahora se consulta por la hora local exacta.

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
