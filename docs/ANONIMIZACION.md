# Exportación seudonimizada (para análisis / IA)

## Qué es y qué no es

La exportación **seudonimiza** los datos: quita los identificadores directos y reemplaza a cada paciente por un código. **No es una anonimización absoluta.** Con la *tabla de correspondencia* (o con la clave del equipo y los RUT) se puede volver a identificar a los pacientes. Por eso:

- Los datos seudonimizados se pueden usar para análisis con menor riesgo.
- La tabla de correspondencia es **dato personal sensible**: se guarda aparte y nunca se sube junto con los datos.
- Antes de subir datos a un servicio externo de IA, sigue la normativa vigente (Ley 19.628 y sus modificaciones, Ley 20.584) y las políticas del Servicio de Salud.

## Cómo se genera el código del paciente

```
codigo_paciente = "P-" + base32( HMAC-SHA256( clave_del_equipo, "rut:12345678-5" ) )[0..8]
```

- Se usa el RUT normalizado (sin puntos). Si no hay RUT, se usa el nombre normalizado (sin tildes, en minúsculas). El campo `base_codigo` indica cuál se usó.
- El **mismo paciente recibe el mismo código** en todas sus atenciones y en todas las exportaciones del equipo. Eso permite análisis longitudinal.
- Sin la clave, el código no permite recuperar el RUT. La clave es aleatoria (256 bits), se crea en la primera exportación y viaja en los respaldos. Así, al unir equipos, los códigos coinciden.
- **Generar una clave nueva** (Ajustes) hace que los códigos de exportaciones anteriores dejen de coincidir.
- El médico se reemplaza por `M-XXXXXX`, generado de la misma forma.

## Qué se elimina o transforma

| Dato | Tratamiento |
|---|---|
| Nombre, RUT, teléfono | Se eliminan |
| Médico (nombre, RUT) | Código `M-XXXXXX` |
| Fecha de atención | Opción: **mes** (por defecto), día relativo (0 = primer día del conjunto), exacta u omitir |
| Edad | Opción: **rango de 5 años** (por defecto) o exacta. 90 o más se agrupa como `90+` |
| Textos libres (motivo, hallazgos, plan, otros…) | Opción: **limpiar** (por defecto) o excluir |
| Antecedentes, diagnósticos, procedimientos, AV, PIO, lateralidad | Se conservan (son el objetivo del análisis) |
| Operativo | Se conserva |

### Limpieza de textos libres

Se reemplazan por marcadores:

- RUT con o sin puntos → `[RUT]`
- Secuencias de 8 o más dígitos (teléfonos, RUT sin dígito verificador) → `[NÚMERO]`
- Fechas tipo `03/05/2019` → `[FECHA]`
- Correos → `[EMAIL]`
- Cada palabra (3 o más letras) del nombre del paciente y del médico, sin importar tildes ni mayúsculas → `[NOMBRE]`

No toca la notación clínica (`AV 20/40`, `PIO 14`).

**Limitación:** no detecta nombres de terceros (por ejemplo, un familiar mencionado en el plan) ni direcciones. Revisa la vista previa o elige «Excluir textos libres» si hay dudas.

## Verificación automática

Antes de cada descarga, la app busca en la salida las palabras del nombre de cada paciente (4 o más letras), su RUT y su teléfono. Si encuentra algo, avisa con el valor enmascarado y pide confirmar. Una coincidencia puede ser un falso positivo, por ejemplo si un apellido coincide con el nombre del operativo o con una palabra común.

## Formatos

- **JSON para IA**: incluye `descripcion`, `opciones`, `diccionario` de variables y `atenciones` (estructura anidada por ojo y procedimiento). Es el formato recomendado para subir a un asistente de IA.
- **Excel seudonimizado**: hoja *Datos* (una fila por atención, con columnas 0/1 para antecedentes, solicitados y diagnósticos), *Prestaciones* (una fila por procedimiento) e *Info y diccionario*.

## Riesgo residual

En una población pequeña como la de Rapa Nui, la combinación de edad, sexo, fecha y diagnósticos poco frecuentes puede permitir reidentificar a alguien. Con las opciones por defecto (mes y rango de 5 años) el riesgo baja. Para conjuntos muy pequeños o diagnósticos raros, conviene además omitir la fecha y excluir los textos libres.
