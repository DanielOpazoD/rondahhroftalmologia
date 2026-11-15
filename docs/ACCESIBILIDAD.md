# Accesibilidad

## Lo que se prueba automáticamente (en cada cambio, en la CI)

- `e2e/accesibilidad.spec.js`: **axe-core**, sin infracciones WCAG 2.1 A/AA en todas las pestañas, diálogos, la pantalla de bloqueo y el modo práctica, en tema claro, oscuro y en celular. También prueba el teclado: saltar al contenido, flechas entre pestañas y errores asociados a su campo.
- `e2e/lector.spec.js`: el **árbol de accesibilidad**, que es lo que anuncia un lector de pantalla.
  - Pestañas con nombre y estado «seleccionada».
  - Botones con nombre.
  - Íconos decorativos ocultos: no se leen como «imagen».
  - Campos con su etiqueta, y el sexo con su nombre completo.
  - Errores leídos como descripción del campo.
  - Estado del guardado automático anunciado: «Guardando…» y «Guardada».
  - Diálogos y pantalla de bloqueo con nombre, y el foco en el PIN.

## Prueba manual con un lector de pantalla real

Las pruebas automáticas no reemplazan escuchar la app. Una vez por versión importante, conviene recorrer esto con **VoiceOver** (Mac: ⌘ + F5) o **NVDA** (Windows, gratuito):

1. Al abrir, el lector anuncia el título y la pestaña activa. Tab va primero a «Saltar al contenido».
2. En las pestañas, ← y → cambian de sección y se anuncia el nombre de cada una.
3. En una atención, cada campo se anuncia con su etiqueta. Un campo con error anuncia el error.
4. Al escribir el nombre, tras una pausa se anuncia «Guardada».
5. Los botones de solo ícono (nueva, copiar, PDF, candado) se anuncian por su nombre.
6. Los diálogos («¿Quién registra?», chequeo, PIN) se anuncian al abrirse, y Escape los cierra (salvo el bloqueo).
7. Con el equipo bloqueado, el foco queda en el PIN y no se puede llegar a nada detrás.

Anota lo que suene confuso y regístralo como mejora.
