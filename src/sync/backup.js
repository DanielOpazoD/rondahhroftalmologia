/**
 * Respaldos diarios del servidor de sincronización (ADR 0013).
 *
 * Una vez al día (función programada de Netlify) se copian TODAS las
 * versiones guardadas (`<espacio>/r/…`) a un almacén aparte, en un solo
 * documento por día: `<AAAA-MM-DD>.json` → { creado, claves: {clave: valor} }.
 * Se conservan KEEP_DAYS días.
 *
 * Lo que se copia ya está CIFRADO en los equipos: el respaldo tampoco se
 * puede leer sin la contraseña del equipo. No se copian las marcas del índice
 * de cambios (`/c/`), que se reconstruyen solas, ni los contadores de intentos.
 */

export const KEEP_DAYS = 30;
const VERSION_KEY = /^[a-z][a-z0-9-]{1,39}\/r\//;
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * @typedef {{
 *   list: (o?: {prefix?: string}) => Promise<{blobs: {key: string}[]}>,
 *   get: (key: string, o?: {type: 'json'}) => Promise<any>,
 *   setJSON: (key: string, v: unknown) => Promise<unknown>,
 *   delete: (key: string) => Promise<unknown>,
 * }} BlobStore
 */

/** «2026-11-16» de una fecha (UTC). @param {number} t */
export const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Hace el respaldo del día y borra los de más de `keepDays` días.
 * @param {{source: BlobStore, target: BlobStore, now?: number, keepDays?: number}} o
 * @returns {Promise<{dia: string, claves: number, borrados: string[]}>}
 */
export async function dailyBackup({ source, target, now = Date.now(), keepDays = KEEP_DAYS }) {
  const { blobs } = await source.list();
  /** @type {Record<string, unknown>} */
  const claves = {};
  for (const { key } of blobs) {
    if (!VERSION_KEY.test(key)) continue;
    const v = await source.get(key, { type: 'json' });
    if (v !== null && v !== undefined) claves[key] = v;
  }
  const dia = dayOf(now);
  await target.setJSON(`${dia}.json`, { creado: new Date(now).toISOString(), claves });
  return { dia, claves: Object.keys(claves).length, borrados: await prune(target, now, keepDays) };
}

/**
 * Borra los respaldos más antiguos que `keepDays` días.
 * @param {BlobStore} target
 * @param {number} now
 * @param {number} keepDays
 */
async function prune(target, now, keepDays) {
  const limit = dayOf(now - keepDays * 24 * 3600 * 1000);
  const { blobs } = await target.list();
  const old = blobs.map((b) => b.key).filter((k) => DAY_RE.test(k) && /** @type {string} */ (DAY_RE.exec(k)?.[1]) < limit);
  for (const k of old) await target.delete(k);
  return old;
}

/**
 * Días con respaldo disponible, del más reciente al más antiguo.
 * @param {BlobStore} target
 * @returns {Promise<string[]>}
 */
export async function listBackups(target) {
  const { blobs } = await target.list();
  return blobs
    .map((b) => DAY_RE.exec(b.key)?.[1])
    .filter(/** @returns {d is string} */ (d) => typeof d === 'string')
    .sort()
    .reverse();
}

/**
 * Restaura el respaldo de un día: vuelve a escribir cada versión guardada en
 * el almacén de sincronización. No borra nada: si una versión más nueva de un
 * elemento ya existe, sigue ganando ella (los equipos siempre toman la mayor).
 * @param {{source: BlobStore, target: BlobStore, day: string, dryRun?: boolean}} o
 *   `source`: almacén de respaldos; `target`: almacén de sincronización.
 * @returns {Promise<{claves: number, escritas: number}>}
 */
export async function restoreBackup({ source, target, day, dryRun = false }) {
  const doc = await source.get(`${day}.json`, { type: 'json' });
  if (!doc || typeof doc.claves !== 'object') throw new Error(`No hay respaldo del ${day}`);
  const entries = Object.entries(doc.claves).filter(([k]) => VERSION_KEY.test(k));
  if (!dryRun) for (const [k, v] of entries) await target.setJSON(k, v);
  return { claves: entries.length, escritas: dryRun ? 0 : entries.length };
}
