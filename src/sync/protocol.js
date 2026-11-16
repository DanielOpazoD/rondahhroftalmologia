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
 * Versión del PROTOCOLO de sincronización (formato de lo que viaja), distinta
 * de la versión de la app. Historia:
 *   1 — cifrado AES-GCM por elemento, versión = fecha de modificación (2.1)
 *   2 — huellas de contenido para conflictos con igual versión (2.6)
 *   3 — ids opacos, `list?since=` incremental y `purge` (2.10)
 * Un cambio INCOMPATIBLE sube PROTOCOL_VERSION y, en el servidor,
 * MIN_CLIENT_PROTOCOL: los equipos con una app más antigua reciben 426 y el
 * aviso de recargar, en vez de sincronizar datos que no entienden.
 */
export const PROTOCOL_VERSION = 3;
/** Versión mínima de cliente que acepta el servidor (si el cliente la declara). */
export const MIN_CLIENT_PROTOCOL = 3;
/** Cabecera HTTP en la que cliente y servidor declaran su versión de protocolo. */
export const PROTOCOL_HEADER = 'x-hhr-protocol';

/**
 * Versión local de cada id (atención o lápida).
 * @param {{id: string, updated: number}[]} records elementos locales (atenciones, médicos, operativos)
 * @param {Record<string, number>} tombstones id -> fecha de eliminación (ms)
 * @returns {Map<string, {u: number, deleted: boolean}>}
 */
export function localVersions(records, tombstones = {}) {
  /** @type {Map<string, {u: number, deleted: boolean}>} */
  const map = new Map();
  for (const r of records) if (r.id && r.updated) map.set(r.id, { u: r.updated, deleted: false });
  for (const [id, u] of Object.entries(tombstones)) {
    const cur = map.get(id);
    if (!cur || cur.u < u) map.set(id, { u, deleted: true });
  }
  return map;
}

/**
 * Lista remota [{id, u, h}] -> Map id -> {u, h} (la versión más nueva; a igual número, mayor huella).
 * @param {Iterable<{id: string, u: number, h?: string}>} items
 * @returns {Map<string, {u: number, h?: string}>}
 */
export function remoteVersions(items) {
  /** @type {Map<string, {u: number, h?: string}>} */
  const map = new Map();
  for (const { id, u, h } of items) {
    const cur = map.get(id);
    if (!cur || u > cur.u || (u === cur.u && (h || '') > (cur.h || ''))) map.set(id, { u, h });
  }
  return map;
}

/**
 * Qué subir, qué bajar y qué revisar.
 * - push: lo local es más nuevo (o no existe en el servidor);
 * - pull: el servidor tiene una versión más nueva;
 * - conflicts: mismo número de versión pero distinta huella de contenido
 *   (dos equipos fusionaron a la vez): hay que bajar y fusionar.
 * @template {{u: number}} L
 * @param {Map<string, L>} local
 * @param {Map<string, {u: number, h?: string}>} remote
 * @param {(id: string, local: L) => string} [localHash] huella del contenido local de `id`, con su versión local
 *   (solo se calcula si hace falta)
 * @returns {{push: string[], pull: {id: string, u: number, h?: string}[], conflicts: {id: string, u: number, h: string}[]}}
 */
export function planSync(local, remote, localHash) {
  const push = [];
  const pull = [];
  const conflicts = [];
  for (const [id, { u }] of local) {
    const r = remote.get(id);
    if (!r || r.u < u) push.push(id);
  }
  for (const [id, r] of remote) {
    const l = local.get(id);
    if (!l || l.u < r.u) pull.push(r.h ? { id, u: r.u, h: r.h } : { id, u: r.u });
    else if (l.u === r.u && r.h && localHash && localHash(id, l) !== r.h) conflicts.push({ id, u: r.u, h: r.h });
  }
  return { push, pull, conflicts };
}

/**
 * Aplica versiones descargadas y descifradas sobre el estado local.
 * Los elementos son genéricos: {id, updated, kind, data}, donde `kind` es
 * 'atencion' | 'medico' | 'operativo'. La aplicación los separa por tipo.
 * @param {import('../domain').ElementoSync[]} items
 * @param {Record<string, number>} tombstones id -> fecha de eliminación (ms)
 * @param {import('../domain').ElementoBajado[]} pulled
 * @param {MergeFn} [mergeFn] fusión por tipo (atenciones: campo a campo). Sin ella, gana la versión más nueva entera.
 * @returns {{items: import('../domain').ElementoSync[], tombstones: Record<string, number>, added: number, updated: number, deleted: number, needsPush: boolean}}
 */
export function applyPulled(items, tombstones, pulled, mergeFn) {
  const byId = new Map(items.map((r) => [r.id, r]));
  const tomb = { ...tombstones };
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let needsPush = false;
  for (const item of pulled) {
    if (!isValidId(item.id)) continue;
    const cur = byId.get(item.id);
    const localU = Math.max(cur?.updated || 0, tomb[item.id] || 0);
    // `adopt`: versión del servidor con el mismo número que la local tras resolver un conflicto.
    if (item.u <= localU && !item.adopt) continue; // lo local es igual o más nuevo
    if (item.deleted) {
      if (cur) {
        byId.delete(item.id);
        deleted++;
      }
      tomb[item.id] = item.u;
    } else {
      if (!item.data || typeof item.data !== 'object') continue;
      const kind = item.kind || 'atencion';
      let data = item.data;
      let u = item.u;
      const m = cur && cur.kind === kind && mergeFn ? mergeFn(kind, cur.data, { ...item.data, id: item.id, updated: item.u }) : null;
      if (cur && m) {
        data = /** @type {Record<string, unknown>} */ (m.data);
        // Si la fusión agregó algo local que el servidor no tiene, es una versión nueva que hay que subir.
        if (!m.sameAsRemote) {
          u = Math.max(cur.updated || 0, item.u) + 1;
          needsPush = true;
        }
      }
      if (cur) updated++;
      else added++;
      byId.set(item.id, { id: item.id, updated: u, kind, data: { ...data, id: item.id, updated: u } });
      delete tomb[item.id];
    }
  }
  return { items: [...byId.values()], tombstones: tomb, added, updated, deleted, needsPush };
}

/**
 * @callback MergeFn
 * @param {string} kind tipo del elemento
 * @param {Record<string, unknown>} local datos locales
 * @param {Record<string, unknown>} remote datos remotos (con id y updated)
 * @returns {{data: object, sameAsRemote: boolean} | null} null = sin fusión (gana la versión más nueva)
 */

/**
 * Divide un arreglo en lotes.
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
export function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
