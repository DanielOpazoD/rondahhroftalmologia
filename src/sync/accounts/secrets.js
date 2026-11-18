/**
 * Cuentas (servidor): todo lo que se deriva del secreto del servidor
 * (SYNC_TOKEN_SHA256, fuera del almacén). Con él, el servidor guarda huellas
 * y no datos en claro:
 *   - del RUT, una huella HMAC (para encontrar la cuenta);
 *   - de la clave, HMAC(secreto, acceso), donde `acceso` lo deriva el PC;
 *   - de la IP, una huella (límite de intentos por red).
 * Además firma y verifica los tokens de sesión y reconoce la contraseña del equipo.
 */
import { sha256, hmacSha256, toHex } from '../../lib/sha256.js';
import { bytesToB64 } from '../crypto.js';
import { accountRut } from '../../core/accounts.js';
import { HEX64, isTokenPayload } from './validate.js';

/** @typedef {{u: string, s: string, e: number, c: boolean}} ContenidoToken  cuenta, sesión, vencimiento y si debe cambiar la clave */

/**
 * Comparación de textos en tiempo constante (para huellas y verificadores).
 * @param {unknown} a @param {unknown} b
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** @param {string} s */
const b64url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** @param {string} s */
const unb64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

/** @param {string} s @returns {unknown} JSON del contenido de un token, o null si no se puede leer */
function decodePayload(s) {
  try {
    return JSON.parse(unb64url(s));
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined} secret SYNC_TOKEN_SHA256 (hex). Sin él, `ready` es false
 *   y las cuentas no están disponibles (el router responde 503 antes de usar lo demás).
 */
export function createSecrets(secret) {
  const ready = typeof secret === 'string' && HEX64.test(secret);
  const key = ready ? secret : '';
  /** @type {(label: string, value: string) => string} */
  const mac = (label, value) => toHex(hmacSha256(key, `${label}:${value}`));
  /** Huella del RUT (índice de cuentas). @param {unknown} rut */
  const rutHashOf = (rut) => mac('rut', accountRut(rut)).slice(0, 40);

  return {
    ready,
    rutHashOf,
    /** Verificador de la clave que se guarda en la cuenta. @param {string} acceso */
    verifierOf: (acceso) => mac('acceso', acceso),
    /** Complemento de la clave de envoltura de una cuenta (ver accountCrypto.js). @param {string} uid */
    complementOf: (uid) => mac('complemento', uid),
    /** Red de origen como HMAC (la IP no se guarda). @param {string} ip */
    netId: (ip) => mac('ip', ip).slice(0, 32),
    /** Sal ficticia estable para un RUT sin cuenta (`sal` no revela si existe). @param {unknown} rut */
    fakeSalt: (rut) => bytesToB64(hmacSha256(key, 'sal-ficticia:' + rutHashOf(rut)).slice(0, 16)),

    /** @param {ContenidoToken} payload */
    signToken(payload) {
      const bodyPart = b64url(JSON.stringify(payload));
      return `s1.${bodyPart}.${mac('sesion', bodyPart)}`;
    },

    /** Contenido de un token con firma válida, o null. @param {string} token */
    readToken(token) {
      const m = /^s1\.([A-Za-z0-9_-]{10,400})\.([0-9a-f]{64})$/.exec(token);
      if (!m || !safeEqual(mac('sesion', m[1]), m[2])) return null;
      const p = decodePayload(m[1]);
      return isTokenPayload(p) ? p : null;
    },

    /** ¿Es la contraseña del equipo? (activar y preparar el primer administrador) @param {string} tk token `Bearer` */
    isTeamToken: (tk) => Boolean(tk) && !tk.startsWith('s1.') && safeEqual(toHex(sha256(tk)), secret),
  };
}
