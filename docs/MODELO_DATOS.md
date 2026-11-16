# Modelo de datos

El **paciente** es la unidad. Cada **atención** es un episodio de una especialidad en una fecha, vinculado a su paciente con `pacienteId`. Así, un mismo paciente acumula atenciones en días distintos (y, a futuro, de distintas especialidades) sin duplicar sus datos.

```
Paciente p_xxxxxxxxxx  (espacio común, todas las especialidades)
 ├─ Atención oftalmología 2026-11-14   (pacienteId = p_xxxxxxxxxx)
 ├─ Atención oftalmología 2027-05-02
 └─ Atención <otra especialidad> …
```

## Paciente (ficha)

Colección `pacientes` de IndexedDB (`src/core/patient.js`). Solo datos demográficos; nada clínico.

```jsonc
{
  "id": "p_k3j9x0a2mq",   // determinista: huella del RUT; sin RUT, del nombre normalizado
  "tipo": "paciente", "v": 1,
  "created": 1763150000000, "updated": 1763150000000,
  "f": { "paciente_rut": "12.345.678-5", "paciente_nombre": "…", "paciente_fnac": "1950-03-01",
         "paciente_sexo": "F", "paciente_fono": "…" },
  "ft": { "f.paciente_fono": 1763150000000 }   // fechas por campo: dos equipos se fusionan campo a campo
}
```

- El id **no depende del formato** del RUT (`12.345.678-5` = `123456785`). Dos equipos que ingresan al mismo paciente por separado crean la misma ficha, no dos.
- Al guardar una atención se actualiza la ficha con sus datos demográficos. Al abrir la app, toda atención sin ficha la genera (`missingPatients`): las bases antiguas quedan ordenadas por paciente sin hacer nada.
- Las fichas no se eliminan: eliminar una atención no borra al paciente.
- **Preingreso:** la pestaña Ingreso crea la ficha y una atención **por atender** (solo datos del paciente, operativo y fecha). Pasa a **atendida** cuando alguien registra cualquier dato clínico (`isAttended`).

### Identidad a lo largo de los años

El id es solo una llave estable; al paciente se lo **encuentra por su RUT** entre las fichas existentes (`resolvePatientId`):

1. si hay RUT y alguna ficha tiene ese RUT, esa ficha (aunque haya nacido solo con nombre);
2. si la atención ya estaba vinculada a una ficha, esa (y la ficha recibe el RUT nuevo);
3. si no, el id derivado de los datos.

Así, quien fue ingresado primero sin RUT y después con RUT sigue siendo una sola ficha.

**Posibles duplicados** (`findDuplicatePairs`), mostrados en Pacientes:

- **mismo RUT**: seguro que es la misma persona;
- **mismo nombre** (sin tildes ni mayúsculas), siempre que no tengan RUT distintos ni fechas de nacimiento distintas. Los homónimos con datos distintos no se sugieren.

**Unir fichas** (`mergePatients`):

- la ficha que se conserva completa sus datos vacíos con los de la otra;
- la otra queda marcada con `f.fusionado_en: <id>` y deja de mostrarse;
- sus atenciones pasan a la ficha vigente (cambio de `pacienteId`, fechado y registrado en la bitácora);
- nunca se unen fichas con RUT distintos.

La marca se sincroniza como cualquier campo. Si un equipo que aún no sabía de la unión crea una atención para la ficha unida, se re-vincula sola al abrir o sincronizar (`ensurePatients`). Si dos equipos unen en sentidos opuestos (A → B y B → A), queda vigente la de id menor, igual en todos los equipos. «Son personas distintas» se recuerda en ese equipo (`oft_no_duplicados_v1`).

**Eliminar una ficha creada por error** (`deletePatient`, desde la 2.15.0): en Pacientes, «Fichas sin atenciones» lista las fichas sin atenciones en esta especialidad; se pueden eliminar.

- La ficha queda marcada con `f.eliminada_en: <ISO-8601>` y deja de mostrarse en todos los equipos (la marca se sincroniza campo a campo).
- Sus datos **no se borran**: las fichas son comunes a todas las especialidades, y otra podría tener atenciones de ese paciente.
- Si una atención vuelve a usar la ficha (al guardarla, o al llegar una de otro equipo), la marca se quita sola (`restorePatient`); la restauración gana a la eliminación.

