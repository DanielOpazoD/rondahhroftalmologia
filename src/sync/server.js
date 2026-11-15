/**
 * Lógica del servidor de sincronización (Netlify Function).
 *
 * El servidor NO puede leer los datos: guarda bloques cifrados por el cliente.
 * Solo conoce, por atención: un id aleatorio y su versión (fecha de modificación).
 *
 * Almacenamiento (Netlify Blobs), separado por especialidad:
 *     <especialidad>/r/<id>/<versión>  ->  { iv, ct }      (base64, AES-256-GCM)
 * Al escribir una versión nueva se borran las anteriores del mismo id.
 *
 * API (todas requieren `Authorization: Bearer <token>` y `?esp=<especialidad>`,
 * por omisión `oftalmologia`):
 *   GET  /api/sync/list   -> { items: [{id, u, h}], now, full: true }   versión vigente de cada id
 *   GET  /api/sync/list?since=<ms>  -> { items, now, full: false }      solo lo cambiado desde `since`
 *        (hora del servidor; si `since` es muy antiguo o no hay, responde la lista completa)
 *   POST /api/sync/get    { items: [{id, u, h}] }            -> { items: [{id, u, h, iv, ct} | {id, u, missing}] }
 *   POST /api/sync/put    { items: [{id, u, h, iv, ct}] }    -> { saved: [id], skipped: [id] }
 *   POST /api/sync/purge  { ids: [id] }                      -> { purged: [id] }   (solo ids antiguos en claro, ver LEGACY_ID_RE)
 * `h` = huella de 16 hex del contenido (opcional por compatibilidad).
 *
 * Índice de cambios: cada versión escrita deja además una marca vacía
 *     <especialidad>/c/<AAAAMMDD>/<hora>.<id>.<versión>.<huella>
 * Con ella, `list?since=` lee solo los días recientes en lugar de todas las
 * claves. Las marcas de más de CHANGE_LOG_DAYS días se borran al listar completo.
 *
 * Se escribe contra una interfaz mínima de "store" (list/get/setJSON/delete)
 * para poder probarla en Node con un almacenamiento en memoria.
 */
import { sha256, hmacSha256, toHex } from '../lib/sha256.js';
import { PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL, PROTOCOL_HEADER } from './protocol.js';

/** @typedef {import('../domain').SyncVersion} SyncVersion */
/** @typedef {import('../domain').SyncBlob} SyncBlob */
/**
 * Interfaz mínima de almacenamiento (la de Netlify Blobs que se usa aquí).
 * `get` devuelve el JSON guardado (o null si no existe).
 * @typedef {{
 *   list: (opts?: {prefix?: string}) => Promise<{blobs: {key: string}[]}>,
 *   get: (key: string, opts?: {type: 'json'}) => Promise<unknown>,
 *   setJSON: (key: string, value: unknown) => Promise<unknown>,
 *   delete: (key: string) => Promise<unknown>,
 * }} BlobStore
 */

export const LIMITS = Object.freeze({
  itemsPerRequest: 200,
  ctMaxChars: 400_000,
  futureSkewMs: 24 * 3600 * 1000,
  /** Tamaño máximo del cuerpo de una solicitud (Netlify Functions acepta hasta ~6 MB). */
  bodyMaxBytes: 5_500_000,
});

/**
 * Límite de intentos fallidos de contraseña por red de origen: tras
 * `maxFails` en `windowMs`, esa red recibe 429 durante `blockMs`. Una
 * solicitud con la contraseña CORRECTA nunca se bloquea (en el hospital varios
 * PC comparten la misma IP pública). La IP no se guarda: solo un HMAC con un
 * secreto del servidor.
 */
export const AUTH_LIMIT = Object.freeze({ maxFails: 20, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });

/** IP de origen según los encabezados de Netlify / proxy. @param {Request} req */
const clientIp = (req) =>
  req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'desconocida';

/** Método HTTP de cada acción. @type {Readonly<Record<string, 'GET' | 'POST'>>} */
const ROUTES = Object.freeze({ list: 'GET', get: 'POST', put: 'POST', purge: 'POST' });

/**
 * Respuesta de error con un `code` estable (para el cliente) y el texto para
 * mostrar. Los códigos no cambian aunque cambie la redacción del mensaje.
 * @param {number} status
 * @param {string} code
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
const fail = (status, code, error, extra = {}) => json(status, { error, code, ...extra });

class BodyError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Lee el cuerpo JSON con límite de tamaño.
 * @param {Request} req
 * @returns {Promise<any>} JSON de la solicitud, sin validar
 */
