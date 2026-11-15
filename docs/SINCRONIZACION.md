# Sincronización cifrada entre equipos

Permite que varios PC (por ejemplo, 4 en un operativo) trabajen al mismo tiempo y tengan siempre la base completa. El servidor (Netlify) **no puede leer los datos**.

## Cómo funciona

```
 PC 1 ─┐                                   ┌─ PC 3
       │  cifrado AES-256-GCM en el PC     │
 PC 2 ─┼──►  Netlify Function /api/sync  ◄─┼─ PC 4
       │      + Netlify Blobs              │
       │   (solo: id, versión, cifrado)    │
```

- **Contraseña del equipo:** es la misma en todos los PC. Se escribe una vez en cada uno y **nunca se envía**. La genera la app (100 bits aleatorios, formato `XXXXX-XXXXX-XXXXX-XXXXX`). No se aceptan contraseñas elegidas a mano, porque se podrían adivinar probando diccionarios contra los datos cifrados.
- **Derivación de claves:** de la contraseña se deriva una clave maestra (PBKDF2-SHA256, 310 000 iteraciones). De ella salen, por separado (HKDF):
  - una **clave de cifrado** AES-256, que nunca sale del PC;
  - un **token de acceso** al servidor. El servidor solo guarda su huella SHA-256 (variable `SYNC_TOKEN_SHA256`). Conocer el token no revela la clave de cifrado.
- **Cifrado:** cada atención se cifra entera (nombre, RUT, examen, etc.) con un IV aleatorio. Va «atada» a su id y versión, así que el servidor no puede cambiarla de lugar ni de fecha sin que se note. Las eliminaciones también viajan cifradas.
- **Qué ve Netlify:** un id aleatorio por atención, la fecha de su última modificación y el texto cifrado. También ve la IP y la hora de cada sincronización.

### Cuándo se sincroniza

- al abrir la app;
- 4 segundos después de guardar, eliminar o importar;
- cada 2 minutos;
- al volver la conexión o al volver a la pestaña;
- con el botón «Sincronizar ahora».

### Varios PC editando al mismo paciente (fusión campo a campo)

Cada atención guarda la fecha en que se editó **cada campo**: cada texto, cada casilla, el ojo de cada procedimiento y cada PIO.

- **Campos distintos:** si dos PC editan la misma atención a la vez, por ejemplo uno anota la PIO y otro un diagnóstico, se conservan los dos datos.
- **El mismo campo:** solo si ambos editan el mismo campo queda la edición más reciente.
- **Antes de subir:** si el servidor tiene una versión más nueva de esa atención, el PC la baja y la fusiona primero. Así nunca sobrescribe lo que otro grabó.
- **Atención abierta:** si llegan datos de otro PC para la atención que se está editando, se incorporan al formulario sin perder lo que se está escribiendo.
- **Mismo paciente en una atención nueva:** si un PC crea una atención nueva para un paciente que ya tiene una ese día (mismo RUT, o mismo nombre si no hay RUT), la app avisa al escribir el RUT y ofrece «Continuar en esa atención»: lo escrito se agrega a la existente. Al guardar también ofrece «Combinar» o «Guardar aparte».

La fusión ocurre dentro de cada PC, antes de cifrar: el servidor sigue sin poder leer nada.

#### Garantías y cómo se aseguran

- **Convergencia.** Todos los PC terminan con los mismos datos, aunque sincronicen a la vez.
  - Cada versión subida lleva una **huella de su contenido**: un HMAC con la clave del equipo, que el servidor no puede calcular.
  - Si dos PC fusionan al mismo tiempo y producen el mismo número de versión con distinto contenido, la huella lo revela. Bajan, fusionan y suben una versión nueva.
  - Lo prueba `tests/convergence.test.js`: varios PC sincronizan en paralelo en órdenes aleatorios reproducibles. `SEMILLAS=200 npm test` corre 200 escenarios.
- **Causalidad.** Una edición hecha *después* de recibir otra siempre gana, aunque el reloj del PC esté atrasado. La hora de cada edición sale de un reloj lógico (`src/core/clock.js`): la hora del PC, pero nunca anterior a la última recibida de otros equipos.
- **Reloj desajustado.** Si la hora del PC difiere más de 3 minutos de la del servidor, la app avisa para corregirla. Solo importa al desempatar ediciones *simultáneas* del mismo campo.

### Sin conexión
- **Sin internet:** cada PC sigue guardando localmente. Al volver la conexión, sube y baja lo pendiente.
- **Uso sin conexión desde la web:** una vez abierta la app desde la dirección de Netlify, el navegador la guarda en caché (*service worker*) y se puede abrir sin internet. En Chrome o Edge también se puede **instalar como app** (icono ⊕ en la barra de direcciones).

## Puesta en marcha (una vez)

**Estado actual (producción):**