## Atención (esquema v5)

Se guarda en **IndexedDB**, base `hhr-rondas-oftalmologia`, colección `atenciones`, con un documento por atención (`src/storage/repo.js`). Si IndexedDB no está disponible, se usa localStorage como respaldo. Al abrir esta versión por primera vez, las atenciones que versiones anteriores guardaban en `localStorage["oft_atenciones_v1"]` se migran a IndexedDB y se libera ese espacio.

```jsonc
{
  "v": 5,                          // versión de esquema
  "pacienteId": "p_k3j9x0a2mq",    // paciente al que pertenece (v4)
  "especialidad": "oftalmologia",  // separa datos de distintas rondas
  "id": "amhz3k2a9x1",             // único; se genera al guardar
  "created": 1763150000000,        // epoch ms
  "updated": 1763150000000,        // decide qué versión gana al unir respaldos
  "f": {                           // campos de texto (ver TEXT_FIELDS)
    "operativo": "Operativo Nov 2026",
    "fecha_atencion": "2026-11-14",
    "paciente_nombre": "…", "paciente_rut": "12.345.678-5",
    "paciente_fnac": "1959-03-20",                 // fecha de nacimiento (v3)
    "paciente_edad": "67", "paciente_sexo": "F",   // edad: se calcula sola si hay fecha de nacimiento
    "paciente_fono": "…",
    "od_av": "20/40", "od_avcc": "20/25", "od_pio": "14", "od_hallazgos": "…",   // AVcc desde la 2.18 (sin «Otro» ni «Resultado»)
    "oi_av": "…", "...": "…",
    "medico_nombre": "…", "medico_rut": "…"
  },
  "checks": {                      // casillas marcadas (claves = campos del PDF)
    "antecedente_dm2": true,
    "procedimiento_oct": true,
    "diagnostico_catarata": true
  },
  "cat": "OD",                     // lateralidad de catarata: "" | OD | OI | AO
  "proc": {                        // procedimientos REALIZADOS
    "t_aplan": { "eye": "AO", "od": "14", "oi": "16" },
    "fo": { "eye": "AO", "desc_od": "Papila 0,3", "desc_oi": "Papila 0,5" }   // descripción por ojo: procedimientos con «Texto» (FO y BMC)
  },
  "procNames": { "t_aplan": "T. Aplanática", "fo": "Fondo de ojo (FO)" },
  "ft": { "f.od_pio": 1763150000000, "checks.diagnostico_glaucoma": 1763150050000, "proc.t_aplan.od": 1763150000000 }
}
```

- `proc[id].od / .oi` son la PIO en mmHg y solo existen en procedimientos con `pio: 1`.
- `procNames` guarda el nombre del procedimiento al momento de guardar. Así, si después se quita de la lista en Ajustes, la estadística sigue mostrando su nombre.
- `normalizeRecord()` acepta registros v1 a v3 o incompletos y los lleva a v4 sin perder datos (la v4 agrega `pacienteId`) (los antiguos quedan con `especialidad: "oftalmologia"`): convierte números a texto y descarta lateralidades inválidas.

### Fechas por campo (`ft`)

`ft` guarda cuándo se editó cada campo. Las rutas son:

- `f.<campo>` para cada texto;
- `checks.<clave>` para cada casilla;
- `cat` para el ojo de la catarata;
- `proc.<id>.eye`, `proc.<id>.od`, `proc.<id>.oi`, `proc.<id>.desc_od` y `proc.<id>.desc_oi` para cada procedimiento (`desc`, una sola descripción de la 2.18.0, se sigue leyendo como la de cada ojo cubierto).

**Examen físico (2.18):** por ojo, AV, AVcc y PIO; los campos `od/oi_otro_examen` y `od/oi_otro_resultado` ya no están en el formulario ni en el PDF (si una atención antigua los tiene, se conservan en los datos y en el historial). La descripción de un procedimiento (FO, BMC) es **por ojo**: la del OD va en el PDF dentro del recuadro del examen del OD y la del OI en el del OI, como «FO: …» o «BMC: …». Con AO hay dos descripciones, una por ojo. La plantilla se ajustó con `scripts/plantilla-examen.mjs`.

