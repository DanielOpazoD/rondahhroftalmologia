# Operación del servidor

El servidor (Netlify) solo guarda datos **cifrados** en los equipos. Esta guía cubre las cuentas de usuario, los respaldos y qué hacer si algo falla.

## Cuentas de usuario (desde la 2.16)

Diseño completo: [ADR 0014](adr/0014.md).

**Activarlas (una vez):**
1. En un PC que ya sincroniza con la contraseña del equipo, ve a **Ajustes → Cuentas de usuario → Activar cuentas de usuario**.
2. Escribe tu RUT, nombre y profesión: serás el **primer administrador**.
3. La app se recarga y pide entrar. Tu clave inicial es tu **RUT sin dígito verificador** (por ejemplo, para 17.752.753-K: `17752753`). Al entrar, crea tu clave personal: al menos 8 caracteres, con una mayúscula, un número y un símbolo (por ejemplo ! ? # . -). Si tu clave es anterior a esta regla, la app te pide cambiarla al entrar con conexión.

Desde ese momento, **todos los PC** piden RUT y clave, y la contraseña del equipo deja de servir para sincronizar. **Guárdala igual**: es la llave de respaldo de los datos y la que permite recuperar un administrador.

**Día a día (Ajustes → Usuarios, solo administradores):**
- **Nuevo usuario** o **Crear desde perfiles**: la clave inicial es su RUT sin dígito verificador y vence en 24 horas: entrégala cuando la persona vaya a entrar.
- **Olvidó su clave / clave inicial vencida:** «Restablecer clave» (ícono del candado) la vuelve a la inicial.
- **Ya no trabaja aquí:** «Desactivar». Su sesión se corta de inmediato. Lo que registró se conserva.
- Siempre debe quedar al menos un administrador activo.
- **5 intentos fallidos** bloquean la cuenta 15 minutos (o hasta que un administrador la restablezca).

**Registro de accesos (Ajustes, solo administradores):** quién entró y cuánto tiempo, qué fichas y atenciones abrió, qué descargó y qué guardó. Se consulta por rango de fechas (hasta 62 días) y se descarga a Excel.

### Recuperar un administrador
Si **nadie** puede entrar como administrador (claves olvidadas), con la contraseña del equipo y un token personal de Netlify:

```bash
NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/recover-admin.mjs 17.752.753-K
```

- El script pide la contraseña del equipo por teclado y comprueba que abre los datos de las cuentas.
- La cuenta de ese RUT queda como administradora activa, con la clave inicial.
- Si el RUT no tiene cuenta, agrega el nombre entre comillas para crearla: `… recover-admin.mjs 17.752.753-K "Nombre Apellido"`.
- Queda en el registro de accesos.

## Respaldos diarios automáticos

- La función programada `netlify/functions/backup.mjs` corre **una vez al día** (`@daily`, hora UTC).
- Copia todas las versiones guardadas del almacén `hhr-rondas` al almacén `hhr-rondas-respaldos`, en **un documento por día** (`AAAA-MM-DD.json`).
- Se conservan **30 días**.
- Lo copiado sigue cifrado: un respaldo tampoco se puede leer sin la contraseña del equipo.
- Cada ejecución deja en los logs de la función una línea `{"fn":"respaldo","dia":…,"claves":…,"borrados":[…]}`. En Netlify: *Logs → Functions → backup*.

**Adjuntos** (fotos, PDF, Word): su contenido se respalda aparte, de forma **incremental**, con la función `backup-adjuntos`, que corre **cada hora**. Como el contenido de un adjunto no cambia, cada parte se copia una sola vez (a `adjuntos/…` en el mismo almacén de respaldos). Cada ejecución copia lo que alcanza en 20 s y la siguiente continúa, así que un volumen grande se pone al día en algunas horas. El contenido de un adjunto eliminado se conserva 30 días y luego se borra. Sus logs: `{"fn":"respaldo-adjuntos","copiadas":…,"pendientes":…}`.

**Cuentas y registro de accesos:** las cuentas (sin datos en claro) van en el respaldo diario. El registro de accesos se copia de forma incremental con la misma función horaria (a `auditoria/…`). Al restaurar, las cuentas que falten se reponen sin pisar las vigentes, y también los eventos del registro que falten.

Los respaldos del servidor **complementan**, no reemplazan, la copia local de cada PC ni el «Descargar respaldo» de Ajustes. Además, cada PC con la sincronización activa tiene una copia completa de los datos.

## Restaurar un respaldo

Se necesita un token personal de Netlify (*User settings → Applications → Personal access tokens*) y el id del sitio (`94761394-b6dd-4832-912c-db6180b775af`).

```bash
NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/restore-backup.mjs --list
```

```bash
NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/restore-backup.mjs 2026-11-20 --dry-run
```

```bash
NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/restore-backup.mjs 2026-11-20
```

- `--list` muestra los días disponibles.
- `--dry-run` dice cuántas versiones y partes de adjuntos restauraría, sin escribir nada.
- Restaurar también repone el contenido de los adjuntos que falte en el servidor.
- Restaurar **no borra nada**: vuelve a escribir las versiones del respaldo. Si un elemento ya tiene una versión más nueva en el servidor, sigue ganando esa.
- Después, **recarga la app en los PC**: la primera sincronización al abrir pide la lista completa y recibe lo restaurado.

## Si algo falla

| Síntoma | Qué revisar |
|---|---|
| «Sincronización no configurada en el servidor» | Falta la variable `SYNC_TOKEN_SHA256` en Netlify (ver SINCRONIZACION.md). |
| «Contraseña del equipo incorrecta» | El PC usa otra contraseña que el servidor. |
| «RUT o clave incorrectos» / «Cuenta bloqueada» | Revisar el RUT. Tras 5 intentos fallidos, la cuenta se bloquea 15 minutos; un administrador puede restablecer la clave. |
| «Tu clave inicial venció» | Un administrador debe restablecerla (Ajustes → Usuarios). |
| «Tu cuenta está desactivada» | Un administrador puede reactivarla. |
| Nadie puede entrar como administrador | Ver «Recuperar un administrador». |
| «Demasiados intentos» (`429`) | Muchos intentos fallidos desde la misma red: esperar 15 minutos. Los equipos con la contraseña correcta no se bloquean. |
| «Esta versión de la app es antigua» (`426`) | Recargar la app en ese PC. |
| Un PC no guarda («cambios que no se pudieron guardar») | Almacenamiento del navegador lleno: liberar espacio o descargar un respaldo. |
| Errores en un PC | Ajustes → Registro de errores → Copiar, y enviarlo a soporte. |
| Diagnóstico en el servidor | Logs de la función `sync`: una línea JSON por solicitud con `reqId`, acción, estado y código, sin datos. La respuesta trae `x-request-id` para ubicar la línea. |
