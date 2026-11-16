# Constancia de información al paciente GES

En una atención de oftalmología, **PDF → Constancia GES** abre la revisión del formulario. Trae nombre y RUT del paciente y del profesional de esa atención, además del teléfono registrado. Se debe seleccionar una patología y la previsión; los datos restantes se pueden completar antes de descargar.

La institución es Hospital Hanga Roa, dirección Simón Paoa S/N y ciudad Rapa Nui. La comuna y región del paciente parten en Isla de Pascua y Quinta región. La fecha y hora de notificación corresponden al instante de apertura en **Pacific/Easter**, con los cambios de horario propios de Rapa Nui, y se pueden corregir.

La salida es un PDF aplanado de una página. Marca Confirmación y atención presencial. Las firmas quedan en blanco; no acredita por sí mismo la recepción o notificación del paciente. Si interviene un representante, se completan sus datos en el apartado correspondiente.

El diálogo no modifica la atención ni las fichas. Funciona sin conexión: la plantilla y la biblioteca PDF están incluidas en el HTML de la app. El modo práctica conserva el prefijo PRACTICA_ en la descarga. Con cuentas activadas, la emisión requiere permiso de edición clínica.

## Fuente de la plantilla

`src/specialties/oftalmologia/ges-plantilla.pdf` es una copia sin modificaciones del [formulario publicado por la Superintendencia de Salud](https://www.superdesalud.gob.cl/app/uploads/2024/05/formulario-paciente-ges.pdf), consultado el 15-11-2026. Corresponde al formato que la Superintendencia enlaza en sus [preguntas sobre la Circular IF/N°469](https://www.superdesalud.gob.cl/preguntas-frecuentes/preguntas-y-respuestas-sobre-ajustes-al-formulario-de-constancia-de-informacion-al-paciente-ges-y-al-proceso-de-notificacion/).

SHA-256: `40287e5924d006bdb23afd7b65ea8702ed16e7ac13a3682cebebc5bdcdc7da49`.

Se agrega texto dentro de las casillas originales, conservando el contenido impreso. Si un texto no cabe con letra de al menos 7 puntos, se pide revisarlo; no se corta en silencio.

## Catálogo oftalmológico

El selector muestra solo los títulos oficiales, sin números ni diagnósticos deducidos de otras casillas. Cada constancia lleva una sola patología:

- [Tratamiento quirúrgico de cataratas](https://www.superdesalud.gob.cl/orientacion-en-salud/tratamiento-quirurgico-de-cataratas/)
- [Vicios de refracción en personas de 65 años y más](https://www.superdesalud.gob.cl/orientacion-en-salud/vicios-de-refraccion-en-personas-de-65-anos-y-mas/)
- [Estrabismo en personas menores de 9 años](https://www.superdesalud.gob.cl/orientacion-en-salud/estrabismo-en-personas-menores-de-9-anos/)
- [Retinopatía diabética](https://www.superdesalud.gob.cl/orientacion-en-salud/retinopatia-diabetica/)
- [Desprendimiento de retina regmatógeno no traumático](https://www.superdesalud.gob.cl/orientacion-en-salud/desprendimiento-de-retina-regmatogeno-no-traumatico/)
- [Trauma ocular grave](https://www.superdesalud.gob.cl/orientacion-en-salud/trauma-ocular-grave/)
- [Retinopatía del prematuro](https://www.superdesalud.gob.cl/orientacion-en-salud/retinopatia-del-prematuro/)

La opción **Imprimir** abre el PDF visible y solicita el diálogo de impresión del navegador. El formulario de revisión usa una cuadrícula compacta en escritorio.

El IPD y la separación de nombres se describen en [Formularios GES e IPD](FORMULARIOS_GES_IPD.md).
