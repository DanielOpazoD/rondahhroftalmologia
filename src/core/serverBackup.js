/**
 * Estado del respaldo diario del servidor, en palabras para la app. El
 * servidor informa la hora del último (sync/backup.js, BACKUP_STATUS_KEY) y la
 * vista de sincronización lo muestra; un respaldo que dejó de correr ya no
 * pasa inadvertido.
 */
import { fmtDateTime } from './format.js';

/** Un respaldo diario más antiguo que esto se avisa (la función programada corre cada día). */
const BACKUP_STALE_MS = 48 * 3600_000;

/**
 * Último respaldo diario del servidor ('' si aún no se sabe).
 * @param {number | null | undefined} at
 * @param {number} [now]
 */
export function backupText(at, now = Date.now()) {
  if (at === undefined) return '';
  if (at === null) return ' El servidor aún no informa respaldos diarios.';
  const when = fmtDateTime(new Date(at));
  return now - at > BACKUP_STALE_MS
    ? ` ⚠ El último respaldo del servidor es del ${when}: revisa la función de respaldo en Netlify (docs/OPERACION.md).`
    : ` Último respaldo del servidor: ${when}.`;
}
