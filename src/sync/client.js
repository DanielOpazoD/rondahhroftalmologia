/**
 * Cliente de sincronización: habla con /api/sync y aplica los cambios.
 *
 * Una sincronización:
 *   1. lista versiones del servidor;
 *   2. sube (cifradas) las atenciones y eliminaciones locales más nuevas;
 *   3. baja y descifra las más nuevas del servidor y las aplica localmente.
 */
import { encryptPayload, decryptPayload, b64ToBytes } from './crypto.js';
import { hmacSha256, toHex } from '../lib/sha256.js';
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
    api.serverDate = res.headers.get('date') || api.serverDate;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SyncHttpError(res.status, data.error || `Error del servidor (${res.status})`);
    return data;
  };
  const api = {
    /** Cabecera Date de la última respuesta (para detectar relojes desajustados). */
    serverDate: null,
    list: () => call('list'),
    get: (items) => call('get', { items }),
    put: (items) => call('put', { items }),
  };
  return api;
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
 *   encKey?: string,
 *   fingerprint?: (kind: string, data: object) => string,
 *   batchSize?: number,
 * }} deps
 *   `encKey`: clave del equipo (base64), para la huella de contenido de cada versión;
 *   `fingerprint`: representación canónica del contenido (ver core/merge.js).
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

const subkeys = new Map();
/** Subclave propia para huellas, derivada de la clave del equipo (no se reutiliza la clave AES). */
function fingerprintKey(encKey) {
  if (!subkeys.has(encKey)) subkeys.set(encKey, hmacSha256(b64ToBytes(encKey), 'hhr-huella-v2'));
  return subkeys.get(encKey);
}

/**
 * Huella de contenido (16 hex): HMAC con una subclave del equipo sobre
 * id + versión + tipo + contenido. Atarla al id y a la versión impide que el
 * servidor compare huellas entre atenciones distintas o entre versiones de la
 * misma (no puede saber si dos registros son iguales, si uno volvió a un
 * contenido anterior ni cuáles son eliminaciones). Solo se compara la huella
 * local con la del servidor para el MISMO id y la MISMA versión.
 */
export function contentHash(encKey, id, u, kind, fingerprint) {
  return toHex(hmacSha256(fingerprintKey(encKey), `${id}\n${u}\n${kind}\n${fingerprint}`)).slice(0, 16);
}

