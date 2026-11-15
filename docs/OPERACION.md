# Operación del servidor

El servidor (Netlify) solo guarda datos **cifrados** en los equipos. Esta guía cubre los respaldos y qué hacer si algo falla.

## Respaldos diarios automáticos

- La función programada `netlify/functions/backup.mjs` corre **una vez al día** (`@daily`, hora UTC).
- Copia todas las versiones guardadas del almacén `hhr-rondas` al almacén `hhr-rondas-respaldos`, en **un documento por día** (`AAAA-MM-DD.json`).
- Se conservan **30 días**.
- Lo copiado sigue cifrado: un respaldo tampoco se puede leer sin la contraseña del equipo.
- Cada ejecución deja en los logs de la función una línea `{"fn":"respaldo","dia":…,"claves":…,"borrados":[…]}`. En Netlify: *Logs → Functions → backup*.

**No incluyen el contenido de los adjuntos** (fotos, PDF, Word): pueden pesar gigabytes y la función programada tiene poco tiempo. Ese contenido está en cada PC que sincroniza y en sus respaldos; los metadatos de los adjuntos sí se respaldan.

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
- `--dry-run` dice cuántas versiones restauraría, sin escribir nada.
- Restaurar **no borra nada**: vuelve a escribir las versiones del respaldo. Si un elemento ya tiene una versión más nueva en el servidor, sigue ganando esa.
- Después, **recarga la app en los PC**: la primera sincronización al abrir pide la lista completa y recibe lo restaurado.

## Si algo falla

| Síntoma | Qué revisar |
|---|---|
| «Sincronización no configurada en el servidor» | Falta la variable `SYNC_TOKEN_SHA256` en Netlify (ver SINCRONIZACION.md). |
| «Contraseña del equipo incorrecta» | El PC usa otra contraseña que el servidor. |
| «Demasiados intentos» (`429`) | Muchos intentos fallidos desde la misma red: esperar 15 minutos. Los equipos con la contraseña correcta no se bloquean. |
| «Esta versión de la app es antigua» (`426`) | Recargar la app en ese PC. |
| Un PC no guarda («cambios que no se pudieron guardar») | Almacenamiento del navegador lleno: liberar espacio o descargar un respaldo. |
| Errores en un PC | Ajustes → Registro de errores → Copiar, y enviarlo a soporte. |
| Diagnóstico en el servidor | Logs de la función `sync`: una línea JSON por solicitud con `reqId`, acción, estado y código, sin datos. La respuesta trae `x-request-id` para ubicar la línea. |
