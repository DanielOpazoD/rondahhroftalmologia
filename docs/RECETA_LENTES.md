# Receta para lentes

Se abre desde **PDF → Receta para lentes** en una atención de oftalmología, con el mismo diálogo de revisión, descarga e impresión que GES e IPD.

## Plantilla

`src/specialties/oftalmologia/receta-plantilla.pdf` es una copia íntegra del archivo «receta rellenable.pdf» proporcionado por el usuario el 15 de noviembre de 2026. Es una página de 396 × 612 puntos, con trece campos de texto y un campo de firma digital vacío. SHA-256:

```text
c552a72947ef6039c48e90d4ac1d1d5c7f5af901b503221d2456fcd2cd71a9e9
```

El PDF se incluye en la aplicación para poder usarlo sin conexión. No se envían datos a un servicio externo para rellenarlo.

## Datos propuestos y campos manuales

| Campo del PDF | Contenido inicial |
| --- | --- |
| `paciente_nombre` | Apellido paterno, apellido materno y nombres del paciente. Las fichas antiguas sin componentes conservan su nombre registrado. |
| `paciente_rut` | RUT registrado; puede quedar vacío si el paciente no tiene RUT. |
| `paciente_edad` | Edad calculada desde el nacimiento a la fecha actual de Rapa Nui. Sin nacimiento válido, solo se propone la edad registrada si la atención es del mismo día. |
| `oftalmologo_nombre` | Apellidos y nombres del profesional de la atención. |
| `fecha` | Fecha actual del hospital (`Pacific/Easter`), impresa como día-mes-año. |
| `lejos_od`, `lejos_oi`, `lejos_dp` | Vacíos, para prescripción manual. |
| `cerca_od`, `cerca_oi`, `cerca_dp` | Vacíos, para prescripción manual. |
| `tabo_eje_od`, `tabo_eje_oi` | Vacíos, para ejes manuales. |
| `oftalmologo_firma` | Vacío. La aplicación no inserta firmas. |

Todos los valores propuestos se pueden corregir antes de generar el PDF. Los cambios pertenecen a esa emisión: no modifican la ficha ni el perfil del profesional. Al abrir otra atención o reabrir la receta se toman sus datos de nuevo.

La graduación nunca se infiere de AV, AVcc, diagnósticos, medicamentos o indicaciones. Se admite texto óptico libre; el signo menos Unicode se convierte a su equivalente ASCII sin perder el signo. Se avisa si un carácter no se puede representar o un texto no cabe, en vez de eliminarlo o cortarlo.

## Salida y protección

La descarga conserva los trece campos de texto editables y el campo de firma original vacío. «Imprimir» muestra el PDF local y solicita el diálogo de impresión del navegador; también permite descargar ese mismo documento o volver a corregirlo. La aplicación no guarda los valores clínicos del diálogo en el registro de accesos.

Se requiere permiso de edición clínica. El bloqueo del equipo o un cambio de cuenta cierra el formulario y la vista previa, y revoca la URL temporal del PDF. En modo práctica la descarga lleva el prefijo `PRACTICA_`. El piloto ORL no incluye esta plantilla ni ofrece la opción.
