# Especialidades

La aplicación tiene dos partes:

- **Plataforma** (`src/core`, `src/storage`, `src/sync`, `src/ui`, `src/lib`): común a todas las especialidades. Incluye:
  - sincronización cifrada, fusión campo a campo y almacenamiento;
  - migraciones e historial;
  - médicos, operativos, pacientes e interfaz.
- **Especialidad** (`src/specialties/<id>/`): lo clínico. Hoy hay dos: `oftalmologia` (la publicada) y `orl` (piloto, solo se construye en la CI). Incluye:
  - catálogos, procedimientos y campos;
  - formulario;
  - plantilla PDF;
  - nota para la ficha;
  - Excel de estadística y exportación seudonimizada.

La plataforma ve la especialidad **solo** a través de `src/specialties/activa/`. ESLint lo exige: un import directo a `specialties/oftalmologia/` desde la plataforma es un error.

## Contenido de una especialidad

| Archivo | Contenido |
|---|---|
| `config.js` | Datos sin lógica: `ESPECIALIDAD` (id, nombre, prefijo), antecedentes, solicitados, diagnósticos, procedimientos por defecto, lados (`OJOS`), medidas por lado (`MEDIDAS_PROC`), campos (`TEXT_FIELDS`), etiquetas |
| `validacion.js` | `validarClinico(rec, warn, note)`: reglas clínicas propias |
| `clinica.js`, `nota.js`, `pdf.js`, `estadistica.js`, `reportes.js`, `seudonimizacion.js` | Lógica clínica y salidas |
| `ejemplos.js` | `casosDeEjemplo()`: casos clínicos inventados para el modo práctica |
| `index.js` | Reexporta todo lo anterior |
| `formulario.html` | Parte clínica del formulario de atención |
| `plantilla.pdf` | Hoja oficial con campos rellenables. **Opcional**: sin ella, `pdf.js` dibuja el PDF desde cero (como `orl`) |

`src/specialties/contrato.js` define lo que toda especialidad debe tener y lo verifica:

- campos que usa la plataforma;
- claves únicas y seguras;
- etiquetas para cada campo;
- funciones requeridas;
- campos presentes en el formulario.

**El build se detiene** si una especialidad no cumple el contrato.

## Agregar una especialidad

`src/specialties/orl/` es el ejemplo mínimo: parte de él, no de oftalmología.

1. Crea `src/specialties/<id>/` con los archivos de la tabla. La carpeta se llama como `ESPECIALIDAD.id`.
2. En `config.js` define `ESPECIALIDAD` (`id`, `nombre`, `prefijo` propio, p. ej. `'orl_'`), catálogos, procedimientos, lados (`OJOS`, p. ej. `['OD', 'OI', 'AO']` para oídos), medidas por lado (`MEDIDAS_PROC`, puede ser `[]`) y campos.
3. Usa las piezas comunes en vez de copiar las de oftalmología:
   - `core/estadistica.js`: filtro, operativos, edad y grupos etarios, ordenamiento, mediana;
   - `core/pseudonym.js`: códigos, limpieza de textos, generalización de fecha y edad;
   - `core/pdfTexto.js`: ajuste de líneas para dibujar un PDF;
   - `lib/xlsx.js`: tablas para Excel.
4. Escribe `formulario.html`. Hoy debe incluir también `cxBox`, `schBox`, `catBox` y `catSeg`, aunque queden vacíos (ver «Lo que encontró el piloto»).
5. Construye y verifica. Con otra especialidad, el build **no toca `dist/`** (el sitio publicado de oftalmología):

   ```bash
   ESPECIALIDAD=orl npm run build                      # escribe dist-orl/ (no se versiona)
   ESPECIALIDAD=orl node scripts/build.mjs --out /tmp/orl.html   # solo el HTML
   ```

   ```bash
   npm test   # tests/contrato.test.js revisa TODAS las carpetas de src/specialties/
   ```

6. Publica como sitio aparte o en otra ruta. Los datos no se mezclan:
   - en el servidor, cada especialidad tiene su espacio (`orl/r/...`);
   - en el navegador, cada una usa su prefijo y su propia base IndexedDB;
   - se puede usar otra contraseña con `SYNC_TOKEN_SHA256_ORL`.

## Piloto ORL (otorrinolaringología)

`src/specialties/orl/` es una especialidad mínima pero real: 6 antecedentes, 4 exámenes solicitados, 8 diagnósticos, 6 procedimientos por oído (OD/OI/AO) y un examen con otoscopía por oído, rinoscopía, orofaringe y audiometría (promedio tonal puro, dB). Tiene validación (audiometría −10 a 120 dB; hipoacusia sin audiometría), nota, Excel (Resumen, Atenciones, Prestaciones), exportación seudonimizada y casos de ejemplo.

- **PDF**: no hay hoja oficial de ORL, así que `orl/pdf.js` dibuja la hoja desde cero con pdf-lib (título, paciente, examen, diagnósticos, plan, firma y pie) y pasa a otra página si no cabe. No tiene `plantilla.pdf`: el build le entrega una plantilla vacía.
- **CI**: el job `calidad` construye `ESPECIALIDAD=orl` en un directorio temporal y verifica que el HTML tenga el formulario ORL y no el de oftalmología. No se publica en ninguna parte.
- **Pruebas**: `tests/orl.test.js` (contrato, ids que usa la interfaz, build, validación, nota, estadística, Excel, seudonimización y PDF) y `tests/contrato.test.js` (todas las especialidades).