/** @param {Parameters<typeof syncOnce>[0]} deps */
async function syncPass({ api, key, encKey, readLocal, writeLocal, mergeFn, fingerprint, batchSize = 100 }) {
  const { items } = await api.list();
  const remote = remoteVersions(items || []);
  const local0 = readLocal();
  const byId = new Map(local0.items.map((r) => [r.id, r]));
  const local = localVersions(local0.items, local0.tombstones);

  /**
   * Huella del contenido local de un id. Se calcula en cada pasada (solo para
   * ids con el mismo número de versión que el servidor): una caché entre
   * pasadas podría quedar obsoleta al adoptar la versión del servidor.
   */
  const hashOf = (id) => {
    const v = local.get(id);
    const rec = byId.get(id);
    return v.deleted || !rec
      ? contentHash(encKey, id, v.u, 'eliminado', '')
      : contentHash(encKey, id, v.u, rec.kind, fingerprint(rec.kind, rec.data));
  };
  const plan = planSync(local, remote, encKey && fingerprint ? hashOf : undefined);
  const pulled = [];
  const extraPush = [];
  const tombBumps = {};

  /** Baja y descifra versiones del servidor. */
  const fetchItems = async (list) => {
    const out = [];
    for (const batch of chunks(list, batchSize)) {
      const res = await api.get(batch);
      for (const it of res.items || []) {
        if (it.missing) continue; // fue reemplazado mientras tanto: llegará en la próxima sincronización
        const content = await decryptPayload(key, it.id, it.u, it);
        // `record` = formato de la v2.1 (solo atenciones)
        out.push({
          id: it.id,
          u: it.u,
          deleted: !!content.deleted,
          kind: content.kind || 'atencion',
          data: content.data ?? content.record,
        });
      }
    }
    return out;
  };

  // 1. Fusionar antes de subir lo que también cambió en el servidor, y resolver
  //    conflictos (mismo número de versión, distinto contenido).
  let merged = 0;
  if (mergeFn) {
    const isLiveLocal = (id) => byId.has(id) && !(local0.tombstones[id] >= byId.get(id).updated);
    const both = plan.push
      .filter((id) => remote.has(id) && isLiveLocal(id))
      .map((id) => ({ id, u: remote.get(id).u, h: remote.get(id).h }));
    const conflictIds = new Set(plan.conflicts.map((c) => c.id));
    for (const r of await fetchItems([...both, ...plan.conflicts])) {
      const localItem = byId.get(r.id);
      const isConflict = conflictIds.has(r.id);
      if (!localItem || !isLiveLocal(r.id) || r.deleted || r.kind !== localItem.kind) {
        // Conflicto con una eliminación (o tipos distintos): se resuelve subiendo una versión nueva de lo local.
        if (isConflict) bump(r.id, r.u);
        continue;
      }
      const m = mergeFn(r.kind, localItem.data, { ...r.data, id: r.id, updated: r.u });
      if (!m) {
        if (isConflict) bump(r.id, r.u); // sin fusión posible: gana lo local con versión nueva
        continue;
      }
      if (isConflict && m.sameAsRemote) {
        // Lo local no aporta nada: se adopta la versión del servidor tal cual.
        pulled.push({ id: r.id, u: r.u, kind: r.kind, data: { ...r.data, id: r.id, updated: r.u }, adopt: true });
        continue;
      }
      const u = Math.max(localItem.updated, r.u) + 1;
      const data = { ...m.data, id: r.id, updated: u };
      byId.set(r.id, { ...localItem, updated: u, data });
      pulled.push({ id: r.id, u, kind: r.kind, data });
      if (isConflict) extraPush.push(r.id);
      merged++;
    }
  }

  /** Sube lo local con una versión mayor que `remoteU` (desempate de conflictos). */
  function bump(id, remoteU) {
    const it = byId.get(id);
    const tomb = local0.tombstones[id];
    if (it && !(tomb >= it.updated)) {
      const u = Math.max(it.updated, remoteU) + 1;
      const data = { ...it.data, updated: u };
      byId.set(id, { ...it, updated: u, data });
      pulled.push({ id, u, kind: it.kind, data });
    } else {
      local0.tombstones[id] = Math.max(tomb || 0, remoteU) + 1;
      tombBumps[id] = local0.tombstones[id];
    }
    extraPush.push(id);
  }

  // 2. Subir
  let pushed = 0;
  let skipped = 0;
  for (const ids of chunks([...new Set([...plan.push, ...extraPush])], batchSize)) {
    const payload = await Promise.all(
      ids.map(async (id) => {
        const rec = byId.get(id);
        const tomb = local0.tombstones[id];
        const u = rec && (!tomb || rec.updated > tomb) ? rec.updated : tomb;
        const content = rec && u === rec.updated ? { kind: rec.kind, data: rec.data } : { deleted: true };
        const h =
          encKey && fingerprint
            ? content.deleted
              ? contentHash(encKey, id, u, 'eliminado', '')
              : contentHash(encKey, id, u, rec.kind, fingerprint(rec.kind, rec.data))
            : undefined;
        return { id, u, ...(h ? { h } : {}), ...(await encryptPayload(key, id, u, content)) };
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
  if (pulled.length || Object.keys(tombBumps).length) {
    const cur = readLocal();
    const applied = applyPulled(cur.items, { ...cur.tombstones, ...tombBumps }, pulled, mergeFn);
    writeLocal(applied.items, applied.tombstones);
    result = applied;
  }
  return {
    pushed,
    skipped,
    merged,
    added: result.added,
    updated: result.updated,
    deleted: result.deleted,
    needsPush: result.needsPush || skipped > 0 || plan.conflicts.length > 0,
  };
}
