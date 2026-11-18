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
 *
 * Cuentas de usuario (ADR 0014): las cuentas, su índice por RUT y las sesiones
 * (`_cuentas/…`, sin datos en claro) van en el documento diario. El registro
 * de accesos (`_auditoria/…`) solo crece: se copia de forma incremental, como
 * el contenido de los adjuntos (backupAuditLog).
 */

import { mapLimit } from '../lib/async.js';

export const KEEP_DAYS = 30;
/**
 * Estado del último respaldo diario, en el almacén de sincronización (sin
 * datos): el servidor lo informa a la app, que avisa si es antiguo.
 */
export const BACKUP_STATUS_KEY = '_estado/respaldo.json';
/** Lecturas simultáneas al almacén durante el respaldo. */
const READ_CONCURRENCY = 16;
const VERSION_KEY = /^[a-z][a-z0-9-]{1,39}\/r\//;
/**
 * El contenido de los adjuntos (`<especialidad>-adjuntos`) no entra en el
 * documento diario (puede pesar gigabytes): se respalda aparte, de forma
 * incremental, con backupAttachments (función programada cada hora).
 */
/** Cuentas, índice por RUT, configuración y sesiones (ADR 0014). */
const ACCOUNT_KEY = /^_cuentas\//;
const isBackedUp = (/** @type {string} */ key) => (VERSION_KEY.test(key) && !/^[a-z0-9-]+-adjuntos\//.test(key)) || ACCOUNT_KEY.test(key);
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.json$/; // las claves `adjuntos/…` no son días

/** @typedef {import('./server.js').BlobStore} BlobStore */

/** «2026-11-16» de una fecha (UTC). @param {number} t */
export const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Hace el respaldo del día y borra los de más de `keepDays` días.
 * @param {{source: BlobStore, target: BlobStore, now?: number, keepDays?: number}} o
 * @returns {Promise<{dia: string, claves: number, borrados: string[]}>}
 */
export async function dailyBackup({ source, target, now = Date.now(), keepDays = KEEP_DAYS }) {
  const { blobs } = await source.list();
  const keys = blobs.map((b) => b.key).filter(isBackedUp);
  // En paralelo (acotado): de a una, con miles de versiones, la función programada se quedaba sin tiempo.
  const values = await mapLimit(keys, READ_CONCURRENCY, (key) => source.get(key, { type: 'json' }));
  /** @type {Record<string, unknown>} */
  const claves = {};
  keys.forEach((key, i) => {
    if (values[i] !== null && values[i] !== undefined) claves[key] = values[i];
  });
  const dia = dayOf(now);
  await target.setJSON(`${dia}.json`, { creado: new Date(now).toISOString(), claves });
  const n = Object.keys(claves).length;
  // Solo tras escribirlo: si algo falla antes, el estado sigue mostrando el anterior (y la app avisa).
  await source.setJSON(BACKUP_STATUS_KEY, { at: now, dia, claves: n });
  return { dia, claves: n, borrados: await prune(target, now, keepDays) };
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
 * @param {{source: BlobStore, target: BlobStore, day: string, dryRun?: boolean, accounts?: boolean}} o
 *   `source`: almacén de respaldos; `target`: almacén de sincronización;
 *   `accounts`: reponer también las cuentas que falten. Va aparte y hay que
 *   pedirlo: si no, una cuenta que el sistema descartó (p. ej. una activación a
 *   medias) volvería sola al restaurar datos clínicos.
 * @returns {Promise<{claves: number, escritas: number}>}
 */
export async function restoreBackup({ source, target, day, dryRun = false, accounts: withAccounts = false }) {
  // Documento que escribe dailyBackup: {creado, claves}.
  const doc = /** @type {{claves?: Record<string, unknown>} | null} */ (await source.get(`${day}.json`, { type: 'json' }));
  if (!doc || typeof doc.claves !== 'object') throw new Error(`No hay respaldo del ${day}`);
  const entries = Object.entries(doc.claves).filter(([k]) => VERSION_KEY.test(k));
  // Cuentas: solo las que falten (nunca se pisa una cuenta vigente, p. ej. una clave cambiada después).
  const present = withAccounts ? new Set((await target.list({ prefix: '_cuentas/' })).blobs.map((b) => b.key)) : new Set();
  const accounts = withAccounts ? Object.entries(doc.claves).filter(([k]) => ACCOUNT_KEY.test(k) && !present.has(k)) : [];
  if (!dryRun) for (const [k, v] of [...entries, ...accounts]) await target.setJSON(k, v);
  return { claves: entries.length + accounts.length, escritas: dryRun ? 0 : entries.length + accounts.length };
}

/* ------------------------------------------------------------- adjuntos */

/** Partes del contenido de adjuntos en el almacén de sincronización. */
const ATT_KEY = /^[a-z][a-z0-9-]{0,39}-adjuntos\/r\//;
const ATT_PREFIX = 'adjuntos/';
const ORPHANS = 'adjuntos-huerfanos.json';

/**
 * Respaldo INCREMENTAL del contenido de los adjuntos. Las partes no cambian
 * nunca: se copia cada una una sola vez (`adjuntos/<clave>` en el almacén de
 * respaldos). Como una función programada tiene poco tiempo, cada ejecución
 * copia lo que alcanza en `budgetMs` y la siguiente continúa.
 * Las partes que ya no existen en el servidor (adjunto eliminado) se
 * conservan `keepDays` días y luego se borran.
 * @param {{source: BlobStore, target: BlobStore, now?: number, keepDays?: number, budgetMs?: number, clock?: () => number}} o
 * @returns {Promise<{copiadas: number, pendientes: number, borradas: number}>}
 */
export async function backupAttachments({ source, target, now = Date.now(), keepDays = KEEP_DAYS, budgetMs = 20_000, clock = Date.now }) {
  const started = clock();
  const live = (await source.list()).blobs.map((b) => b.key).filter((k) => ATT_KEY.test(k));
  const liveSet = new Set(live);
  const saved = new Set((await target.list({ prefix: ATT_PREFIX })).blobs.map((b) => b.key.slice(ATT_PREFIX.length)));
  let copiadas = 0;
  const missing = live.filter((k) => !saved.has(k));
  for (const k of missing) {
    if (clock() - started > budgetMs) break;
    const v = await source.get(k, { type: 'json' });
    if (v !== null && v !== undefined) {
      await target.setJSON(ATT_PREFIX + k, v);
      copiadas++;
    }
  }
  const borradas = await pruneOrphans(target, saved, liveSet, now, keepDays);
  return { copiadas, pendientes: missing.length - copiadas, borradas };
}

/**
 * Huérfanas: partes respaldadas pero ya no en el servidor. Se anota desde
 * cuándo y se borran pasados `keepDays` días.
 * @param {BlobStore} target almacén de respaldos
 * @param {Set<string>} saved partes respaldadas
 * @param {Set<string>} liveSet partes que hay en el servidor
 * @param {number} now
 * @param {number} keepDays
 * @returns {Promise<number>} cuántas se borraron
 */
async function pruneOrphans(target, saved, liveSet, now, keepDays) {
  /** Parte → día en que se vio huérfana (lo escribe esta función). */
  const orphans = /** @type {Record<string, string>} */ ((await target.get(ORPHANS, { type: 'json' })) || {});
  const today = dayOf(now);
  const limit = dayOf(now - keepDays * 24 * 3600 * 1000);
  let borradas = 0;
  for (const k of saved) {
    if (liveSet.has(k)) {
      delete orphans[k];
      continue;
    }
    orphans[k] ||= today;
    if (orphans[k] < limit) {
      await target.delete(ATT_PREFIX + k);
      delete orphans[k];
      borradas++;
    }
  }
  await target.setJSON(ORPHANS, orphans);
  return borradas;
}

/**
 * Restaura el contenido de adjuntos respaldado que falte en el servidor.
 * @param {{source: BlobStore, target: BlobStore, dryRun?: boolean}} o `source`: respaldos; `target`: sincronización.
 * @returns {Promise<{partes: number, escritas: number}>}
 */
export async function restoreAttachments({ source, target, dryRun = false }) {
  const backed = (await source.list({ prefix: ATT_PREFIX })).blobs.map((b) => b.key.slice(ATT_PREFIX.length));
  const present = new Set((await target.list()).blobs.map((b) => b.key));
  const todo = backed.filter((k) => ATT_KEY.test(k) && !present.has(k));
  if (!dryRun) for (const k of todo) await target.setJSON(k, await source.get(ATT_PREFIX + k, { type: 'json' }));
  return { partes: todo.length, escritas: dryRun ? 0 : todo.length };
}

/* ------------------------------------------------ registro de accesos */

const AUDIT_KEY = /^_auditoria\/\d{8}\//;
const AUDIT_PREFIX = 'auditoria/';

/**
 * Respaldo INCREMENTAL del registro de accesos: cada evento una sola vez
 * (`auditoria/<clave>`), con tope de tiempo por ejecución. Nunca se borra.
 * @param {{source: BlobStore, target: BlobStore, budgetMs?: number, clock?: () => number}} o
 * @returns {Promise<{copiados: number, pendientes: number}>}
 */
export async function backupAuditLog({ source, target, budgetMs = 10_000, clock = Date.now }) {
  const started = clock();
  const live = (await source.list({ prefix: '_auditoria/' })).blobs.map((b) => b.key).filter((k) => AUDIT_KEY.test(k));
  const saved = new Set((await target.list({ prefix: AUDIT_PREFIX })).blobs.map((b) => b.key.slice(AUDIT_PREFIX.length)));
  const missing = live.filter((k) => !saved.has(k));
  let copiados = 0;
  for (const k of missing) {
    if (clock() - started > budgetMs) break;
    const v = await source.get(k, { type: 'json' });
    if (v !== null && v !== undefined) {
      await target.setJSON(AUDIT_PREFIX + k, v);
      copiados++;
    }
  }
  return { copiados, pendientes: missing.length - copiados };
}

/**
 * Repone los eventos del registro de accesos que falten en el servidor.
 * @param {{source: BlobStore, target: BlobStore, dryRun?: boolean}} o `source`: respaldos; `target`: sincronización.
 * @returns {Promise<{eventos: number, escritos: number}>}
 */
export async function restoreAuditLog({ source, target, dryRun = false }) {
  const backed = (await source.list({ prefix: AUDIT_PREFIX })).blobs.map((b) => b.key.slice(AUDIT_PREFIX.length));
  const present = new Set((await target.list({ prefix: '_auditoria/' })).blobs.map((b) => b.key));
  const todo = backed.filter((k) => AUDIT_KEY.test(k) && !present.has(k));
  if (!dryRun) for (const k of todo) await target.setJSON(k, await source.get(AUDIT_PREFIX + k, { type: 'json' }));
  return { eventos: todo.length, escritos: dryRun ? 0 : todo.length };
}