async function readJson(req) {
  const declared = Number(req.headers.get('content-length'));
  if (declared > LIMITS.bodyMaxBytes) throw new BodyError(413, 'demasiado_grande', 'La solicitud es demasiado grande');
  const text = await req.text();
  if (text.length > LIMITS.bodyMaxBytes) throw new BodyError(413, 'demasiado_grande', 'La solicitud es demasiado grande');
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, 'json_invalido', 'JSON inválido');
  }
}

/** Id de solicitud para correlacionar registros (no contiene datos). */
const requestId = () =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ESP_RE = /^[a-z][a-z0-9-]{1,39}$/;
/**
 * Ids en claro que versiones anteriores derivaban de datos personales (médico:
 * `m_` + 8, paciente: `p_` + 10). Hoy viajan con id opaco; `purge` solo puede
 * borrar ids con esta forma (nunca atenciones ni ids opacos).
 */
export const LEGACY_ID_RE = /^(?:m_[0-9a-z]{8}|p_[0-9a-z]{10})$/;
export const DEFAULT_ESP = 'oftalmologia';
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const H_RE = /^[0-9a-f]{16}$/;
/**
 * Clave de una versión: `<esp>/r/<id>/<versión>.<huella>`. La huella (HMAC
 * del contenido, calculada por el cliente con su clave) permite a los equipos
 * detectar dos versiones con el mismo número y distinto contenido. Sin huella
 * (versiones antiguas) la clave es `<esp>/r/<id>/<versión>`.
 */
/** @type {(esp: string, id: string, u: number, h?: string) => string} */
const keyOf = (esp, id, u, h) => `${esp}/r/${id}/${u}${h ? '.' + h : ''}`;
/** @param {string} esp */
const keyRe = (esp) => new RegExp(`^${esp}/r/([A-Za-z0-9_-]{1,64})/(\\d{1,16})(?:\\.([0-9a-f]{16}))?$`);

/** Días que se conserva el índice de cambios (un equipo más atrasado recibe la lista completa). */
export const CHANGE_LOG_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
/** @param {number} t */
const dayOf = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
/** @type {(esp: string, t: number, id: string, u: number, h?: string) => string} */
const changeKey = (esp, t, id, u, h) => `${esp}/c/${dayOf(t)}/${t}.${id}.${u}.${h || ''}`;
/** @param {string} esp */
const changeRe = (esp) => new RegExp(`^${esp}/c/(\\d{8})/(\\d{1,16})\\.([A-Za-z0-9_-]{1,64})\\.(\\d{1,16})\\.([0-9a-f]{16})?$`);

/** Orden de versiones: número y, a igual número, huella (desempate determinista). @type {(a: {u: number, h?: string}, b: {u: number, h?: string}) => boolean} */
const newer = (a, b) => a.u > b.u || (a.u === b.u && (a.h || '') > (b.h || ''));

/**
 * Comparación en tiempo constante de dos strings hex.
 * @param {unknown} a
 * @param {unknown} b
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** @type {(status: number, body: unknown) => Response} */
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * Ejecuta `fn` sobre los elementos con concurrencia limitada.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Versiones existentes de un id, de la más nueva a la más antigua: [{u, h, key}].
 * @param {BlobStore} store
 * @param {string} esp
 * @param {string} id
 * @returns {Promise<{key: string, u: number, h: string | undefined}[]>}
 */
async function versionsOf(store, esp, id) {
  const { blobs } = await store.list({ prefix: `${esp}/r/${id}/` });
  const re = keyRe(esp);
  return blobs
    .map((b) => /** @type {[string, RegExpExecArray | null]} */ ([b.key, re.exec(b.key)]))
    .filter(([, m]) => m && m[1] === id)
    .map(([key, m]) => ({ key, u: Number(m[2]), h: m[3] }))
    .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
}

/**
 * ¿Es un elemento válido de `get` (sin contenido) o `put` (con iv y ct)?
 * @param {any} it elemento del cuerpo JSON, sin validar
 * @param {number} now
 * @param {boolean} withPayload
 * @returns {boolean}
 */
