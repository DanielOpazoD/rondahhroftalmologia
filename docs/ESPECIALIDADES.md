# Especialidades

La aplicación tiene dos partes:

- **Plataforma** (`src/core`, `src/storage`, `src/sync`, `src/ui`, `src/lib`): común a todas las especialidades. Incluye:
  - sincronización cifrada, fusión campo a campo y almacenamiento;
  - migraciones e historial;
  - médicos, operativos, pacientes e interfaz.
- **Especialidad** (`src/specialties/<id>/`): lo clínico. Incluye:
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
| `index.js` | Reexporta todo lo anterior |
| `formulario.html` | Parte clínica del formulario de atención |
| `plantilla.pdf` | Hoja oficial con campos rellenables |

`src/specialties/contrato.js` define lo que toda especialidad debe tener y lo verifica:

- campos que usa la plataforma;
- claves únicas y seguras;
- etiquetas para cada campo;
- funciones requeridas;
- campos presentes en el formulario.

**El build se detiene** si una especialidad no cumple el contrato.

## Agregar una especialidad (p. ej. otorrinolaringología)

1. Copia `src/specialties/oftalmologia/` a `src/specialties/otorrino/`.
2. En `config.js`, cambia `ESPECIALIDAD` (`id: 'otorrino'`, `prefijo: 'otr_'`) y adapta catálogos, procedimientos, lados (p. ej. `['OD', 'OI', 'Bilateral']` para oídos), medidas y campos.
3. Adapta `formulario.html`, `plantilla.pdf` (con los nombres de campo que use `pdf.js`), la nota y los reportes.
4. Construye y verifica:

   ```bash
   ESPECIALIDAD=otorrino npm run build
   ```

   ```bash
   npm test
   ```

5. Publica como sitio aparte o en otra ruta. Los datos no se mezclan:
   - en el servidor, cada especialidad tiene su espacio (`otorrino/r/...`);
   - en el navegador, cada una usa su prefijo y su propia base IndexedDB;
   - se puede usar otra contraseña con `SYNC_TOKEN_SHA256_OTORRINO`.

## Salidas congeladas

`tests/golden.test.js` congela las salidas de oftalmología: nota, Excel de estadística, exportación seudonimizada y campos del PDF. Cualquier refactor que las cambie, aunque sea un carácter, hace fallar las pruebas. Si un cambio de salida es intencional:

```bash
UPDATE_GOLDEN=1 npm test
```

Después revisa el diff de `tests/golden/`.
