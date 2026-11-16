# Formularios GES e IPD

Desde **Atención → PDF** se puede abrir la constancia GES o el **IPD · Proceso diagnóstico**. Ambos permiten revisar los datos, descargar el PDF y elegir **Imprimir**: se muestra el mismo PDF en un visor del navegador y se solicita su diálogo de impresión. Se conserva el botón Imprimir del visor y la descarga para los navegadores que limiten la impresión automática. Las plantillas y el catálogo se incluyen en el HTML y funcionan sin red.

Los formularios toman una copia de la atención visible. Las correcciones hechas allí no cambian la atención, la ficha ni el perfil. Bloquear el equipo o cambiar la sesión descarta el diálogo y su vista previa. Las firmas se completan en papel.

## IPD

- Servicio de Salud **Metropolitano Oriente** y establecimiento **Hospital Hanga Roa**, fijos.
- Paciente y profesional con **apellido paterno, apellido materno y nombres** separados. El materno puede quedar vacío. RUT, nacimiento y sexo se proponen desde la atención; se pueden corregir para esta emisión.
- Fecha y hora del informe: instante de apertura en **Pacific/Easter**. Cada dígito de día, mes, año, hora, RUT e historia clínica ocupa su casilla original.
- Confirmación de pertenencia a GES: **X en Sí**.
- Especialidad, unidad, historia clínica, folio y fecha límite de tratamiento son opcionales y parten vacíos.
- Problema GES y subgrupo se eligen explícitamente. Diagnóstico, fundamentos y tratamiento son de escritura libre; no se deducen de las casillas clínicas de la atención.
- Si un texto clínico no cabe con letra legible, se indica su continuación y se agrega el texto completo en hojas complementarias identificadas con paciente, profesional y fecha. Nunca se corta en silencio.

### Plantilla y catálogo

La plantilla proviene del formulario vacío que publica el Hospital Provincial del Huasco en la **página 16** de su [protocolo de ortodoncia y ortopedia dentomaxilofacial](https://www.hospitalprovincialdelhuasco.cl/web/wp-content/uploads/2017/08/protocolo-ortodoncia-y-ortopedia-dento-m%C3%A1xilo-facial.pdf). Se extrajo la imagen original de 1226 × 1612 píxeles y se centró en carta conservando su proporción; no se redibujaron sus textos ni casillas. La copia local `ipd-plantilla.pdf` tiene SHA-256 `6d3132e9cfd4e8a80ef50752db888f0313ad137bbe889c2e7aa2e6eb2caa8859`.

Los **90 títulos** y números provienen del [CodeSystem MINSAL TEI 0.2.3, publicado el 22-07-2026](https://interoperabilidad.minsal.cl/fhir/ig/tei/0.2.3/CodeSystem-cs-problema-ges-tei.html). El JSON fuente consultado el 15-11-2026 tiene SHA-256 `a55e221be9edadd654f8b89fa6be8a735a3ded3b7af8217de0cc80bd4668d830`. Las **áreas son una agrupación para navegar en esta app**, no una clasificación oficial de especialidades.

Subgrupos locales documentados en el **Anexo 3 del Manual de procedimientos SIGGES, MINSAL, 4ª versión (marzo 2009)**:

| Problema | Subgrupos de confirmación | Página |
|---|---|---|
| Tratamiento quirúrgico de cataratas | Catarata Izquierda; Catarata derecha; Catarata Bilateral | 141 |
| Vicios de refracción en personas de 65 años y más | Presbicia pura; Otros vicios de refracción | 143 |

[Fuente original MINSAL](http://www.bibliotecaminsal.cl/wp/wp-content/uploads/2016/03/30.pdf), [copia consultable del documento ministerial](https://es.scribd.com/document/1073089462/1-Manual-de-Procedimientos-4-Version-1). El servidor de Biblioteca MINSAL no respondió durante la consulta; se contrastó la transcripción del documento original con el flujo de la [guía MINSAL de vicios de refracción v2.2 (2016)](https://es.scribd.com/document/728795739/29-Vicios-de-Refraccion-v2-2) y el ejemplo de catarata bilateral de la [Circular IF/N°125 de la Superintendencia](https://www.superdesalud.gob.cl/normativa/571/articles-4745_recurso_1.pdf). Se normalizó la errata «Prebicie» a «Presbicia». Estas denominaciones no son una certificación de la parametrización actual de SIGGES. No se cargaron otras subdivisiones sin verificación; se permite escribir manualmente un subgrupo. Al cambiar de problema se limpia el subgrupo anterior.

## Nombres e identidad

Ingreso, Atención, perfiles y cuentas tienen campos separados. El nombre completo para listas, notas y exportaciones se compone **apellido paterno + apellido materno + nombres**. Los componentes de perfiles de cuenta se cifran junto al resto del perfil y se conservan al entrar sin conexión y al restaurar la sesión.

El esquema v5 conserva el nombre antiguo y el vínculo con la ficha: **no adivina apellidos**. Los registros anteriores muestran su texto original para que se complete la separación explícitamente. Para emitir un IPD se requiere apellido paterno y nombres del paciente y profesional; no se atribuye automáticamente el texto antiguo a ninguno de esos campos. No se modifica la autoría histórica.

Los componentes se sincronizan campo a campo y el nombre completo se vuelve a componer al fusionar, también si se quitó un apellido. La ficha conserva su id aunque se haya creado sin RUT. Para duplicados y conteo se usa ese vínculo cuando no hay RUT; se mantiene la regla previa del código seudónimo de las exportaciones.
