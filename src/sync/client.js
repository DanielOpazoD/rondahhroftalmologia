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
 * @param {{baseUrl?: string, token: string, esp?: string, fetchFn?: typeof fetch}} opts
 *   `esp`: especialidad (espacio de datos separado en el servidor)
 */
export function createSyncApi({ baseUrl = '/api/sync', token, esp, fetchFn = globalThis.fetch.bind(globalThis) }) {
  const qs = esp ? `?esp=${encodeURIComponent(esp)}` : '';
  const call = async (path, body) => {
    let res;
    try {
      res = await fetchFn(`${baseUrl}/${path}${qs}`, {
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
 *
 * Antes de SUBIR una atención que también cambió en el servidor, se baja la
 * versión del servidor y se fusiona campo a campo (mergeFn): así un equipo
 * nunca sobrescribe lo que otro grabó en otros campos. Al BAJAR, también se
 * fusiona con lo local.
 *
 * @param {{
 *   api: ReturnType<typeof createSyncApi>,
 *   key: CryptoKey,
 *   readLocal: () => {items: {id: string, updated: number, kind: string, data: object}[], tombstones: Record<string, number>},
 *   writeLocal: (items: object[], tombstones: Record<string, number>) => void,
 *   mergeFn?: import('./protocol.js').MergeFn,
 *   batchSize?: number,
 * }} deps
 * @returns {Promise<{pushed: number, added: number, updated: number, deleted: number, skipped: number, merged: number, needsPush: boolean}>}
 */
export async function syncOnce(deps) {
  // Si al bajar se fusionó algo que el servidor aún no tiene, una segunda
  // pasada lo sube de inmediato (así los otros equipos lo reciben antes).
  const total = { pushed: 0, skipped: 0, merged: 0, added: 0, updated: 0, deleted: 0, needsPush: false };
  for (let pass = 0; pass < 3; pass++) {
    const r = await syncPass(deps);
    for (const k of ['pushed', 'skipped', 'merged', 'added', 'updated', 'deleted']) total[k] += r[k];
    total.needsPush = r.needsPush;
    if (!r.needsPush) break;
  }
  return total;
}

async function syncPass({ api, key, readLocal, writeLocal, mergeFn, batchSize = 100 }) {
  const { items } = await api.list();
  const remote = remoteVersions(items || []);
  const local0 = readLocal();
  const plan = planSync(localVersions(local0.items, local0.tombstones), remote);
  const byId = new Map(local0.items.map((r) => [r.id, r]));
  const pulled = [];

  /** Baja y descifra versiones del servidor. */
  const fetchItems = async (list) => {
    const out = [];
    for (const batch of chunks(list, batchSize)) {
      const res = await api.get(batch);
      for (const it of res.items || []) {
        if (it.missing) continue; // fue reemplazado mientras tanto: llegará en la próxima sincronización
        const content = await decryptPayload(key, it.id, it.u, it);
        // `record` = formato de la v2.1 (solo atenciones)
        out.push({ id: it.id, u: it.u, deleted: !!content.deleted, kind: content.kind || 'atencion', data: content.data ?? content.record });
      }
    }
    return out;
  };

  // 1. Fusionar antes de subir lo que también cambió en el servidor.
  let merged = 0;
  if (mergeFn) {
    const both = plan.push.filter((id) => remote.has(id) && byId.has(id) && !(local0.tombstones[id] >= byId.get(id).updated));
    for (const r of await fetchItems(both.map((id) => ({ id, u: remote.get(id) })))) {
      const local = byId.get(r.id);
      if (r.deleted || r.kind !== local.kind) continue;
      const m = mergeFn(r.kind, local.data, { ...r.data, id: r.id, updated: r.u });
      if (!m) continue;
      const u = Math.max(local.updated, r.u) + 1;
      const data = { ...m.data, id: r.id, updated: u };
      byId.set(r.id, { ...local, updated: u, data });
      pulled.push({ id: r.id, u, kind: r.kind, data });
      merged++;
    }
  }

  // 2. Subir
  let pushed = 0;
  let skipped = 0;
  for (const ids of chunks(plan.push, batchSize)) {
    const payload = await Promise.all(
      ids.map(async (id) => {
        const rec = byId.get(id);
        const tomb = local0.tombstones[id];
        const u = rec && (!tomb || rec.updated > tomb) ? rec.updated : tomb;
        const content = rec && u === rec.updated ? { kind: rec.kind, data: rec.data } : { deleted: true };
        return { id, u, ...(await encryptPayload(key, id, u, content)) };
      }),
    );
    const res = await api.put(payload);
    pushed += res.saved?.length || 0;
    skipped += res.skipped?.length || 0;
  }

  // 3. Bajar lo que es más nuevo en el servidor
  pulled.push(...(await fetchItems(plan.pull)));

  // 4. Aplicar sobre el estado local ACTUAL (pudo cambiar mientras se esperaba la red).
  let result = { added: 0, updated: 0, deleted: 0, needsPush: false };
  if (pulled.length) {
    const cur = readLocal();
    const applied = applyPulled(cur.items, cur.tombstones, pulled, mergeFn);
    writeLocal(applied.items, applied.tombstones);
    result = applied;
  }
  return { pushed, skipped, merged, added: result.added, updated: result.updated, deleted: result.deleted, needsPush: result.needsPush || skipped > 0 };
}
