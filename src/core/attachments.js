/**
 * Archivos adjuntos de una atención (imágenes, PDF, Word…) — lógica pura.
 *
 * Cada adjunto tiene dos partes:
 *   - METADATOS (pequeños): id, atención, nombre, tipo, tamaño, huella SHA-256 y
 *     número de partes. Se guardan y sincronizan como cualquier dato (tipo
 *     `adjunto`, en el espacio de la especialidad); eliminarlo deja una lápida.
 *   - CONTENIDO (los bytes): en una colección aparte de IndexedDB, que se lee
 *     solo cuando hace falta. Se sincroniza cifrado en partes de CHUNK_BYTES
 *     (espacio `<especialidad>-adjuntos`, ver sync/attachments.js).
 * El contenido nunca cambia: un adjunto se agrega o se elimina, no se edita.
 */
import { sha256, toHex } from '../lib/sha256.js';
import { unknownFields } from './compat.js';
import { isRecord } from './guards.js';

export const ATTACHMENT_LIMITS = Object.freeze({
  /** Tamaño máximo de un archivo (después de comprimir las fotos). */
  fileBytes: 20 * 1024 * 1024,
  /** Total por atención. */
  totalBytes: 60 * 1024 * 1024,
  /** Archivos por atención. */
  files: 30,
});

/**
 * Tamaño de cada parte al sincronizar. Cifrada y en base64 debe quedar bajo
 * el límite del servidor por elemento (400.000 caracteres): 192 KiB → ~350.000.
 */
export const CHUNK_BYTES = 192 * 1024;

/** Tipos que se aceptan al adjuntar (atributo `accept` del selector de archivos). */
export const ACCEPT = 'image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.odt,.txt,.rtf';

/**
 * Tipos que se pueden ABRIR en el navegador (en otra pestaña o como
 * miniatura): solo contenido pasivo. Cualquier otro tipo (en particular
 * image/svg+xml o text/html, que pueden llevar scripts) se DESCARGA como
 * binario genérico, nunca se abre: un adjunto no debe poder ejecutar código
 * en el origen de la app.
 */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

/** Tipo MIME normalizado (minúsculas, sin parámetros). @param {unknown} tipo */
export const cleanType = (tipo) =>
  String(tipo ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim()
    .slice(0, 100);

/** ¿Se puede abrir en el navegador? @param {unknown} tipo */
export const isInlineType = (tipo) => INLINE_TYPES.has(cleanType(tipo));

/** Clase de archivo, para decidir cómo mostrarlo y cómo incluirlo en el PDF con anexos. */
export function kindOf(tipo = '', nombre = '') {
  const t = String(tipo).toLowerCase();
  const ext = String(nombre).toLowerCase().split('.').pop() || '';
  if (t === 'image/jpeg' || t === 'image/png' || ['jpg', 'jpeg', 'png'].includes(ext)) return 'imagen';
  if (t.startsWith('image/')) return 'imagen-otra'; // webp, gif, heic…: se convierten o se incrustan
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/word|officedocument|opendocument|rtf/.test(t) || ['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'documento';
  return 'otro';
}

/** Id de un adjunto (no se confunde con atenciones `a…`, fichas `p_` ni perfiles `m_`). */
export const newAttachmentId = (now = Date.now(), rand = Math.random) => 'j' + now.toString(36) + rand().toString(36).slice(2, 8);

/** Id de la parte `n` del contenido de un adjunto (en el servidor). @param {string} attId @param {number} n */
export const chunkId = (attId, n) => `${attId}-${n}`;

/** Número de partes del contenido. @param {number} size */
export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_BYTES));

