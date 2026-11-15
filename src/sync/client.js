/**
 * Cliente de sincronización: habla con /api/sync y aplica los cambios.
 *
 * Una sincronización:
 *   1. lista versiones del servidor;
 *   2. sube (cifradas) las atenciones y eliminaciones locales más nuevas;
 *   3. baja y descifra las más nuevas del servidor y las aplica localmente.
 */
import { encryptPayload, decryptPayload } from './crypto.js';
import { localVersions, remoteVersions, planSync, applyPulled, chunks } from './protocol.js';

export class SyncHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{baseUrl?: string, token: string, fetchFn?: typeof fetch}} opts
 */
export function createSyncApi({ baseUrl = '/api/sync', token, fetchFn = globalThis.fetch.bind(globalThis) }) {
  const call = async (path, body) => {
    let res;
    try {
      res = await fetchFn(`${baseUrl}/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new SyncHttpError(0, 'Sin conexión con el servidor');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SyncHttpError(res.status, data.error || `Error del servidor (${res.status})`);
    return data;
  };
  return {
    list: () => call('list'),
    get: (items) => call('get', { items }),
    put: (items) => call('put', { items }),
  };
}

/**
 * Ejecuta una sincronización completa.
 * @param {{
 *   api: ReturnType<typeof createSyncApi>,
 *   key: CryptoKey,
 *   readLocal: () => {records: object[], tombstones: Record<string, number>},
 *   writeLocal: (records: object[], tombstones: Record<string, number>) => void,
 *   batchSize?: number,
 * }} deps
 * @returns {Promise<{pushed: number, added: number, updated: number, deleted: number, skipped: number}>}
 */
export async function syncOnce({ api, key, readLocal, writeLocal, batchSize = 100 }) {
  const { items } = await api.list();
  const remote = remoteVersions(items || []);
  const local0 = readLocal();
  const plan = planSync(localVersions(local0.records, local0.tombstones), remote);

  // Subir
  let pushed = 0;
  let skipped = 0;
  const byId = new Map(local0.records.map((r) => [r.id, r]));
  for (const ids of chunks(plan.push, batchSize)) {
    const payload = await Promise.all(
      ids.map(async (id) => {
        const rec = byId.get(id);
        const tomb = local0.tombstones[id];
        const u = rec && (!tomb || rec.updated > tomb) ? rec.updated : tomb;
        const content = rec && u === rec.updated ? { record: rec } : { deleted: true };
        return { id, u, ...(await encryptPayload(key, id, u, content)) };
      }),
    );
    const res = await api.put(payload);
    pushed += res.saved?.length || 0;
    skipped += res.skipped?.length || 0;
  }

  // Bajar
  const pulled = [];
  for (const batch of chunks(plan.pull, batchSize)) {
    const res = await api.get(batch);
    for (const it of res.items || []) {
      if (it.missing) continue; // fue reemplazado mientras tanto: llegará en la próxima sincronización
      const content = await decryptPayload(key, it.id, it.u, it);
      pulled.push({ id: it.id, u: it.u, deleted: !!content.deleted, record: content.record });
    }
  }

  // Aplicar sobre el estado local ACTUAL (pudo cambiar mientras se esperaba la red).
  let result = { added: 0, updated: 0, deleted: 0 };
  if (pulled.length) {
    const cur = readLocal();
    const applied = applyPulled(cur.records, cur.tombstones, pulled);
    writeLocal(applied.records, applied.tombstones);
    result = applied;
  }
  return { pushed, skipped, added: result.added, updated: result.updated, deleted: result.deleted };
}
