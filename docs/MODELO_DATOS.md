# Modelo de datos

## Atención (esquema v3)

Se guarda en `localStorage["oft_atenciones_v1"]` como un arreglo. La clave conserva el nombre de la v1 para no perder datos.

```jsonc
{
  "v": 3,                          // versión de esquema
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
- `normalizeRecord()` acepta registros v1, v2 o incompletos y los lleva a v3 sin perder datos (los antiguos quedan con `especialidad: "oftalmologia"`): convierte números a texto y descarta lateralidades inválidas.

### Fechas por campo (`ft`)

`ft` guarda cuándo se editó cada campo. Las rutas son:

- `f.<campo>` para cada texto;
- `checks.<clave>` para cada casilla;
- `cat` para el ojo de la catarata;
- `proc.<id>.eye`, `proc.<id>.od` y `proc.<id>.oi` para cada procedimiento.

Con `ft`, dos versiones de una misma atención se fusionan campo a campo (`src/core/merge.js`): en cada campo gana la edición más reciente. Las atenciones antiguas sin `ft` usan su `updated` para todos sus campos.

### Especialidades

Cada atención guarda `especialidad`. Las claves de `localStorage` llevan el prefijo de la especialidad (`oft_`), y en el servidor cada especialidad tiene su propio espacio (`<especialidad>/r/...`).

Para agregar la ronda de otra especialidad hay que crear su propia configuración en `src/config/catalogs.js`: `ESPECIALIDAD` (id, nombre, prefijo), catálogos clínicos y plantilla PDF. Sus datos nunca se mezclan con los de oftalmología.

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
| `oft_eliminadas_v1` | Atenciones eliminadas, `{id: fecha ms}`: propagan la eliminación a los otros PC. |
| `oft_medicos_v1` | Perfiles de médico `[{id, nombre, rut, created, updated}]`. Se sincronizan. |
| `oft_operativos_v1` | Operativos `[{id, nombre, created, updated}]`. Se sincronizan. |
| `oft_sync_v1` | Sincronización activa: clave AES derivada, token, huella para el servidor y última sincronización. No guarda la contraseña. |

## Respaldo (`respaldo_oftalmo_AAAA-MM-DD.json`)

```json
{ "app": "oftalmo-operativos", "v": 2, "version_app": "2.0.0", "exportado": "ISO-8601",
  "procs": [ ... ], "atenciones": [ ... ], "anonSecret": "…" }
```

Se aceptan respaldos v1 (sin `anonSecret`). Al importar, si el equipo no tiene clave de seudonimización, adopta la del respaldo. Así los códigos coinciden entre equipos.

## Validación

| Nivel | Regla |
|---|---|
| Error (no guarda) | Falta nombre **y** RUT · falta la fecha |
| Advertencia | RUT con dígito verificador inválido (paciente o médico) · edad fuera de 0–120 o no entera · PIO fuera de 0–80 mmHg · fecha futura · catarata sin ojo · sexo desconocido |
| Confirmación | Ya existe una atención del mismo paciente (RUT o nombre) en la misma fecha |