function validItem(it, now, withPayload) {
  if (!it || typeof it !== 'object') return false;
  if (!ID_RE.test(it.id)) return false;
  if (!Number.isSafeInteger(it.u) || it.u <= 0 || it.u > now + LIMITS.futureSkewMs) return false;
  if (it.h !== undefined && !H_RE.test(it.h)) return false;
  if (!withPayload) return true;
  return (
    typeof it.iv === 'string' &&
    B64_RE.test(it.iv) &&
    it.iv.length === 16 &&
    typeof it.ct === 'string' &&
    B64_RE.test(it.ct) &&
    it.ct.length > 0 &&
    it.ct.length <= LIMITS.ctMaxChars
  );
}

/**
 * @param {{
 *   store: BlobStore,
 *   tokenHash?: string | ((esp: string) => string | undefined),
 *   now?: () => number,
 *   log?: (entry: {reqId: string, action: string, esp: string, status: number, ms: number, code?: string}) => void,
 *   authLimit?: {maxFails: number, windowMs: number, blockMs: number} | false,
 *   accounts?: ReturnType<typeof import('./accounts.js').createAccounts>,
 * }} deps  `tokenHash` puede depender de la especialidad (contraseña distinta por ronda).
 *   `log`: registro estructurado de cada solicitud (sin token ni datos; la función de Netlify lo escribe en sus logs).
 *   `accounts`: cuentas de usuario (ADR 0014). Una vez activadas, se exige sesión de usuario en vez de la
 *   contraseña del equipo, y cada escritura queda en el registro de accesos.
 * @returns {(req: Request) => Promise<Response>}
 */