Con `ft`, dos versiones de una misma atención se fusionan campo a campo (`src/core/merge.js`): en cada campo gana la edición más reciente. Las atenciones antiguas sin `ft` usan su `updated` para todos sus campos.

### Compatibilidad entre versiones (lector tolerante)

Mientras los PC no se actualicen todos a la vez, conviven versiones distintas. Al normalizar atenciones, fichas, perfiles y operativos **se conservan los campos que esta versión no conoce**, con claves seguras y valores de datos (`core/compat.js`, ADR 0012). Así un PC con una versión anterior no borra lo que agregó una más nueva. Un rol de perfil desconocido se conserva y no cuenta como médico.

### Migraciones de esquema

`src/core/migrations.js` define un paso por versión (`STEPS[n]` lleva de vN a vN+1). Para cambiar el formato:

1. agregar el paso;
2. subir `SCHEMA_VERSION`;
3. agregar una prueba.

Un registro de una versión **más nueva** que la app (creado por un PC ya actualizado) no se degrada:

- se guarda y sincroniza intacto;
- no se muestra ni se edita;
- la app pide recargar la página para actualizarse.

### Bitácora de auditoría

Colección `bitacora`, con un documento `b_<idAtención>` por atención:

```jsonc
{ "id": "b_amhz3k2a9x1", "atencionId": "amhz3k2a9x1", "updated": 1763150000000,
  "entries": [
    { "id": "e…", "at": 1763150000000, "tipo": "editada",       // creada | editada | eliminada
      "equipo": "Box 1", "equipoId": "pc3k9…",
      "autor": "Dra. Pérez", "autorId": "m_…",                   // quién (perfil), si se eligió
      "cambios": [ { "c": "f.od_pio", "a": "14", "d": "19" } ] } // campo, antes, después
  ] }
```

- **Cuándo se agrega:** cada guardado que cambia algo y cada eliminación agregan una entrada. Con el **guardado automático**, las ediciones seguidas de la misma persona y equipo (menos de 10 minutos entre una y otra) se **juntan** en una sola entrada: conserva el valor anterior de cada campo, toma el nuevo y anota `hasta`. Al sincronizar, de una entrada así gana su versión más completa.
- **Sincronización:** los documentos se sincronizan cifrados. Si dos PC agregan entradas a la vez, se unen sin perder ninguna.
- **Quién y desde dónde:** cada entrada guarda el **perfil** que registró (ver «Perfiles» más abajo) y el **equipo** (Ajustes → «Nombre de este equipo»).
- **Dónde se ve:** en el **Historial de cambios** de cada atención: «Dra. Pérez (Box 1)».
- **Respaldos:** incluyen la bitácora.

### Adjuntos

Cada atención puede tener archivos adjuntos (imágenes, PDF, Word…), con estos límites: 20 MB por archivo, y 60 MB y 30 archivos por atención (`core/attachments.js`).

- **Metadatos** (colección `adjuntos`): `{id: 'j…', atencionId, nombre, tipo, tamano, sha256, partes, created, updated}`. Se sincronizan como el tipo `adjunto` en el espacio de la especialidad. Eliminar uno deja una lápida.
- **Miniatura** (imágenes, desde la 2.15.0): `miniatura`, un JPEG de 96 px como data URL (≤ 16 000 caracteres), guardado con los metadatos. Así se ve en todos los equipos antes de que llegue el contenido. Se valida al leer (`isThumbnail`): solo `data:image/jpeg;base64,…`. A las imágenes adjuntadas antes se les crea al abrirlas en un equipo que tenga su contenido.
- **Contenido** (colección `adjuntos_datos`, IndexedDB): los bytes, que se leen de a uno. Viaja **cifrado** en partes de 192 KiB al espacio `<especialidad>-adjuntos`. Al bajarlo se verifica su SHA-256. Al eliminarlo, se reemplaza en el servidor por una lápida pequeña.
- **Fotos grandes** se reducen al adjuntar: lado mayor de 2400 px, en JPEG, solo si así pesan menos.
- **PDF con anexos** (`core/pdfAnexos.js`): la hoja, un índice, las imágenes como páginas y los PDF con sus páginas. Lo que no puede ser página (Word, Excel) va **incrustado** en el PDF, y se abre desde el panel de adjuntos del visor.
- Sin IndexedDB no se admiten adjuntos.
- El **respaldo diario del servidor no incluye su contenido** (ver OPERACION.md).

