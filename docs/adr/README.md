# Registro de decisiones de arquitectura (ADR)

Cada ADR explica una decisión de fondo: el contexto, qué se decidió, sus consecuencias y qué se descartó. Antes de cambiar algo de esto, lee su ADR. Si la decisión cambia, escribe un ADR nuevo que la reemplace (no se borran los anteriores).

| # | Decisión | Estado |
|---|---|---|
| [0001](0001.md) | Un solo archivo HTML, sin framework, que funciona sin conexión | Aceptada |
| [0002](0002.md) | Cifrado de extremo a extremo con contraseña del equipo generada | Aceptada |
| [0003](0003.md) | Fusión campo a campo con fechas por campo y reloj lógico | Aceptada |
| [0004](0004.md) | Huella de contenido para detectar conflictos con la misma versión | Aceptada |
| [0005](0005.md) | Ids opacos en el servidor para ids derivados de datos personales | Aceptada |
| [0006](0006.md) | Sincronización incremental con índice de cambios | Aceptada |
| [0007](0007.md) | El paciente como unidad e identidad por RUT | Aceptada |
| [0008](0008.md) | La especialidad como módulo con contrato | Aceptada |
| [0009](0009.md) | HTML seguro por construcción | Aceptada |
| [0010](0010.md) | Bloqueo con PIN como protección de pantalla | Aceptada |
| [0011](0011.md) | Modo práctica con almacenamiento aislado | Aceptada |

Plantilla para una nueva: **Estado** (Propuesta / Aceptada / Reemplazada por ADR N), **Contexto**, **Decisión**, **Consecuencias** y **Alternativas descartadas**.
