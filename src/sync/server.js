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
 *   GET  /api/sync/list   -> { items: [{id, u}] }
 *   POST /api/sync/get    { items: [{id, u}] }            -> { items: [{id, u, iv, ct} | {id, u, missing}] }
 *   POST /api/sync/put    { items: [{id, u, iv, ct}] }    -> { saved: [id], skipped: [id] }
 *
 * Se escribe contra una interfaz mínima de "store" (list/get/setJSON/delete)
 * para poder probarla en Node con un almacenamiento en memoria.
 */
import { sha256, toHex } from '../lib/sha256.js';

export const LIMITS = Object.freeze({ itemsPerRequest: 200, ctMaxChars: 400_000, futureSkewMs: 24 * 3600 * 1000 });

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ESP_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const DEFAULT_ESP = 'oftalmologia';
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const keyOf = (esp, id, u) => `${esp}/r/${id}/${u}`;
const keyRe = (esp) => new RegExp(`^${esp}/r/([A-Za-z0-9_-]{1,64})/(\\d{1,16})$`);

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

/** Versiones existentes de un id (ordenadas de mayor a menor). */
async function versionsOf(store, esp, id) {
  const { blobs } = await store.list({ prefix: `${esp}/r/${id}/` });
  const re = keyRe(esp);
  return blobs
    .map((b) => re.exec(b.key))
    .filter((m) => m && m[1] === id)
    .map((m) => Number(m[2]))
    .sort((a, b) => b - a);
}

function validItem(it, now, withPayload) {
  if (!it || typeof it !== 'object') return false;
  if (!ID_RE.test(it.id)) return false;
  if (!Number.isSafeInteger(it.u) || it.u <= 0 || it.u > now + LIMITS.futureSkewMs) return false;
  if (!withPayload) return true;
  return (
    typeof it.iv === 'string' && B64_RE.test(it.iv) && it.iv.length === 16 &&
    typeof it.ct === 'string' && B64_RE.test(it.ct) && it.ct.length > 0 && it.ct.length <= LIMITS.ctMaxChars
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
  return async function handle(req) {
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
        const { blobs } = await store.list({ prefix: `${esp}/r/` });
        const latest = new Map();
        for (const b of blobs) {
          const m = re.exec(b.key);
          if (!m) continue;
          const u = Number(m[2]);
          if (!latest.has(m[1]) || latest.get(m[1]) < u) latest.set(m[1], u);
        }
        return json(200, { items: [...latest].map(([id, u]) => ({ id, u })) });
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
          const out = await mapLimit(items, 16, async ({ id, u }) => {
            const v = await store.get(keyOf(esp, id, u), { type: 'json' });
            return v && v.iv && v.ct ? { id, u, iv: v.iv, ct: v.ct } : { id, u, missing: true };
          });
          return json(200, { items: out });
        }

        // put
        const saved = [];
        const skipped = [];
        await mapLimit(items, 8, async ({ id, u, iv, ct }) => {
          const existing = await versionsOf(store, esp, id);
          if (existing.length && existing[0] >= u) {
            skipped.push(id); // el servidor ya tiene esta versión o una más nueva
            return;
          }
          await store.setJSON(keyOf(esp, id, u), { iv, ct });
          await Promise.all(existing.map((old) => store.delete(keyOf(esp, id, old))));
          saved.push(id);
        });
        return json(200, { saved, skipped });
      }

      return json(404, { error: 'Ruta no encontrada' });
    } catch (e) {
      console.error('sync error', e);
      return json(500, { error: 'Error interno del servidor de sincronización' });
    }
  };
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
