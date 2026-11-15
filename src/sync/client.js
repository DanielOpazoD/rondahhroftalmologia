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
import { localVersions, remoteVersions, planSync, applyPulled, chunks, PROTOCOL_VERSION, PROTOCOL_HEADER } from './protocol.js';

/** @typedef {import('../domain').SyncVersion} SyncVersion */
/** @typedef {import('../domain').SyncBlob} SyncBlob */
/** @typedef {import('../domain').ElementoSync} ElementoSync */
/** @typedef {import('../domain').ElementoBajado} ElementoBajado */

export class SyncHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [code] código estable del servidor (p. ej. `sesion_invalida`)
   */
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Estados HTTP transitorios: se reintenta (el resto, p. ej. 401 o 400, no). */
export const RETRYABLE_STATUS = new Set([0, 408, 429, 502, 504]);

/**
 * Espera antes del reintento `attempt` (0, 1, 2…): retroceso exponencial con
 * variación aleatoria («jitter»), para que varios PC que fallaron a la vez no
 * vuelvan a pedir todos en el mismo instante.
 */
/** @type {(attempt: number, rand?: () => number) => number} */
export const backoffMs = (attempt, rand = Math.random) => Math.min(8000, 500 * 2 ** attempt) + Math.floor(rand() * 250);

/**
 * Cliente HTTP del servidor de sincronización.
 *
 * Robustez de red: cada solicitud tiene un tiempo máximo (`timeoutMs`) y los
 * errores transitorios (sin conexión, tiempo agotado, 429, 502, 504) se
 * reintentan hasta `retries` veces con retroceso exponencial. Reintentar es
 * seguro: list/get son lecturas, put es idempotente (una versión ya guardada
 * se omite) y purge borra lo que ya no existe sin error.
 * @param {{baseUrl?: string, token: string, esp?: string, fetchFn?: typeof fetch,
 *   timeoutMs?: number, retries?: number, sleep?: (ms: number) => Promise<void>}} opts
 *   `esp`: especialidad (espacio de datos separado en el servidor)
 */
