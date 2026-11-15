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

## Atención (esquema v4)

Se guarda en **IndexedDB**, base `hhr-rondas-oftalmologia`, colección `atenciones`, con un documento por atención (`src/storage/repo.js`). Si IndexedDB no está disponible, se usa localStorage como respaldo. Al abrir esta versión por primera vez, las atenciones que versiones anteriores guardaban en `localStorage["oft_atenciones_v1"]` se migran a IndexedDB y se libera ese espacio.

```jsonc
{
  "v": 4,                          // versión de esquema
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
    "od_av": "20/40", "od_pio": "14", "od_hallazgos": "…",
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
    "fo": { "eye": "OI" }
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
- `proc.<id>.eye`, `proc.<id>.od` y `proc.<id>.oi` para cada procedimiento.

Con `ft`, dos versiones de una misma atención se fusionan campo a campo (`src/core/merge.js`): en cada campo gana la edición más reciente. Las atenciones antiguas sin `ft` usan su `updated` para todos sus campos.

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
      "cambios": [ { "c": "f.od_pio", "a": "14", "d": "19" } ] } // campo, antes, después
  ] }
```

- **Cuándo se agrega:** cada guardado que cambia algo y cada eliminación agregan una entrada inmutable.
- **Sincronización:** los documentos se sincronizan cifrados. Si dos PC agregan entradas a la vez, se unen sin perder ninguna.
- **Dónde se ve:** en el **Historial de cambios** de cada atención, con el nombre de cada equipo (Ajustes → «Nombre de este equipo»).
- **Respaldos:** incluyen la bitácora.

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

### Médicos y operativos

Son catálogos compartidos que se ofrecen como menú en el formulario. Elegir un médico copia su nombre y RUT a la atención, y elegir un operativo copia su nombre. Por eso, editar o eliminar un perfil después no cambia las atenciones ya guardadas (ni sus PDF o Excel).

Los ids son deterministas: `m_` + huella del RUT (o del nombre) y `o_` + huella del nombre. Así, si dos PC crean el mismo médico u operativo por separado, no se duplica.

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

## Respaldo (`respaldo_oftalmo_AAAA-MM-DD.json`)

```json
{ "app": "oftalmo-operativos", "v": 3, "version_app": "2.7.0", "exportado": "ISO-8601",
  "procs": [ ... ], "atenciones": [ ... ], "bitacora": [ ... ], "pacientes": [ ... ], "anonSecret": "…" }
```

Al importar, las atenciones y las fichas de pacientes que ya existen se **fusionan campo a campo**, igual que en la sincronización, y la bitácora se une. Se aceptan respaldos v1, v2 y v3. Los respaldos anteriores a la 2.9.0 no traen `pacientes`: las fichas se reconstruyen desde las atenciones.

Se aceptan respaldos v1 (sin `anonSecret`). Al importar, si el equipo no tiene clave de seudonimización, adopta la del respaldo. Así los códigos coinciden entre equipos.

## Validación

| Nivel | Regla |
|---|---|
| Error (no guarda) | Falta nombre **y** RUT · falta la fecha |
| Advertencia | RUT con dígito verificador inválido (paciente o médico) · edad fuera de 0–120 o no entera · PIO fuera de 0–80 mmHg · fecha futura · catarata sin ojo · sexo desconocido |
| Confirmación | Ya existe una atención del mismo paciente (RUT o nombre) en la misma fecha |
