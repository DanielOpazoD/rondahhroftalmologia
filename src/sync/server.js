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
import { sha256, toHex } from '../lib/sha256.js';
import { PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL, PROTOCOL_HEADER } from './protocol.js';

export const LIMITS = Object.freeze({ itemsPerRequest: 200, ctMaxChars: 400_000, futureSkewMs: 24 * 3600 * 1000 });

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
const keyOf = (esp, id, u, h) => `${esp}/r/${id}/${u}${h ? '.' + h : ''}`;
const keyRe = (esp) => new RegExp(`^${esp}/r/([A-Za-z0-9_-]{1,64})/(\\d{1,16})(?:\\.([0-9a-f]{16}))?$`);

/** Días que se conserva el índice de cambios (un equipo más atrasado recibe la lista completa). */
export const CHANGE_LOG_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const changeKey = (esp, t, id, u, h) => `${esp}/c/${dayOf(t)}/${t}.${id}.${u}.${h || ''}`;
const changeRe = (esp) => new RegExp(`^${esp}/c/(\\d{8})/(\\d{1,16})\\.([A-Za-z0-9_-]{1,64})\\.(\\d{1,16})\\.([0-9a-f]{16})?$`);

/** Orden de versiones: número y, a igual número, huella (desempate determinista). */
const newer = (a, b) => a.u > b.u || (a.u === b.u && (a.h || '') > (b.h || ''));

/** Comparación en tiempo constante de dos strings hex. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Ejecuta `fn` sobre los elementos con concurrencia limitada. */
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

/** Versiones existentes de un id, de la más nueva a la más antigua: [{u, h, key}]. */
async function versionsOf(store, esp, id) {
  const { blobs } = await store.list({ prefix: `${esp}/r/${id}/` });
  const re = keyRe(esp);
  return blobs
    .map((b) => [b.key, re.exec(b.key)])
    .filter(([, m]) => m && m[1] === id)
    .map(([key, m]) => ({ key, u: Number(m[2]), h: m[3] }))
    .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
}

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
 *   store: {list: Function, get: Function, setJSON: Function, delete: Function},
 *   tokenHash?: string | ((esp: string) => string | undefined),
 *   now?: () => number,
 * }} deps  `tokenHash` puede depender de la especialidad (contraseña distinta por ronda).
 * @returns {(req: Request) => Promise<Response>}
 */
export function createSyncHandler({ store, tokenHash: tokenHashOpt, now = Date.now }) {
  /**
   * Toda respuesta declara la versión de protocolo del servidor. Un cliente
   * que declara una versión menor a la mínima recibe 426 con el aviso de
   * actualizar. Los clientes anteriores a la 2.12 no la declaran y se aceptan.
   */
  return async function withProtocol(req) {
    const declared = req.headers.get(PROTOCOL_HEADER);
    const res =
      declared !== null && !(Number(declared) >= MIN_CLIENT_PROTOCOL)
        ? json(426, {
            error: 'Esta versión de la app es demasiado antigua para el servidor. Recarga la página para actualizarla.',
            minProtocol: MIN_CLIENT_PROTOCOL,
          })
        : await handle(req);
    res.headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    return res;
  };

  async function handle(req) {
    const url = new URL(req.url);
    const esp = url.searchParams.get('esp') || DEFAULT_ESP;
    if (!ESP_RE.test(esp)) return json(400, { error: 'Especialidad inválida' });
    const tokenHash = typeof tokenHashOpt === 'function' ? tokenHashOpt(esp) : tokenHashOpt;
    if (!tokenHash || !/^[0-9a-f]{64}$/.test(tokenHash)) {
      return json(503, { error: 'Sincronización no configurada en el servidor (falta SYNC_TOKEN_SHA256).' });
    }
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || !safeEqual(toHex(sha256(token)), tokenHash)) {
      return json(401, { error: 'Contraseña del equipo incorrecta para este servidor.' });
    }

    const action = url.pathname.split('/').filter(Boolean).pop();
    const re = keyRe(esp);
    try {
      if (req.method === 'GET' && action === 'list') {
        const t0 = now();
        const latest = new Map();
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
        let body;
        try {
          body = await req.json();
        } catch {
          return json(400, { error: 'JSON inválido' });
        }
        const items = Array.isArray(body?.items) ? body.items : null;
        if (!items || items.length > LIMITS.itemsPerRequest) {
          return json(400, { error: `Se esperan entre 0 y ${LIMITS.itemsPerRequest} elementos en "items"` });
        }
        const t = now();
        if (!items.every((it) => validItem(it, t, action === 'put'))) return json(400, { error: 'Elemento inválido' });

        if (action === 'get') {
          const out = await mapLimit(items, 16, async ({ id, u, h }) => {
            const v = await store.get(keyOf(esp, id, u, h), { type: 'json' });
            return v && v.iv && v.ct ? { id, u, ...(h ? { h } : {}), iv: v.iv, ct: v.ct } : { id, u, missing: true };
          });
          return json(200, { items: out });
        }

        // put
        const saved = [];
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
        return json(200, { saved, skipped });
      }

      if (req.method === 'POST' && action === 'purge') {
        let body;
        try {
          body = await req.json();
        } catch {
          return json(400, { error: 'JSON inválido' });
        }
        const ids = Array.isArray(body?.ids) ? body.ids : null;
        if (!ids || ids.length > LIMITS.itemsPerRequest || !ids.every((id) => typeof id === 'string' && LEGACY_ID_RE.test(id))) {
          return json(400, { error: 'Solo se pueden borrar ids antiguos en claro' });
        }
        const purged = [];
        await mapLimit(ids, 8, async (id) => {
          const existing = await versionsOf(store, esp, id);
          await Promise.all(existing.map((old) => store.delete(old.key)));
          if (existing.length) purged.push(id);
        });
        return json(200, { purged });
      }

      return json(404, { error: 'Ruta no encontrada' });
    } catch (e) {
      console.error('sync error', e);
      return json(500, { error: 'Error interno del servidor de sincronización' });
    }
  }
}

/** Almacenamiento en memoria con la misma interfaz que Netlify Blobs (tests y servidor local). */
export function memoryBlobStore() {
  const m = new Map();
  return {
    async list({ prefix = '' } = {}) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: '' })), directories: [] };
    },
    async get(key) {
      return m.has(key) ? JSON.parse(m.get(key)) : null;
    },
    async setJSON(key, v) {
      m.set(key, JSON.stringify(v));
    },
    async delete(key) {
      m.delete(key);
    },
    _map: m,
  };
}