export function createSyncApi({
  baseUrl = '/api/sync',
  token,
  esp,
  fetchFn = globalThis.fetch.bind(globalThis),
  timeoutMs = 20_000,
  retries = 2,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const qs = esp ? `?esp=${encodeURIComponent(esp)}` : '';

  /**
   * Una solicitud, con tiempo máximo.
   * @param {string} path
   * @param {unknown} body
   * @param {string} extra
   */
  const once = async (path, body, extra) => {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = ctrl
      ? setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, timeoutMs)
      : null;
    let res;
    try {
      res = await fetchFn(`${baseUrl}/${path}${qs}${extra ? (qs ? '&' : '?') + extra : ''}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      api.serverDate = res.headers.get('date') || api.serverDate;
      api.serverProtocol = Number(res.headers.get(PROTOCOL_HEADER)) || api.serverProtocol;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new SyncHttpError(res.status, data.error || `Error del servidor (${res.status})`, data.code || '');
      return data;
    } catch (e) {
      if (e instanceof SyncHttpError) throw e;
      throw new SyncHttpError(0, timedOut ? 'El servidor no respondió a tiempo' : 'Sin conexión con el servidor');
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** @type {(path: string, body?: unknown, extra?: string) => Promise<any>} respuesta JSON del servidor */
  const call = async (path, body, extra = '') => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(path, body, extra);
      } catch (e) {
        if (attempt >= retries || !(e instanceof SyncHttpError) || !RETRYABLE_STATUS.has(e.status)) throw e;
        await sleep(backoffMs(attempt));
      }
    }
  };
  const api = {
    /** Cabecera Date de la última respuesta (para detectar relojes desajustados). */
    serverDate: /** @type {string | null} */ (null),
    /** Versión de protocolo que declaró el servidor (0 si no la declara). */
    serverProtocol: 0,
    /** Versión vigente de cada id; con `since` (hora del servidor), solo lo cambiado desde entonces. */
    /** @type {(since?: number) => Promise<{items?: SyncVersion[], now?: number, full?: boolean}>} */
    list: (since) => call('list', undefined, since ? `since=${Math.floor(since)}` : ''),
    /** @type {(items: SyncVersion[]) => Promise<{items?: (SyncBlob & {missing?: boolean})[]}>} */
    get: (items) => call('get', { items }),
    /** @type {(items: SyncBlob[]) => Promise<{saved?: string[], skipped?: string[]}>} */
    put: (items) => call('put', { items }),
    /**
     * Borra del servidor ids en claro de versiones anteriores (ya migrados a id opaco).
     * @type {(ids: string[]) => Promise<{purged?: string[]}>}
     */
    purge: (ids) => call('purge', { ids }),
  };
  return api;
}

/**
 * Dependencias de una sincronización (ver `syncOnce`).
 * @typedef {{
 *   api: ReturnType<typeof createSyncApi>,
 *   key: CryptoKey,
 *   readLocal: () => {items: ElementoSync[], tombstones: Record<string, number>},
 *   writeLocal: (items: ElementoSync[], tombstones: Record<string, number>) => void,
 *   mergeFn?: import('./protocol.js').MergeFn,
 *   encKey?: string,
 *   fingerprint?: (kind: string, data: Record<string, unknown>) => string,
 *   batchSize?: number,
 *   opaqueIds?: boolean | ((localId: string) => boolean),
 *   cache?: SyncCache,
 * }} SyncDeps
 */

/**
 * Ejecuta una sincronización completa.
 *
 * Antes de SUBIR una atención que también cambió en el servidor, se baja la
 * versión del servidor y se fusiona campo a campo (mergeFn): así un equipo
 * nunca sobrescribe lo que otro grabó en otros campos. Al BAJAR, también se
 * fusiona con lo local.
 *
 * @param {SyncDeps} deps
 *   `encKey`: clave del equipo (base64), para la huella de contenido de cada versión;
 *   `fingerprint`: representación canónica del contenido (ver core/merge.js);
 *   `opaqueIds`: el servidor ve un id opaco (`serverId`) en vez del id local
 *   (todos, o los que indique la función). Necesario cuando el id local se
 *   deriva de datos personales: fichas de pacientes y perfiles de médico usan
 *   una huella del RUT, que se podría adivinar probando RUTs. Los ids en claro
 *   que subieron versiones anteriores se migran solos (ver `syncPass`);
 *   `cache`: estado entre sincronizaciones de un mismo espacio (ver `createSyncCache`).
 *   Con él, después de la primera sincronización solo se pide al servidor lo
 *   cambiado y no se recalculan huellas ya verificadas.
 * @returns {Promise<{pushed: number, added: number, updated: number, deleted: number, skipped: number, merged: number, needsPush: boolean}>}
 */
export async function syncOnce(deps) {
  // Si al bajar se fusionó algo que el servidor aún no tiene, una segunda
  // pasada lo sube de inmediato (así los otros equipos lo reciben antes).
  const total = { pushed: 0, skipped: 0, merged: 0, added: 0, updated: 0, deleted: 0, needsPush: false };
  const pass0 = deps.opaqueIds ? withOpaqueIds(deps) : { ...deps, lids: null, wire: null };
  for (let pass = 0; pass < 3; pass++) {
    const r = await syncPass(pass0);
    for (const k of /** @type {const} */ (['pushed', 'skipped', 'merged', 'added', 'updated', 'deleted'])) total[k] += r[k];
    total.needsPush = r.needsPush;
    if (!r.needsPush) break;
  }
  return total;
}

/**
 * @typedef {{snapshot: Map<string, {u: number, h?: string}> | null, cursor: number | null,
 *   fullAt: number, verified: Map<string, string>}} SyncCache
 */

/** Margen al pedir cambios (cubre escrituras en curso al momento de listar). */
export const CURSOR_MARGIN_MS = 10 * 60 * 1000;
/** Cada cuánto se vuelve a pedir la lista completa (autocorrección). */
export const FULL_LIST_EVERY_MS = 30 * 60 * 1000;

/**
 * Estado entre sincronizaciones de un espacio: copia de las versiones del
 * servidor, cursor de cambios y huellas locales ya verificadas. Vive en
 * memoria: al abrir la app la primera sincronización es completa.
 * @returns {SyncCache}
 */
export function createSyncCache() {
  return { snapshot: null, cursor: null, fullAt: 0, verified: new Map() };
}

/** @type {(a: {u: number, h?: string}, b: {u: number, h?: string}) => boolean} */
const vNewer = (a, b) => a.u > b.u || (a.u === b.u && (a.h || '') > (b.h || ''));

/**
 * Pide la lista al servidor (completa o solo cambios) y devuelve las versiones remotas.
 * @param {SyncDeps['api']} api
 * @param {SyncCache | undefined} cache
 */
async function listRemote(api, cache, nowMs = Date.now()) {
  const incremental = cache?.snapshot && cache.cursor && nowMs - cache.fullAt < FULL_LIST_EVERY_MS;
  const res = await api.list(incremental ? cache.cursor - CURSOR_MARGIN_MS : undefined);
  const got = remoteVersions(res.items || []);
  if (!cache) return got;
  if (incremental && res.full === false) {
    for (const [id, v] of got) if (!cache.snapshot.has(id) || vNewer(v, cache.snapshot.get(id))) cache.snapshot.set(id, v);
  } else {
    // Lista completa (o servidor antiguo sin cursor). Las huellas verificadas
    // se vuelven a comprobar: acota cualquier cambio local que no haya subido
    // la versión (autocorrección cada FULL_LIST_EVERY_MS).
    cache.snapshot = res.now ? new Map(got) : null;
    cache.verified = new Map();
    cache.fullAt = nowMs;
  }
  cache.cursor = Number.isFinite(res.now) ? res.now : null;
  return cache.snapshot ? new Map(cache.snapshot) : got;
}

/** @type {Map<string, Uint8Array>} */
const subkeys = new Map();
/**
 * Subclave propia para huellas, derivada de la clave del equipo (no se reutiliza la clave AES).
 * @param {string} encKey
 */
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
 * @param {string} encKey
 * @param {string} id
 * @param {number} u
 * @param {string} kind
 * @param {string} fingerprint
 */
export function contentHash(encKey, id, u, kind, fingerprint) {
  return toHex(hmacSha256(fingerprintKey(encKey), `${id}\n${u}\n${kind}\n${fingerprint}`)).slice(0, 16);
}

/** @type {Map<string, Uint8Array>} */
const idKeys = new Map();
/**
 * Id que ve el servidor para un id local: `h_` + HMAC (subclave propia de la
 * clave del equipo). Es el mismo en todos los equipos del equipo, pero sin la
 * contraseña no se puede revertir ni adivinar a partir de un RUT.
 * @param {string} encKey
 * @param {string} localId
 */
export function serverId(encKey, localId) {
  if (!idKeys.has(encKey)) idKeys.set(encKey, hmacSha256(b64ToBytes(encKey), 'hhr-id-opaco-v1'));
  return 'h_' + toHex(hmacSha256(idKeys.get(encKey), localId)).slice(0, 32);
}

/**
 * Envuelve lectura y escritura locales para que la sincronización trabaje con
 * ids opacos. El id local viaja solo dentro del contenido cifrado (`lid`).
 * @param {SyncDeps} deps
 * @returns {PassDeps}
 */
function withOpaqueIds(deps) {
  if (!deps.encKey) throw new Error('opaqueIds requiere encKey');
  const isOpaque = typeof deps.opaqueIds === 'function' ? deps.opaqueIds : () => true;
  /** id local → id que ve el servidor @param {string} lid */
  const wire = (lid) => (isOpaque(lid) ? serverId(deps.encKey, lid) : lid);
  /** id del servidor → id local @type {Map<string, string>} */
  const lids = new Map();
  /** @param {string} lid */
  const toServer = (lid) => {
    const sid = wire(lid);
    lids.set(sid, lid);
    return sid;
  };
  /** @type {(obj: Record<string, number>, fn: (k: string) => string) => Record<string, number>} */
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
 * Dependencias de una pasada: las de `syncOnce` más la correspondencia de ids opacos.
 * @typedef {SyncDeps & {
 *   lids: Map<string, string> | null,
 *   wire: ((lid: string) => string) | null,
 *   isLegacy?: (id: string) => boolean,
 * }} PassDeps
 */

/**
 * Una pasada de sincronización, en etapas:
 *   1. preparar   — lista remota, ids en claro antiguos, estado local y plan
 *   2. migrar     — baja los ids en claro aún no migrados (se aplican con id opaco)
 *   3. fusionar   — antes de subir, fusiona con lo que también cambió en el servidor
 *                   y resuelve conflictos (misma versión, distinta huella)
 *   4. subir      — sube lo local más nuevo (y lo fusionado)
 *   5. bajar      — baja lo más nuevo del servidor
 *   6. aplicar    — aplica lo bajado sobre el estado local ACTUAL
 * Cada etapa recibe el estado de la pasada (`PassState`) y lo deja explícito.
 * @param {PassDeps} deps
 */
async function syncPass(deps) {
  const p = await preparePass(deps);
  const legacyPulled = p.toMigrate.length ? await fetchItems(p, p.toMigrate, { fromLegacy: true }) : [];
  const merged = deps.mergeFn ? await mergeBeforePush(p) : 0;
  const { pushed, skipped } = await pushChanges(p);
  p.pulled.push(...(await fetchItems(p, p.plan.pull)), ...legacyPulled);
  const result = applyChanges(p);
  return {
    pushed,
    skipped,
    merged,
    added: result.added,
    updated: result.updated,
    deleted: result.deleted,
    // Lo migrado se sube con id opaco en la próxima pasada, y entonces se borra lo antiguo.
    needsPush: result.needsPush || skipped > 0 || p.plan.conflicts.length > 0 || legacyPulled.length > 0,
  };
}

/**
 * @typedef {Awaited<ReturnType<typeof preparePass>>} PassState
 */

/**
 * 1. Lista remota, ids en claro antiguos (se purgan los ya migrados), estado local y plan.
 * @param {PassDeps} deps
 */
async function preparePass(deps) {
  const { api, encKey, fingerprint, readLocal, lids, wire, isLegacy, cache } = deps;
  const remote = await listRemote(api, cache);

  // Ids en claro de versiones anteriores: no entran al plan. Si su versión
  // opaca ya está en el servidor, se borran; si no, se bajan y se aplican con
  // su id opaco (la próxima pasada los sube así).
  /** @type {SyncVersion[]} */
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
  /** @param {SyncVersion} l */
  const isMigrated = (l) => remote.has(wire(l.id)) && remote.get(wire(l.id)).u >= l.u;
  const migrated = legacy.filter(isMigrated);
  if (migrated.length) {
    await api.purge(migrated.map((l) => l.id));
    for (const l of migrated) cache?.snapshot?.delete(l.id);
  }

  const local0 = readLocal();
  const byId = new Map(local0.items.map((r) => [r.id, r]));
  const local = localVersions(local0.items, local0.tombstones);

  /**
   * Huella del contenido local de un id (solo para ids con el mismo número de
   * versión que el servidor). Si ya se verificó en una sincronización anterior
   * (misma versión local y misma huella remota), no se recalcula: lo local
   * solo cambia de contenido con una versión nueva o adoptando la del servidor.
   */
  /** @param {string} id */
  const hashOf = (id) => {
    const v = local.get(id);
    const rec = byId.get(id);
    const r = remote.get(id);
    const mark = `${v.u}|${v.deleted || !rec ? 'd' : 'r'}|${r?.h}`;
    if (cache && r?.h && cache.verified.get(id) === mark) return r.h;
    const h =
      v.deleted || !rec
        ? contentHash(encKey, id, v.u, 'eliminado', '')
        : contentHash(encKey, id, v.u, rec.kind, fingerprint(rec.kind, rec.data));
    if (cache && h === r?.h) cache.verified.set(id, mark);
    return h;
  };
  return {
    deps,
    remote,
    local0,
    byId,
    plan: planSync(local, remote, encKey && fingerprint ? hashOf : undefined),
    toMigrate: legacy.filter((l) => !isMigrated(l)),
    /** Lo que se aplicará sobre el estado local al final. */
    pulled: /** @type {ElementoBajado[]} */ ([]),
    /** Ids a subir además del plan (fusionados, conflictos resueltos). */
    extraPush: /** @type {string[]} */ ([]),
    /** Eliminaciones locales que suben de versión para ganar un conflicto. */
    tombBumps: /** @type {Record<string, number>} */ ({}),
  };
}

/**
 * Baja y descifra versiones del servidor (`fromLegacy`: ids en claro que se migran a opacos).
 * @param {PassState} p
 * @param {SyncVersion[]} list
 * @returns {Promise<ElementoBajado[]>}
 */
async function fetchItems(p, list, { fromLegacy = false } = {}) {
  const { api, key, batchSize = 100, lids, wire } = p.deps;
  /** @type {ElementoBajado[]} */
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
}

/**
 * 3. Fusionar antes de subir lo que también cambió en el servidor, y resolver
 * conflictos (mismo número de versión, distinto contenido).
 * @param {PassState} p
 * @returns {Promise<number>} cuántos elementos se fusionaron
 */
async function mergeBeforePush(p) {
  const { mergeFn } = p.deps;
  const { remote, byId, local0, plan, pulled, extraPush } = p;
  let merged = 0;
  /** @param {string} id */
  const isLiveLocal = (id) => byId.has(id) && !(local0.tombstones[id] >= byId.get(id).updated);
  const both = plan.push.filter((id) => remote.has(id) && isLiveLocal(id)).map((id) => ({ id, u: remote.get(id).u, h: remote.get(id).h }));
  const conflictIds = new Set(plan.conflicts.map((c) => c.id));
  for (const r of await fetchItems(p, [...both, ...plan.conflicts])) {
    const localItem = byId.get(r.id);
    const isConflict = conflictIds.has(r.id);
    if (!localItem || !isLiveLocal(r.id) || r.deleted || r.kind !== localItem.kind) {
      // Conflicto con una eliminación (o tipos distintos): se resuelve subiendo una versión nueva de lo local.
      if (isConflict) bump(p, r.id, r.u);
      continue;
    }
    const m = mergeFn(r.kind, localItem.data, { ...r.data, id: r.id, updated: r.u });
    if (!m) {
      if (isConflict) bump(p, r.id, r.u); // sin fusión posible: gana lo local con versión nueva
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
  return merged;
}

/**
 * Sube lo local con una versión mayor que `remoteU` (desempate de conflictos).
 * @param {PassState} p
 * @param {string} id
 * @param {number} remoteU
 */
function bump(p, id, remoteU) {
  const { byId, local0, pulled, tombBumps, extraPush } = p;
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

/**
 * 4. Subir lo local más nuevo (cifrado, con su huella de contenido).
 * @param {PassState} p
 */
async function pushChanges(p) {
  const { api, key, encKey, fingerprint, batchSize = 100, lids, cache } = p.deps;
  const { byId, local0, plan, extraPush } = p;
  let pushed = 0;
  let skipped = 0;
  for (const ids of chunks([...new Set([...plan.push, ...extraPush])], batchSize)) {
    const payload = await Promise.all(
      ids.map(async (id) => {
        const rec = byId.get(id);
        const tomb = local0.tombstones[id];
        const u = rec && (!tomb || rec.updated > tomb) ? rec.updated : tomb;
        /** @type {{kind?: string, data?: Record<string, unknown>, deleted?: boolean, lid?: string}} */
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
    // Lo subido ya está en el servidor: se anota para no volver a compararlo.
    if (cache?.snapshot) {
      const saved = new Set(res.saved || []);
      for (const it of payload) if (saved.has(it.id)) cache.snapshot.set(it.id, it.h ? { u: it.u, h: it.h } : { u: it.u });
    }
    pushed += res.saved?.length || 0;
    skipped += res.skipped?.length || 0;
  }
  return { pushed, skipped };
}

/**
 * 6. Aplicar lo bajado sobre el estado local ACTUAL (pudo cambiar mientras se esperaba la red).
 * @param {PassState} p
 */
function applyChanges(p) {
  const { readLocal, writeLocal, mergeFn } = p.deps;
  const { pulled, tombBumps } = p;
  if (!pulled.length && !Object.keys(tombBumps).length) return { added: 0, updated: 0, deleted: 0, needsPush: false };
  const cur = readLocal();
  const applied = applyPulled(cur.items, { ...cur.tombstones, ...tombBumps }, pulled, mergeFn);
  writeLocal(applied.items, applied.tombstones);
  return applied;
}
