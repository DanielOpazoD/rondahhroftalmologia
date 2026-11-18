/**
 * Criptografía de las cuentas de usuario, en el PC (ADR 0014).
 *
 *   maestra   = PBKDF2-SHA256(clave, sal de la cuenta, 310 000)
 *   acceso    = HKDF(maestra, "acceso")    → se envía al servidor (que guarda HMAC(secreto, acceso))
 *   envoltura = HKDF(maestra, "envoltura") → nunca sale del PC
 *   local     = HKDF(maestra, "local")     → para entrar sin conexión en este PC
 *
 * La clave del equipo (`K`, la que cifra los datos) se guarda en el servidor
 * ENVUELTA con AES-GCM usando HMAC(envoltura, complemento): el complemento lo
 * entrega el servidor solo tras un inicio de sesión correcto, así que una copia
 * del almacén por sí sola no permite probar claves sin conexión.
 *
 * El perfil de la cuenta (nombre, RUT, profesión) va cifrado con `K`.
 */
import { nameParts, personName } from '../core/names.js';
import { utf8, toHex, hmacSha256 } from '../lib/sha256.js';
import { bytesToB64, b64ToBytes, encryptPayload, decryptPayload, DecryptError, isObject } from './crypto.js';

/**
 * Iteraciones de PBKDF2 de las claves personales. El servidor responde la sal
 * de un RUT sin cuenta con estas mismas iteraciones (accounts/login.js), así
 * que deben ser las de TODAS las cuentas: si se suben solo para las claves
 * nuevas, una respuesta distinta delata qué RUT tiene cuenta. Subirlas a
 * 600 000 (OWASP) exige antes migrar cada cuenta al entrar (ADR 0014).
 */
export const ACCOUNT_ITERATIONS = 310_000;
const LABEL = 'hhr-cuentas-v1';

/** Sal nueva para una cuenta (base64, 16 bytes). */
function newSalt() {
  return bytesToB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Deriva los tres valores de una clave.
 * @param {string} password
 * @param {string} saltB64
 * @param {number} [iterations]
 * @returns {Promise<{acceso: string, envoltura: Uint8Array, local: string}>} acceso y local en hex
 */
export async function deriveAccountSecrets(password, saltB64, iterations = ACCOUNT_ITERATIONS) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations }, base, 256);
  const hkdf = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  /** @param {string} label */
  const expand = async (label) =>
    new Uint8Array(
      await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(`${LABEL}:${label}`) }, hkdf, 256),
    );
  return { acceso: toHex(await expand('acceso')), envoltura: await expand('envoltura'), local: toHex(await expand('local')) };
}

/**
 * Clave AES que envuelve la clave del equipo.
 * @param {Uint8Array} envoltura
 * @param {string} complemento hex (lo entrega el servidor)
 */
function wrappingKey(envoltura, complemento) {
  return globalThis.crypto.subtle.importKey(
    'raw',
    /** @type {BufferSource} */ (hmacSha256(envoltura, utf8(complemento))),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Envuelve la clave del equipo para una cuenta.
 * @param {string} teamKeyB64 clave del equipo (base64)
 * @param {{envoltura: Uint8Array, complemento: string, uid: string}} o
 * @returns {Promise<{iv: string, ct: string}>}
 */
async function wrapTeamKey(teamKeyB64, { envoltura, complemento, uid }) {
  return encryptPayload(await wrappingKey(envoltura, complemento), 'cuenta:' + uid, 1, { k: teamKeyB64 });
}

/**
 * Abre la clave del equipo envuelta. Lanza DecryptError si no corresponde.
 * @param {{iv: string, ct: string}} wrapped
 * @param {{envoltura: Uint8Array, complemento: string, uid: string}} o
 * @returns {Promise<string>} clave del equipo (base64)
 */
export async function unwrapTeamKey(wrapped, { envoltura, complemento, uid }) {
  const out = await decryptPayload(await wrappingKey(envoltura, complemento), 'cuenta:' + uid, 1, wrapped);
  if (!isObject(out) || typeof out.k !== 'string' || b64ToBytes(out.k).length !== 32) throw new DecryptError('Clave del equipo inválida');
  return out.k;
}

/**
 * @typedef {{nombre: string, rut: string, rol?: string, apellido_paterno?: string, apellido_materno?: string, nombres?: string}} PerfilCuenta
 *   Datos de la persona: van cifrados con la clave del equipo.
 */

/**
 * @param {CryptoKey} teamKey
 * @param {string} uid
 * @param {PerfilCuenta} perfil
 */
export const encryptProfile = (teamKey, uid, perfil) =>
  encryptPayload(teamKey, 'perfil:' + uid, 1, { ...perfil, nombre: personName(perfil) });

/**
 * @param {CryptoKey} teamKey
 * @param {string} uid
 * @param {{iv: string, ct: string}} payload
 * @returns {Promise<PerfilCuenta>}
 */
export async function decryptProfile(teamKey, uid, payload) {
  const d = await decryptPayload(teamKey, 'perfil:' + uid, 1, payload);
  const p = isObject(d) ? d : {};
  return { nombre: personName(p), ...nameParts(p), rut: String(p.rut || ''), ...(p.rol ? { rol: String(p.rol) } : {}) };
}

/**
 * Todo lo que el servidor necesita para una clave nueva de una cuenta (alta,
 * restablecer o cambio de clave). Se calcula en el PC: el servidor nunca ve la clave.
 * @param {{password: string, teamKeyB64: string, uid: string, complemento: string, iterations?: number}} o
 * @returns {Promise<{sal: string, iter: number, acceso: string, envuelta: {iv: string, ct: string}, local: string}>}
 */
export async function credentialsFor({ password, teamKeyB64, uid, complemento, iterations = ACCOUNT_ITERATIONS }) {
  const sal = newSalt();
  const s = await deriveAccountSecrets(password, sal, iterations);
  const envuelta = await wrapTeamKey(teamKeyB64, { envoltura: s.envoltura, complemento, uid });
  return { sal, iter: iterations, acceso: s.acceso, envuelta, local: s.local };
}