### Qué probó

Sin tocar la interfaz, la app ORL se construye, abre, guarda atenciones, valida, copia la nota, descarga el PDF y muestra la estadística. Son genéricos y funcionaron tal cual:

- el cambio de especialidad en el build (`activa/` + `ESPECIALIDAD=<id>`), el contrato y el límite de ESLint;
- la separación de datos: prefijo, base IndexedDB y espacio del servidor por `ESPECIALIDAD.id`;
- el modelo de registro (`f`, `checks`, `proc` con lados de `OJOS`), la fusión entre equipos con `MEDIDAS_PROC = []` y la bitácora con `ETIQUETAS` / `ETIQUETAS_PROC`;
- la validación clínica propia (`validarClinico` + mensajes `data-msg`);
- la seudonimización (`core/pseudonym.js`, verificación de fugas, tabla de correspondencia), `lib/xlsx.js`, el pie de la nota y el modo práctica (`casosDeEjemplo`);
- el PDF: el contrato permite tanto rellenar una plantilla como dibujar desde cero.

### Lo que encontró el piloto (pendiente)

Supuestos de oftalmología que siguen en la plataforma. ORL los esquiva sin cambiarlos, porque la interfaz se edita en paralelo y `dist/` debe quedar idéntico:

1. **Formulario** (`ui/attentionView.js`): exige `#cxBox`, `#schBox`, `#catBox` y `#catSeg`, y usa claves fijas (`antecedente_cirugia`, `procedimiento_test_schirmer`, `diagnostico_catarata`). Lo ideal es que la especialidad declare qué casilla muestra qué campo.
2. **Catarata en el modelo**: `cat` (lateralidad de catarata) es un campo de la plataforma (`core/record.js`, `core/merge.js`, `core/audit.js`, «Catarata (ojo)»). Debería ser un dato de la especialidad.
3. **Medidas por lado = PIO**: los datos son genéricos (`MEDIDAS_PROC`), pero la marca se llama `pio` y la interfaz dibuja «PIO OD/OI … mmHg» fijo. Los lugares son `ui/attentionView.js`, `ui/settingsView.js`, la casilla «PIO» de `src/index.html` y `core/backup.js`. Al escribir una medida, el lado por defecto es `'AO'`. En ORL, si alguien marca «PIO» en un procedimiento desde Ajustes, esos valores se guardan pero no se fusionan entre equipos (`MEDIDAS_PROC = []`). La especialidad debería declarar sus medidas, con etiqueta y unidad (p. ej. umbral en dB por oído).
4. **Lados**: la lista se llama `OJOS`, la interfaz usa sus valores como etiqueta y dice «Ojo para …». Faltan etiquetas legibles por lado.
5. **Estadística** (`ui/statsView.js`): columnas «OD / OI / Ojos», KPI «Ojos» y gestiones fijas (GES, IC, Receta, Seguimiento, Alta). La forma del resultado de `computeStats()` es un contrato implícito que `contrato.js` no revisa. ORL devuelve la misma forma: sus `ojos` son oídos.
6. **Nombres fijos de oftalmología**:
   - título, cabecera y pie de `src/index.html`;
   - `APP.nombre` y `APP.id` en `config/catalogs.js` (ORL no usa `APP.nombre` en sus salidas);
   - nombres de archivo de `ui/exportView.js` (`estadistica_oftalmo_`, `pdf_oftalmo_`, `oftalmo_seudonimizado_`, «Estadística oftalmología»);
   - `respaldo_oftalmo_` en `ui/settingsView.js` y «Oftalmología HHR» en `ui/errorLog.js`;
   - `Hoja_Atencion_Oftalmologica.html` en el build y la caché `oftalmo-` de `public/sw.js`.

   La sal de `sync/crypto.js` también dice «oftalmo», pero cambiarla invalidaría las claves existentes: se deja.
7. **Piezas genéricas duplicadas**: `filterRecords`, `operativosOf`, `sortedEntries`, `ageGroupLabels`, `wrapText`… viven en `oftalmologia/` y el contrato exige que cada especialidad las exporte. Este PR las deja en `core/estadistica.js` y `core/pdfTexto.js` (las usa ORL). Migrar oftalmología a ellas cambia los bytes de `dist/` (comprobado), así que queda para un PR que regenere `dist/`; las pruebas golden cuidan que las salidas no cambien. Después, la plataforma podría importarlas directo y sacarlas de `REQUIRED_FUNCTIONS` (`proceduresDone` tampoco lo llama la plataforma).
8. **Pruebas**: en Node, `core/record.js`, `core/merge.js` y `core/audit.js` quedan ligados a la especialidad activa (oftalmología), así que las pruebas de ORL arman sus registros a mano. Una prueba en navegador de ORL necesitaría que `scripts/dev-server.mjs` sirva `dist-<id>/`.

Arreglado en este PR, porque es pequeño y genérico y no entra al paquete de oftalmología:

- la plantilla PDF es opcional;
- `ESPECIALIDAD=<id> npm run build` ya no sobrescribe `dist/`: escribe `dist-<id>/`.

## Salidas congeladas

`tests/golden.test.js` congela las salidas de oftalmología: nota, Excel de estadística, exportación seudonimizada y campos del PDF. Cualquier refactor que las cambie, aunque sea un carácter, hace fallar las pruebas. Si un cambio de salida es intencional:

```bash
UPDATE_GOLDEN=1 npm test
```

Después revisa el diff de `tests/golden/`.