/** Nombre de archivo legible y seguro (sin rutas ni caracteres de control). @param {unknown} name */
export function safeFileName(name) {
  // `split` siempre devuelve al menos un trozo: el `?? ''` solo satisface al tipo de `pop`.
  const base = (
    String(name ?? '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .trim();
  return (base || 'adjunto').slice(0, 120);
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Miniatura de una imagen: JPEG pequeño en base64, guardado con los metadatos. */
export const THUMB_MAX_CHARS = 16_000;
const THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
/**
 * ¿Es una miniatura válida? (un dato recibido no puede traer otra cosa a un `src`)
 * @param {unknown} v
 * @returns {v is string}
 */
export const isThumbnail = (v) => typeof v === 'string' && v.length <= THUMB_MAX_CHARS && THUMB_RE.test(v);
const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * ¿Es un texto con esa forma? (`RegExp.test` convierte a texto lo que recibe:
 * sin revisar el tipo, `123` o `['j1']` pasarían por un id).
 * @param {RegExp} re @param {unknown} v
 * @returns {v is string}
 */
const matches = (re, v) => typeof v === 'string' && re.test(v);

/**
 * ¿Trae los identificadores de un adjunto (id, atención y huella del contenido)?
 * @param {unknown} raw
 * @returns {raw is Record<string, unknown> & {id: string, atencionId: string, sha256: string}}
 */
function hasAttachmentIds(raw) {
  if (!isRecord(raw) || !matches(ID_RE, raw.id) || !raw.id.startsWith('j')) return false;
  return matches(ID_RE, raw.atencionId) && matches(SHA_RE, raw.sha256);
}

/** ¿Es un tamaño de adjunto admisible (entero, de 0 al máximo)? @param {number} n */
const isAttachmentSize = (n) => Number.isSafeInteger(n) && n >= 0 && n <= ATTACHMENT_LIMITS.fileBytes;

/**
 * Normaliza los metadatos de un adjunto; null si no son válidos. Conserva los
 * campos de versiones más nuevas (ADR 0012).
 * @param {unknown} raw
 */
export function normalizeAttachment(raw) {
  if (!hasAttachmentIds(raw)) return null;
  const tamano = Number(raw.tamano);
  if (!isAttachmentSize(tamano)) return null;
  return {
    ...unknownFields(raw, ['id', 'atencionId', 'nombre', 'tipo', 'tamano', 'sha256', 'partes', 'created', 'updated', 'miniatura']),
    id: raw.id,
    atencionId: raw.atencionId,
    nombre: safeFileName(raw.nombre),
    tipo: cleanType(raw.tipo),
    tamano,
    sha256: raw.sha256,
    partes: chunkCount(tamano),
    created: Number(raw.created) || 0,
    updated: Number(raw.updated) || Number(raw.created) || 0,
    // Miniatura (desde la 2.15.0): se ve en todos los equipos antes de que llegue el contenido.
    ...(isThumbnail(raw.miniatura) ? { miniatura: raw.miniatura } : {}),
  };
}

/**
 * ¿Se puede agregar este archivo a la atención? Devuelve el motivo si no.
 * @param {{tamano: number}[]} existing adjuntos actuales de la atención
 * @param {number} size tamaño del archivo nuevo
 */
export function addProblem(existing, size) {
  const mb = (/** @type {number} */ n) => `${Math.round(n / 1024 / 1024)} MB`;
  if (size > ATTACHMENT_LIMITS.fileBytes) return `El archivo supera ${mb(ATTACHMENT_LIMITS.fileBytes)}.`;
  if (existing.length >= ATTACHMENT_LIMITS.files) return `La atención ya tiene ${ATTACHMENT_LIMITS.files} adjuntos.`;
  const total = existing.reduce((s, a) => s + (a.tamano || 0), 0) + size;
  if (total > ATTACHMENT_LIMITS.totalBytes) return `Los adjuntos de la atención superarían ${mb(ATTACHMENT_LIMITS.totalBytes)}.`;
  return null;
}

/** Divide el contenido en partes de CHUNK_BYTES. @param {Uint8Array} bytes */
export function splitChunks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) out.push(bytes.subarray(i, i + CHUNK_BYTES));
  return out.length ? out : [new Uint8Array(0)];
}

/** Une las partes. @param {Uint8Array[]} chunks */
export function joinChunks(chunks) {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Huella SHA-256 (hex) del contenido: usa la del navegador si está, si no la propia. @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return toHex(new Uint8Array(await subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes))));
  return toHex(sha256(bytes));
}

/** «2,4 MB», «380 KB». @param {number} n */
export function fmtSize(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
