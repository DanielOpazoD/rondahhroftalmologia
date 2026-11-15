/**
 * Reglas de sincronización (puras, sin red ni almacenamiento).
 *
 * Cada atención tiene una VERSIÓN `u` = su marca `updated` (ms). Una
 * eliminación es una "lápida" (tombstone) con su propia versión. Entre dos
 * versiones del mismo id gana la mayor (last-write-wins), igual que al
 * importar respaldos. Las operaciones son idempotentes: repetir una
 * sincronización no cambia nada.
 */
import { isValidId } from '../core/record.js';

/**
 * Versión local de cada id (atención o lápida).
 * @param {{id: string, updated: number}[]} records elementos locales (atenciones, médicos, operativos)
 * @param {Record<string, number>} tombstones id -> fecha de eliminación (ms)
 * @returns {Map<string, {u: number, deleted: boolean}>}
 */
export function localVersions(records, tombstones = {}) {
  const map = new Map();
  for (const r of records) if (r.id && r.updated) map.set(r.id, { u: r.updated, deleted: false });
  for (const [id, u] of Object.entries(tombstones)) {
    if (!map.has(id) || map.get(id).u < u) map.set(id, { u, deleted: true });
  }
  return map;
}

/** Lista remota [{id, u}] -> Map id -> u (máximo). */
export function remoteVersions(items) {
  const map = new Map();
  for (const { id, u } of items) if (!map.has(id) || map.get(id) < u) map.set(id, u);
  return map;
}

/**
 * Qué subir y qué bajar.
 * @returns {{push: string[], pull: {id: string, u: number}[]}}
 */
export function planSync(local, remote) {
  const push = [];
  const pull = [];
  for (const [id, { u }] of local) if (!remote.has(id) || remote.get(id) < u) push.push(id);
  for (const [id, u] of remote) if (!local.has(id) || local.get(id).u < u) pull.push({ id, u });
  return { push, pull };
}

/**
 * Aplica versiones descargadas y descifradas sobre el estado local.
 * Los elementos son genéricos: {id, updated, kind, data}, donde `kind` es
 * 'atencion' | 'medico' | 'operativo'. La aplicación los separa por tipo.
 * @param {{id: string, updated: number, kind: string, data: object}[]} items
 * @param {{id: string, u: number, deleted?: boolean, kind?: string, data?: object}[]} pulled
 * @returns {{items: object[], tombstones: Record<string, number>, added: number, updated: number, deleted: number}}
 */
export function applyPulled(items, tombstones, pulled) {
  const byId = new Map(items.map((r) => [r.id, r]));
  const tomb = { ...tombstones };
  let added = 0;
  let updated = 0;
  let deleted = 0;
  for (const item of pulled) {
    if (!isValidId(item.id)) continue;
    const cur = byId.get(item.id);
    const localU = Math.max(cur?.updated || 0, tomb[item.id] || 0);
    if (item.u <= localU) continue; // lo local es igual o más nuevo
    if (item.deleted) {
      if (cur) {
        byId.delete(item.id);
        deleted++;
      }
      tomb[item.id] = item.u;
    } else {
      if (!item.data || typeof item.data !== 'object') continue;
      if (cur) updated++;
      else added++;
      byId.set(item.id, { id: item.id, updated: item.u, kind: item.kind || 'atencion', data: item.data });
      delete tomb[item.id];
    }
  }
  return { items: [...byId.values()], tombstones: tomb, added, updated, deleted };
}

/** Divide un arreglo en lotes. */
export function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
