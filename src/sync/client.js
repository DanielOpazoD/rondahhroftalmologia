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
    /** Borra del servidor ids en claro de versiones anteriores (ya migrados a id opaco). */
    purge: (ids) => call('purge', { ids }),
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
 *   opaqueIds?: boolean | ((localId: string) => boolean),
 * }} deps
 *   `encKey`: clave del equipo (base64), para la huella de contenido de cada versión;
 *   `fingerprint`: representación canónica del contenido (ver core/merge.js);
 *   `opaqueIds`: el servidor ve un id opaco (`serverId`) en vez del id local
 *   (todos, o los que indique la función). Necesario cuando el id local se
 *   deriva de datos personales: fichas de pacientes y perfiles de médico usan
 *   una huella del RUT, que se podría adivinar probando RUTs. Los ids en claro
 *   que subieron versiones anteriores se migran solos (ver `syncPass`).
 * @returns {Promise<{pushed: number, added: number, updated: number, deleted: number, skipped: number, merged: number, needsPush: boolean}>}
 */
export async function syncOnce(deps) {
  // Si al bajar se fusionó algo que el servidor aún no tiene, una segunda
  // pasada lo sube de inmediato (así los otros equipos lo reciben antes).
  const total = { pushed: 0, skipped: 0, merged: 0, added: 0, updated: 0, deleted: 0, needsPush: false };
  const pass0 = deps.opaqueIds ? withOpaqueIds(deps) : { ...deps, lids: null, wire: null };
  for (let pass = 0; pass < 3; pass++) {
    const r = await syncPass(pass0);
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

const idKeys = new Map();
/**
 * Id que ve el servidor para un id local: `h_` + HMAC (subclave propia de la
 * clave del equipo). Es el mismo en todos los equipos del equipo, pero sin la
 * contraseña no se puede revertir ni adivinar a partir de un RUT.
 */
export function serverId(encKey, localId) {
  if (!idKeys.has(encKey)) idKeys.set(encKey, hmacSha256(b64ToBytes(encKey), 'hhr-id-opaco-v1'));
  return 'h_' + toHex(hmacSha256(idKeys.get(encKey), localId)).slice(0, 32);
}

/**
 * Envuelve lectura y escritura locales para que la sincronización trabaje con
 * ids opacos. El id local viaja solo dentro del contenido cifrado (`lid`).
 */
function withOpaqueIds(deps) {
  if (!deps.encKey) throw new Error('opaqueIds requiere encKey');
  const isOpaque = typeof deps.opaqueIds === 'function' ? deps.opaqueIds : () => true;
  /** id local → id que ve el servidor */
  const wire = (lid) => (isOpaque(lid) ? serverId(deps.encKey, lid) : lid);
  /** id del servidor → id local */
  const lids = new Map();
  const toServer = (lid) => {
    const sid = wire(lid);
    lids.set(sid, lid);
    return sid;
  };
  const mapKeys = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [fn(k), v]));
  return {
    ...deps,
    lids,
    wire,
    /** ¿Es un id en claro que debería ser opaco? (subido por una versión anterior) */
    isLegacy: (id) => !id.startsWith('h_') && isOpaque(id),
    readLocal() {
      const { items, tombstones } = deps.readLocal();
      return { items: items.map((i) => ({ ...i, id: toServer(i.id) })), tombstones: mapKeys(tombstones, toServer) };
    },
    writeLocal(items, tombstones) {
      const back = items
        .filter((i) => lids.has(i.id))
        .map((i) => {
          const lid = lids.get(i.id);
          return { ...i, id: lid, data: { ...i.data, id: lid } };
        });
      deps.writeLocal(
        back,
        mapKeys(Object.fromEntries(Object.entries(tombstones || {}).filter(([k]) => lids.has(k))), (k) => lids.get(k)),
      );
    },
  };
}

/**
 * @param {Parameters<typeof syncOnce>[0] & {
 *   lids: Map<string, string> | null,
 *   wire: ((lid: string) => string) | null,
 *   isLegacy?: (id: string) => boolean,
 * }} deps
 */
async function syncPass({ api, key, encKey, readLocal, writeLocal, mergeFn, fingerprint, batchSize = 100, lids, wire, isLegacy }) {
  const { items } = await api.list();
  const remote = remoteVersions(items || []);

  // Ids en claro de versiones anteriores: no entran al plan. Si su versión
  // opaca ya está en el servidor, se borran; si no, se bajan y se aplican con
  // su id opaco (la próxima pasada los sube así).
  const legacy = [];
  if (lids && isLegacy) {
    for (const [id, v] of remote) {
      if (!isLegacy(id)) continue;
      remote.delete(id);
      legacy.push({ id, u: v.u, ...(v.h ? { h: v.h } : {}) });
    }
  }
  // Ya migrado = la versión opaca existe y no es más antigua. Si lo antiguo es
  // más nuevo (lo volvió a subir un equipo aún sin actualizar), primero se
  // fusiona y después se borra.
  const isMigrated = (l) => remote.has(wire(l.id)) && remote.get(wire(l.id)).u >= l.u;
  const migrated = legacy.filter(isMigrated);
  if (migrated.length) await api.purge(migrated.map((l) => l.id));
  const toMigrate = legacy.filter((l) => !isMigrated(l));
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

  /** Baja y descifra versiones del servidor (`fromLegacy`: ids en claro que se migran a opacos). */
  const fetchItems = async (list, { fromLegacy = false } = {}) => {
    const out = [];
    for (const batch of chunks(list, batchSize)) {
      const res = await api.get(batch);
      for (const it of res.items || []) {
        if (it.missing) continue; // fue reemplazado mientras tanto: llegará en la próxima sincronización
        const content = await decryptPayload(key, it.id, it.u, it);
        let id = it.id;
        if (lids) {
          // El id local viene dentro del contenido cifrado (o es el mismo id) y
          // debe corresponder al id del servidor. El cifrado está atado al id
          // del servidor, así que un elemento no se puede reubicar.
          const lid = content.lid ?? it.id;
          if (typeof lid !== 'string') continue;
          if (fromLegacy) {
            if (content.lid !== undefined || lid !== it.id) continue;
            id = wire(lid);
          } else if (wire(lid) !== it.id) continue;
          lids.set(id, lid);
        }
        // `record` = formato de la v2.1 (solo atenciones)
        const data = content.data ?? content.record;
        out.push({
          id,
          u: it.u,
          deleted: !!content.deleted,
          kind: content.kind || 'atencion',
          data: data && fromLegacy ? { ...data, id, updated: it.u } : data,
        });
      }
    }
    return out;
  };

  const legacyPulled = toMigrate.length ? await fetchItems(toMigrate, { fromLegacy: true }) : [];

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
        if (lids && lids.get(id) !== id) content.lid = lids.get(id);
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

  // 3. Bajar lo que es más nuevo en el servidor (y lo migrado desde ids en claro)
  pulled.push(...(await fetchItems(plan.pull)), ...legacyPulled);

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
    // Lo migrado se sube con id opaco en la próxima pasada, y entonces se borra lo antiguo.
    needsPush: result.needsPush || skipped > 0 || plan.conflicts.length > 0 || legacyPulled.length > 0,
  };
}
