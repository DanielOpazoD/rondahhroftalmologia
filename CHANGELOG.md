# Cambios

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
