/**
 * Cifrado de extremo a extremo para la sincronización entre equipos.
 *
 * - Todos los equipos comparten una CONTRASEÑA DEL EQUIPO que nunca sale del PC.
 * - De ella se derivan (PBKDF2-SHA256) 512 bits:
 *     · 256 bits -> clave AES-256-GCM con que se cifra cada atención;
 *     · 256 bits -> token de acceso al servidor (el servidor solo conoce su SHA-256).
 * - Cada atención se cifra con un IV aleatorio y con "datos asociados"
 *   `id|versión`, para que el servidor no pueda intercambiar contenidos entre
 *   registros ni cambiar su versión sin que se detecte.
 *
 * Usa WebCrypto (`crypto.subtle`): disponible en https (Netlify), en localhost
 * y en Node ≥ 20 (tests). No disponible al abrir el archivo con doble clic (file://).
 */
import { sha256, toHex, utf8 } from '../lib/sha256.js';

const SALT = 'hhr-oftalmo-sync-v1';
export const PBKDF2_ITERATIONS = 310_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class DecryptError extends Error {}

/** ¿Hay WebCrypto en este contexto? */
export function cryptoAvailable() {
  return !!globalThis.crypto?.subtle;
}

/* ------------------------------------------------------------ base64 */

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------- contraseña */

/**
 * Contraseña aleatoria fácil de dictar: "K7QM3-XRT9P-ZAWD4-N8F2C" (100 bits).
 * Sin letras ambiguas (I, L, O, U).
 */
export function generatePassphrase(rng = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = rng(20);
  const chars = Array.from(bytes, (b) => CROCKFORD[b & 31]).join('');
  return chars.match(/.{5}/g).join('-');
}

/**
 * Normaliza la contraseña: si tiene el formato generado, sin importar
 * mayúsculas ni espacios; si no, solo quita espacios en los extremos.
 */
export function normalizePassphrase(p) {
  const s = String(p ?? '').trim();
  const compact = s.toUpperCase().replace(/[\s-]/g, '');
  if (/^[0-9A-HJKMNP-TV-Z]{20}$/.test(compact)) return compact.match(/.{5}/g).join('-');
  return s;
}

/** Reglas mínimas para una contraseña elegida a mano. */
export function passphraseProblem(p) {
  const s = normalizePassphrase(p);
  if (s.length < 16) return 'La contraseña del equipo debe tener al menos 16 caracteres (usa «Generar»).';
  return null;
}

/* ---------------------------------------------------------- claves */

/**
 * Deriva la clave de cifrado y el token del servidor a partir de la contraseña.
 * @returns {Promise<{encKey: string, token: string}>} encKey en base64, token en hex
 */
export async function deriveTeamKeys(passphrase, iterations = PBKDF2_ITERATIONS) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', utf8(normalizePassphrase(passphrase)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8(SALT), iterations }, base, 512),
  );
  return { encKey: bytesToB64(bits.slice(0, 32)), token: toHex(bits.slice(32)) };
}

/** Valor que se configura en Netlify (variable SYNC_TOKEN_SHA256). */
export function tokenHash(token) {
  return toHex(sha256(token));
}

/** Importa la clave AES guardada (base64). */
export function importEncKey(encKeyB64) {
  return globalThis.crypto.subtle.importKey('raw', b64ToBytes(encKeyB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const aad = (id, u) => utf8(`${id}|${u}`);

/**
 * Cifra un objeto ligado a (id, versión).
 * @returns {Promise<{iv: string, ct: string}>} base64
 */
export async function encryptPayload(key, id, u, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id, u) }, key, utf8(JSON.stringify(obj)));
  return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

/**
 * Descifra y verifica. Lanza DecryptError si la clave no corresponde o el
 * contenido fue alterado.
 */
export async function decryptPayload(key, id, u, { iv, ct }) {
  try {
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv), additionalData: aad(id, u) }, key, b64ToBytes(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new DecryptError('No se pudo descifrar: la contraseña del equipo no coincide o el dato fue alterado');
  }
}