- **Dirección:** https://hhr-rondas.netlify.app (proyecto Netlify `hhr-rondas`).
- **Despliegue:** automático en cada push a `main` del repositorio `DanielOpazoD/rondahhroftalmologia`.
- **Servidor:** la variable `SYNC_TOKEN_SHA256` ya está configurada.
- **Contraseña del equipo:** se generó sin mostrarse en ningún registro y se guardó en el Escritorio del PC de configuración, en el archivo `HHR_Rondas_CONTRASENA_EQUIPO.txt`. Guárdala en un lugar seguro y borra ese archivo.

**En cada PC (los 4):**

1. Abre https://hhr-rondas.netlify.app en Chrome o Edge. Opcionalmente, instálala como app (icono ⊕ en la barra de direcciones).
2. Ve a **Ajustes → Sincronización entre equipos**, escribe la contraseña del equipo y presiona **Activar en este PC**.
3. Comprueba que arriba a la derecha aparezca **Sincronizado**, con el punto verde.

**Configurar desde cero** (otro sitio u otra contraseña):

1. Publica el repositorio en Netlify. La configuración ya está en `netlify.toml`.
2. En un PC, ve a **Ajustes → Generar → Activar**.
3. En *Configuración del servidor*, copia el valor. En Netlify → *Site configuration → Environment variables* crea `SYNC_TOKEN_SHA256` con ese valor y vuelve a publicar.

### Cambiar la contraseña

Por ejemplo, si se filtró:

1. Genera una nueva contraseña en un PC que tenga todos los datos.
2. Actualiza `SYNC_TOKEN_SHA256` y vuelve a publicar.
3. En Netlify → *Blobs*, borra el almacén `hhr-rondas` (o solo las claves `oftalmologia/…`).
4. Reactiva la sincronización en cada PC con la contraseña nueva. Cada PC vuelve a subir lo que tiene.

## Seguridad: lo que conviene saber

- **Contraseña perdida:** si se pierde, nadie (tampoco Netlify) puede descifrar el servidor. Los datos de cada PC siguen ahí.
- **Contraseña filtrada:** quien la tenga y conozca la dirección puede leer los datos. Trátala como una clave de acceso a fichas clínicas.
- **Datos en cada PC:** se guardan sin cifrar en el navegador (como en la versión sin sincronización). Protege los PC con sesión de usuario y contraseña.
- **Normativa:** los datos de salud cifrados siguen siendo datos personales. Informa a TI o a protección de datos del Servicio de Salud.
- **Seguridad del navegador:** la página solo puede conectarse a su propio servidor (`connect-src 'self'`) y no carga nada de terceros.

## Probar en local sin Netlify

```bash
npm run build
```

```bash
SYNC_TOKEN_SHA256=<valor> npm run dev
```

Abre `http://localhost:8787` y `http://127.0.0.1:8787`: son dos orígenes distintos, así que funcionan como dos PC. El servidor local guarda en memoria y se borra al cerrarlo.

## Detalles técnicos

| Pieza | Archivo |
|---|---|
| Cifrado y derivación de claves | `src/sync/crypto.js` |
| Reglas de sincronización (puras) | `src/sync/protocol.js` |
| Cliente HTTP y ciclo de sincronización | `src/sync/client.js` |
| Servidor (lógica) | `src/sync/server.js` |
| Función de Netlify | `netlify/functions/sync.mjs` |
| Interfaz | `src/ui/syncController.js` |
| Tests (4 PC convergen; el servidor no ve datos) | `tests/sync.test.js` |

Almacenamiento (Netlify Blobs, almacén `hhr-rondas`): `<especialidad>/r/<id>/<versión>.<huella>` → `{iv, ct}`. La huella es un HMAC de 16 hex de id + versión + contenido, con una subclave derivada de la clave del equipo; no permite comparar registros ni versiones entre sí. Las versiones antiguas no la tienen. Al escribir una versión nueva se borran las anteriores.

**Qué se sincroniza:** todo viaja cifrado y el servidor no distingue un tipo de otro. Cada elemento lleva su tipo dentro del contenido cifrado:

| Tipo | Contenido |
|---|---|
| `atencion` | la atención completa |
| `medico` | perfil de médico: nombre y RUT |
| `operativo` | nombre del operativo o ronda |
| `bitacora` | historial de cambios de una atención; dos PC se fusionan por unión de entradas |
| `paciente` | ficha del paciente (datos demográficos); se fusiona campo a campo |

**Separación por especialidad:** las solicitudes llevan `?esp=oftalmologia`, y cada especialidad tiene su propio espacio en el servidor. Las **fichas de pacientes** van en un espacio común, `?esp=pacientes`, porque un mismo paciente puede atenderse en varias especialidades. Cada sincronización hace primero las fichas y después el espacio de la especialidad. Para dar a una especialidad su propia contraseña, define `SYNC_TOKEN_SHA256_<ESPECIALIDAD>` (por ejemplo `SYNC_TOKEN_SHA256_OFTALMOLOGIA`). Si no existe, se usa `SYNC_TOKEN_SHA256`.

API (todas con `Authorization: Bearer <token>`):

- `GET /api/sync/list`
- `POST /api/sync/get`
- `POST /api/sync/put`

Cada solicitud admite hasta 200 elementos.