### Almacenamiento y crecimiento a varios años

Base IndexedDB `hhr-rondas-oftalmologia` (versión 2), un documento por elemento:

| Colección | Contenido |
|---|---|
| `atenciones` | una por episodio de atención |
| `pacientes` | una ficha por paciente |
| `bitacora` | historial de cambios, uno por atención (`b_<id>`) |
| `eliminadas` | marcas de eliminación `{id, t}` |

Cada guardado escribe solo los documentos que cambiaron, así que el costo no crece con los años de datos.

### Eliminaciones

La colección `eliminadas` guarda `{id, t}`. Ocupa unos pocos bytes por eliminación y no se poda: si un PC estuvo desconectado mucho tiempo, la eliminación igual le llega.

### Especialidades

Cada atención guarda `especialidad`. Las claves de `localStorage` llevan el prefijo de la especialidad (`oft_`), y en el servidor cada especialidad tiene su propio espacio (`<especialidad>/r/...`).

Para agregar la ronda de otra especialidad se crea su módulo en `src/specialties/<id>/` (ver [ESPECIALIDADES.md](ESPECIALIDADES.md)). Sus atenciones nunca se mezclan con las de oftalmología; las fichas de pacientes sí son comunes.

### Perfiles y operativos

Son catálogos compartidos y sincronizados.

- **Perfiles profesionales** `{id, nombre, rut, rol}`, con `rol` = `medico` | `enfermeria` | `tens` | `tecnologo` | `admision` | `otro`. Los perfiles de versiones anteriores (sin rol) son médicos. En el código y en la sincronización se siguen llamando «médicos» (`medicos`, tipo `medico`) por compatibilidad.
  - Solo los de rol médico aparecen en el menú **Médico** de la atención: elegirlo copia su nombre y RUT a la atención.
  - Todos sirven para indicar **quién registra**. La primera vez que se guarda en una sesión se pregunta, proponiendo el último perfil de ese equipo (`oft_usuario_v1`); el chip del encabezado permite cambiarlo. Si quien registra es médico, las atenciones nuevas lo traen como médico. Sin perfiles creados, no se pregunta nada.
- **Operativos:** elegir uno copia su nombre a la atención.

Editar o eliminar un perfil u operativo después no cambia las atenciones ya guardadas (ni sus PDF o Excel).

Los ids son deterministas: `m_` + huella del RUT (o del nombre) y `o_` + huella del nombre. Así, si dos PC crean el mismo perfil u operativo por separado, no se duplica. En el servidor, el id de un perfil viaja opaco (ver SINCRONIZACION.md).

Al abrir la app por primera vez con esta versión, los catálogos se completan con los médicos y operativos de las atenciones existentes.

## Otras claves de `localStorage`