export function createSyncHandler({ store, tokenHash: tokenHashOpt, now = Date.now, log = () => {}, authLimit = AUTH_LIMIT, accounts }) {
  /**
   * Toda respuesta declara la versión de protocolo del servidor. Un cliente
   * que declara una versión menor a la mínima recibe 426 con el aviso de
   * actualizar. Los clientes anteriores a la 2.12 no la declaran y se aceptan.
   */
  return async function withProtocol(req) {
    const started = Date.now();
    const reqId = requestId();
    const declared = req.headers.get(PROTOCOL_HEADER);
    const res =
      declared !== null && !(Number(declared) >= MIN_CLIENT_PROTOCOL)
        ? fail(
            426,
            'cliente_antiguo',
            'Esta versión de la app es demasiado antigua para el servidor. Recarga la página para actualizarla.',
            {
              minProtocol: MIN_CLIENT_PROTOCOL,
            },
          )
        : await handle(req, reqId);
    res.headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    res.headers.set('x-request-id', reqId);
    res.headers.set('x-content-type-options', 'nosniff');
    const url = new URL(req.url);
    let code;
    if (res.status >= 400) {
      code = (
        await res
          .clone()
          .json()
          .catch(() => ({}))
      ).code;
    }
    log({
      reqId,
      action: url.pathname.split('/').filter(Boolean).pop() || '',
      esp: url.searchParams.get('esp') || DEFAULT_ESP,
      status: res.status,
      ms: Date.now() - started,
      ...(code ? { code } : {}),
    });
    return res;
  };

  /**
   * Anota un intento fallido de la red de origen. Devuelve los ms que falta
   * esperar si esa red quedó bloqueada (0 si no).
   * @param {Request} req
   * @param {string} secret secreto del servidor para no guardar la IP en claro
   */
  async function registerFailure(req, secret) {
    if (!authLimit) return 0;
    const key = '_limites/' + toHex(hmacSha256(secret, 'ip:' + clientIp(req))).slice(0, 32);
    const t = now();
    const cur = /** @type {{first?: number, fails?: number, until?: number} | null} */ (await store.get(key, { type: 'json' }));
    if (cur?.until && cur.until > t) return cur.until - t;
    const fresh = !cur?.first || t - cur.first > authLimit.windowMs || (cur.until && cur.until <= t);
    const next = { first: fresh ? t : /** @type {number} */ (cur?.first), fails: (fresh ? 0 : cur?.fails || 0) + 1, until: 0 };
    if (next.fails >= authLimit.maxFails) next.until = t + authLimit.blockMs;
    await store.setJSON(key, next);
    return next.until ? next.until - t : 0;
  }

  /**
   * @param {Request} req
   * @param {string} reqId
   * @returns {Promise<Response>}
   */
  async function handle(req, reqId) {
    const url = new URL(req.url);
    const esp = url.searchParams.get('esp') || DEFAULT_ESP;
    if (!ESP_RE.test(esp)) return fail(400, 'especialidad_invalida', 'Especialidad inválida');
    /** Sesión de usuario de la solicitud (con cuentas activadas). @type {import('./accounts.js').Autenticado | null} */
    let session = null;
    if (accounts && (await accounts.active())) {
      // Con cuentas activadas, la contraseña del equipo ya no sirve para sincronizar.
      const a = await accounts.authenticate(req);
      if ('response' in a) return a.response;
      if (a.mustChange) return fail(403, 'debe_cambiar_clave', 'Primero cambia tu clave inicial.');
      session = a;
    } else {
      const denied = await checkTeamToken(req, esp);
      if (denied) return denied;
    }
    return route(req, url, esp, session, reqId);
  }

  /**
   * Contraseña del equipo (antes de activar las cuentas). Devuelve la respuesta
   * de error, o null si es correcta.
   * @param {Request} req
   * @param {string} esp
   * @returns {Promise<Response | null>}
   */
  async function checkTeamToken(req, esp) {
    const tokenHash = typeof tokenHashOpt === 'function' ? tokenHashOpt(esp) : tokenHashOpt;
    if (!tokenHash || !/^[0-9a-f]{64}$/.test(tokenHash)) {
      return fail(503, 'no_configurado', 'Sincronización no configurada en el servidor (falta SYNC_TOKEN_SHA256).');
    }
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || !safeEqual(toHex(sha256(token)), tokenHash)) {
      if (authLimit) {
        const blocked = await registerFailure(req, tokenHash);
        if (blocked) {
          const r = fail(429, 'demasiados_intentos', 'Demasiados intentos con una contraseña incorrecta. Espera unos minutos.');
          r.headers.set('retry-after', String(Math.ceil(blocked / 1000)));
          return r;
        }
      }
      return fail(401, 'token_invalido', 'Contraseña del equipo incorrecta para este servidor.');
    }
    return null;
  }

  /**
   * @param {Request} req
   * @param {URL} url
   * @param {string} esp
   * @param {import('./accounts.js').Autenticado | null} session
   * @param {string} reqId
   * @returns {Promise<Response>}
   */
  async function route(req, url, esp, session, reqId) {
    const action = url.pathname.split('/').filter(Boolean).pop() || '';
    if (!Object.hasOwn(ROUTES, action)) return fail(404, 'ruta', 'Ruta no encontrada');
    if (req.method !== ROUTES[action]) {
      const r = fail(405, 'metodo', `Usa ${ROUTES[action]} para ${action}`);
      r.headers.set('allow', ROUTES[action]);
      return r;
    }
    const re = keyRe(esp);
    try {
      if (req.method === 'GET' && action === 'list') {
        const t0 = now();
        /** @type {Map<string, {u: number, h?: string}>} */
        const latest = new Map();
        /** @type {(id: string, v: {u: number, h?: string}) => void} */
        const keep = (id, v) => {
          if (!latest.has(id) || newer(v, latest.get(id))) latest.set(id, v);
        };
        const items = () => [...latest].map(([id, { u, h }]) => (h ? { id, u, h } : { id, u }));
        const since = Number(url.searchParams.get('since'));
        if (Number.isSafeInteger(since) && since > 0 && since <= t0 && t0 - since < CHANGE_LOG_DAYS * DAY_MS) {
          // Solo los días desde `since`: pocas claves aunque haya años de datos.
          const cre = changeRe(esp);
          for (let d = since - (since % DAY_MS); d <= t0; d += DAY_MS) {
            const { blobs } = await store.list({ prefix: `${esp}/c/${dayOf(d)}/` });
            for (const b of blobs) {
              const m = cre.exec(b.key);
              if (m && Number(m[2]) >= since) keep(m[3], { u: Number(m[4]), h: m[5] });
            }
          }
          return json(200, { items: items(), now: t0, full: false });
        }
        const { blobs } = await store.list({ prefix: `${esp}/r/` });
        for (const b of blobs) {
          const m = re.exec(b.key);
          if (m) keep(m[1], { u: Number(m[2]), h: m[3] });
        }
        // Limpieza del índice de cambios antiguo (pocas claves: solo la actividad reciente).
        const cutoff = dayOf(t0 - (CHANGE_LOG_DAYS + 2) * DAY_MS);
        const { blobs: marks } = await store.list({ prefix: `${esp}/c/` });
        const old = marks.filter((b) => b.key.slice(esp.length + 3, esp.length + 11) < cutoff);
        await mapLimit(old, 8, (b) => store.delete(b.key));
        return json(200, { items: items(), now: t0, full: true });
      }

      if (req.method === 'POST' && (action === 'get' || action === 'put')) {
        const body = await readJson(req);
        /** @type {SyncBlob[] | null} validados abajo con validItem (en `get`, sin iv ni ct) */
        const items = Array.isArray(body?.items) ? body.items : null;
        if (!items || items.length > LIMITS.itemsPerRequest) {
          return fail(400, 'lote_invalido', `Se esperan entre 0 y ${LIMITS.itemsPerRequest} elementos en "items"`);
        }
        const t = now();
        if (!items.every((it) => validItem(it, t, action === 'put'))) return fail(400, 'elemento_invalido', 'Elemento inválido');

        if (action === 'get') {
          const out = await mapLimit(items, 16, async ({ id, u, h }) => {
            const v = /** @type {{iv?: string, ct?: string} | null} */ (await store.get(keyOf(esp, id, u, h), { type: 'json' }));
            return v && v.iv && v.ct ? { id, u, ...(h ? { h } : {}), iv: v.iv, ct: v.ct } : { id, u, missing: true };
          });
          return json(200, { items: out });
        }

        // put
        /** @type {string[]} */
        const saved = [];
        /** @type {string[]} */
        const skipped = [];
        await mapLimit(items, 8, async ({ id, u, h, iv, ct }) => {
          const existing = await versionsOf(store, esp, id);
          if (existing.length && existing[0].u >= u) {
            // El servidor ya tiene este número de versión o uno mayor. El equipo
            // lo detectará (por número o por huella distinta) y fusionará.
            skipped.push(id);
            return;
          }
          // Primero la marca del índice: si falla lo siguiente, el reintento la
          // reescribe; al revés, una versión podría quedar sin marca.
          // Hora de la marca: la del momento de escribirla (no la del inicio de la
          // solicitud), para que el margen del cursor de los clientes la cubra
          // aunque la solicitud haya tardado.
          await store.setJSON(changeKey(esp, now(), id, u, h), 1);
          await store.setJSON(keyOf(esp, id, u, h), { iv, ct });
          await Promise.all(existing.map((old) => store.delete(old.key)));
          saved.push(id);
        });
        // Registro de accesos: quién escribió, cuántos elementos y dónde (el servidor no ve qué).
        if (session && saved.length) {
          await accounts?.audit({ ev: 'sync.escribir', u: session.user.id, s: session.sid, n: saved.length, esp });
        }
        return json(200, { saved, skipped });
      }

      if (req.method === 'POST' && action === 'purge') {
        const body = await readJson(req);
        /** @type {unknown[] | null} */
        const ids = Array.isArray(body?.ids) ? body.ids : null;
        if (!ids || ids.length > LIMITS.itemsPerRequest || !ids.every((id) => typeof id === 'string' && LEGACY_ID_RE.test(id))) {
          return fail(400, 'purga_invalida', 'Solo se pueden borrar ids antiguos en claro');
        }
        /** @type {string[]} */
        const purged = [];
        await mapLimit(/** @type {string[]} */ (ids), 8, async (id) => {
          const existing = await versionsOf(store, esp, id);
          await Promise.all(existing.map((old) => store.delete(old.key)));
          if (existing.length) purged.push(id);
        });
        return json(200, { purged });
      }

      return fail(404, 'ruta', 'Ruta no encontrada');
    } catch (e) {
      if (e instanceof BodyError) return fail(e.status, e.code, e.message);
      console.error('sync error', reqId, e);
      return fail(500, 'interno', 'Error interno del servidor de sincronización');
    }
  }
}

/** Almacenamiento en memoria con la misma interfaz que Netlify Blobs (tests y servidor local). */
export function memoryBlobStore() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return {
    /** @param {{prefix?: string}} [opts] */
    async list({ prefix = '' } = {}) {
      return {
        blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: '' })),
        directories: /** @type {string[]} */ ([]),
      };
    },
    /** @param {string} key */
    async get(key) {
      return m.has(key) ? JSON.parse(m.get(key)) : null;
    },
    /**
     * @param {string} key
     * @param {unknown} v
     */
    async setJSON(key, v) {
      m.set(key, JSON.stringify(v));
    },
    /** @param {string} key */
    async delete(key) {
      m.delete(key);
    },
    _map: m,
  };
}
