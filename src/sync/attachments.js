/**
 * Sincronización del CONTENIDO de los adjuntos (ver core/attachments.js).
 *
 * Los metadatos viajan con la sincronización normal. Aquí solo van los bytes,
 * cifrados igual que todo (AES-256-GCM, atados a id y versión), en partes de
 * CHUNK_BYTES, en un espacio propio del servidor: `<especialidad>-adjuntos`.
 * El contenido de un adjunto no cambia nunca, así que no hay fusión: se sube
 * lo que falta, se baja lo que falta y se borra lo eliminado.
 *
 * Para no gastar red ni memoria, solo se consulta el servidor si hay algo que
 * hacer (contenido local sin subir, metadatos sin contenido local, o
 * eliminados pendientes), y el contenido se lee de a un adjunto.
 */
import { encryptPayload, decryptPayload, b64ToBytes } from './crypto.js';
import { remoteVersions, chunks as batches } from './protocol.js';
import { chunkId, splitChunks, joinChunks, sha256Hex } from '../core/attachments.js';

/** Partes por solicitud: ~350.000 caracteres cada una cifrada, bajo el límite de 5,5 MB por solicitud. */
export const CHUNKS_PER_REQUEST = 12;

/** @param {Uint8Array} bytes */
const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * @typedef {{id: string, sha256: string, tamano: number, partes: number, created: number}} AttMeta
 * @typedef {{
 *   api: {list: (since?: number) => Promise<{items?: {id: string, u: number, h?: string}[]}>,
 *         get: (items: {id: string, u: number}[]) => Promise<{items?: any[]}>,
 *         put: (items: object[]) => Promise<{saved?: string[], skipped?: string[]}>},
 *   key: CryptoKey,
 *   metas: AttMeta[],
 *   purges: string[],
 *   local: {
 *     ids: () => Promise<string[]>,
 *     load: (id: string) => Promise<{bytes: Uint8Array} | undefined>,
 *     save: (id: string, bytes: Uint8Array) => Promise<void>,
 *     isUploaded: (id: string) => boolean,
 *     markUploaded: (id: string) => void,
 *   },
 *   batchSize?: number,
 * }} AttSyncDeps
 */

/**
 * ¿Hay algo que hacer? (evita consultar el servidor en cada sincronización).
 * @param {AttMeta[]} metas
 * @param {string[]} localIds ids con contenido en este equipo
 * @param {(id: string) => boolean} isUploaded
 * @param {string[]} purges
 */
export function attachmentsPending(metas, localIds, isUploaded, purges) {
  if (purges.length) return true;
  const have = new Set(localIds);
  // Falta bajar (sin contenido aquí) o falta subir (contenido de aquí aún no confirmado en el servidor).
  return metas.some((m) => !have.has(m.id) || !isUploaded(m.id));
}

/**
 * Sube, baja y borra contenido de adjuntos.
 * @param {AttSyncDeps} deps
 * @returns {Promise<{subidos: number, bajados: number, borrados: string[], fallidos: string[]}>}
 */
export async function syncAttachmentContent({ api, key, metas, purges, local, batchSize = CHUNKS_PER_REQUEST }) {
  const remote = remoteVersions((await api.list()).items || []);
  const localIds = new Set(await local.ids());
  /** ¿Están todas las partes de este adjunto en el servidor (con contenido)? */
  const complete = (/** @type {AttMeta} */ m) => {
    for (let n = 0; n < m.partes; n++) if (!remote.has(chunkId(m.id, n)) || remote.get(chunkId(m.id, n))?.u !== m.created) return false;
    return true;
  };
  let subidos = 0;
  let bajados = 0;
  const fallidos = [];

  // 1. Subir: contenido de este equipo que el servidor no tiene completo.
  /** @type {object[]} */
  let pending = [];
  /** @type {string[]} */
  let pendingAtts = [];
  const flush = async () => {
    if (!pending.length) return;
    await api.put(pending);
    for (const id of pendingAtts) local.markUploaded(id);
    subidos += pendingAtts.length;
    pending = [];
    pendingAtts = [];
  };
  for (const m of metas) {
    if (!localIds.has(m.id)) continue;
    if (complete(m)) {
      local.markUploaded(m.id);
      continue;
    }
    const doc = await local.load(m.id);
    if (!doc) continue;
    const parts = splitChunks(doc.bytes);
    for (let n = 0; n < parts.length; n++) {
      const id = chunkId(m.id, n);
      pending.push({ id, u: m.created, ...(await encryptPayload(key, id, m.created, { b: toB64(parts[n]) })) });
      if (pending.length >= batchSize) await flush();
    }
    pendingAtts.push(m.id);
  }
  await flush();

  // 2. Bajar: adjuntos con metadatos pero sin contenido en este equipo, si el servidor ya lo tiene completo.
  for (const m of metas) {
    if (localIds.has(m.id) || !complete(m)) continue;
    /** @type {Uint8Array[]} */
    const parts = new Array(m.partes);
    const wanted = Array.from({ length: m.partes }, (_, n) => ({ id: chunkId(m.id, n), u: m.created }));
    for (const batch of batches(wanted, batchSize)) {
      const res = await api.get(batch);
      for (const it of res.items || []) {
        if (it.missing) continue;
        const content = await decryptPayload(key, it.id, it.u, it);
        if (typeof content?.b !== 'string') continue;
        parts[Number(it.id.slice(m.id.length + 1))] = b64ToBytes(content.b);
      }
    }
    const bytes = parts.every(Boolean) ? joinChunks(parts) : null;
    // Integridad: el contenido debe tener exactamente la huella de sus metadatos.
    if (!bytes || bytes.length !== m.tamano || (await sha256Hex(bytes)) !== m.sha256) {
      fallidos.push(m.id);
      continue;
    }
    await local.save(m.id, bytes);
    local.markUploaded(m.id); // ya está en el servidor
    bajados++;
  }

  // 3. Borrar del servidor el contenido de los adjuntos eliminados (se reemplaza por una lápida pequeña).
  const borrados = [];
  for (const id of purges) {
    const tombs = [];
    for (const [rid, v] of remote) {
      if (!rid.startsWith(id + '-')) continue;
      const u = v.u + 1;
      tombs.push({ id: rid, u, ...(await encryptPayload(key, rid, u, { deleted: true })) });
    }
    for (const batch of batches(tombs, batchSize)) await api.put(batch);
    borrados.push(id);
  }
  return { subidos, bajados, borrados, fallidos };
}