| Clave | Contenido |
|---|---|
| `oft_borrador_v1` | Atención en edición (se restaura al reabrir). |
| `oft_procs_v1` | Lista configurada de procedimientos: `[{id, n, pio}]`. |
| `oft_medico_v1` | Último médico y operativo: `{n, r, op}`. |
| `oft_ajustes_v1` | `{pdfFlatten, pdfFooter, notaPie}`. |
| `oft_secreto_anon_v1` | Clave de seudonimización del equipo (64 caracteres hex). |
| `oft_eliminadas_v1` | (Antes de la 2.7.0: eliminaciones; ahora en IndexedDB.) |
| `oft_equipo_v1` | Identificador aleatorio de este equipo (bitácora). |
| `oft_reloj_v1` | Última hora del reloj lógico. |
| `oft_medicos_v1` | Perfiles de médico `[{id, nombre, rut, created, updated}]`. Se sincronizan. |
| `oft_operativos_v1` | Operativos `[{id, nombre, created, updated}]`. Se sincronizan. |
| `oft_sync_v1` | Sincronización activa: clave AES derivada, token, huella para el servidor y última sincronización. No guarda la contraseña. |
| `oft_usuario_v1` | Último perfil que registró en este equipo: `{id}`. |
| `oft_no_duplicados_v1` | Pares de fichas marcadas como personas distintas. |
| `oft_ultimo_uso_v1` | Último uso de la app (el chequeo aparece solo tras 7 días sin uso). |
| `oft_ultimo_respaldo_v1` | Último respaldo descargado en este equipo. |
| `oft_bloqueo_v1` | Bloqueo con PIN: `{v, iter, salt, hash, rsalt, rhash, minutes}`. Solo derivaciones PBKDF2-HMAC-SHA256 (20.000 iteraciones) del PIN y del código de recuperación; nunca el PIN. |
| `oft_bloqueo_intentos_v1` | Intentos fallidos de desbloqueo: `{fails, until}`. |
| `oft_errores_v1` | Registro local de errores (últimos 50: fecha, dónde, mensaje y pila acotados). No sale del equipo. |

**Modo práctica:** usa la base IndexedDB `hhr-rondas-oftalmologia-practica` y las mismas claves con el prefijo `practica:` (por ejemplo, `practica:oft_medicos_v1`). Así nunca toca los datos reales. Sus datos de ejemplo salen de `core/demo.js`, con los casos clínicos que aporta la especialidad (`casosDeEjemplo`).

## Respaldo (`respaldo_oftalmo_AAAA-MM-DD.json`)

```json
{ "app": "oftalmo-operativos", "v": 3, "version_app": "2.7.0", "exportado": "ISO-8601",
  "procs": [ ... ], "atenciones": [ ... ], "bitacora": [ ... ], "pacientes": [ ... ], "anonSecret": "…" }
```

Al importar, las atenciones y las fichas de pacientes que ya existen se **fusionan campo a campo**, igual que en la sincronización, y la bitácora se une. Se aceptan respaldos v1, v2 y v3. Los respaldos anteriores a la 2.9.0 no traen `pacientes`: las fichas se reconstruyen desde las atenciones.

**Con adjuntos** (desde la 2.15.0), el respaldo es un **ZIP** (`respaldo_oftalmo_AAAA-MM-DD.zip`, sin compresión) con `respaldo.json` (lo anterior, más `adjuntos`: los metadatos) y el contenido de cada adjunto en `adjuntos/<id>`. Al importar, entran los adjuntos que el equipo no tiene; su contenido solo se acepta si coincide con su huella SHA-256. Sin adjuntos, sigue siendo el JSON de siempre. Ojo: a diferencia del servidor, este archivo **no está cifrado**; guárdalo como cualquier documento clínico.

Se aceptan respaldos v1 (sin `anonSecret`). Al importar, si el equipo no tiene clave de seudonimización, adopta la del respaldo. Así los códigos coinciden entre equipos.

## Validación

| Nivel | Regla |
|---|---|
| Error (no guarda) | Falta nombre **y** RUT · falta la fecha |
| Advertencia | RUT con dígito verificador inválido (paciente o médico) · edad fuera de 0–120 o no entera · PIO fuera de 0–80 mmHg · fecha futura · catarata sin ojo · sexo desconocido |
| Confirmación | Ya existe una atención del mismo paciente (RUT o nombre) en la misma fecha |

## Nombres separados (v5)

Los datos demográficos agregan `paciente_apellido_paterno`, `paciente_apellido_materno` y `paciente_nombres`; el médico de una atención agrega los equivalentes con prefijo `medico_`. Perfiles y perfiles cifrados de cuentas agregan `apellido_paterno`, `apellido_materno`, `nombres`. Son opcionales para lectores de datos antiguos. El nombre completo se deriva de estos componentes al existir; si no, se conserva íntegro el texto legado. La migración no deduce apellidos y preserva `pacienteId`, incluso al ordenar un nombre sin RUT. Ver [Formularios GES e IPD](FORMULARIOS_GES_IPD.md).
