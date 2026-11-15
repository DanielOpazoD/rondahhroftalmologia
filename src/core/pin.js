/**
 * PIN de bloqueo del equipo (lógica pura; la pantalla está en ui/lock.js).
 *
 * El PIN protege la PANTALLA de un PC compartido: evita que quien pase por el
 * equipo vea los pacientes. No cifra los datos guardados en el navegador.
 *
 * - Se guarda solo una derivación PBKDF2-HMAC-SHA256 con sal aleatoria.
 * - Al configurarlo se entrega un código de recuperación (también derivado),
 *   para desbloquear si se olvida el PIN tras meses sin usar la app.
 * - Tras varios intentos fallidos hay que esperar, cada vez más.
 */
import { hmacSha256, toHex, utf8 } from '../lib/sha256.js';

export const PIN_ITERATIONS = 20_000;
export const PIN_MINUTES = [5, 10, 15, 30];
export const DEFAULT_MINUTES = 10;
/** Intentos fallidos permitidos antes de tener que esperar. */
export const FREE_ATTEMPTS = 5;

const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'.split('');

/** Mensaje si el PIN no es válido; null si sirve. */
export const pinProblem = (pin) => (/^\d{4,8}$/.test(String(pin ?? '')) ? null : 'El PIN debe tener entre 4 y 8 números.');

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
const randomHex = (n) => toHex(globalThis.crypto.getRandomValues(new Uint8Array(n)));

/** PBKDF2-HMAC-SHA256 de 32 bytes (un bloque), en hexadecimal. */
export function pbkdf2(secret, saltHex, iterations = PIN_ITERATIONS) {
  const key = utf8(secret);
  const salt = hexToBytes(saltHex);
  const first = new Uint8Array(salt.length + 4);
  first.set(salt);
  first.set([0, 0, 0, 1], salt.length);
  let u = hmacSha256(key, first);
  const out = Uint8Array.from(u);
  for (let i = 1; i < iterations; i++) {
    u = hmacSha256(key, u);
    for (let j = 0; j < out.length; j++) out[j] ^= u[j];
  }
  return toHex(out);
}

/** Código de recuperación: 12 caracteres sin ambiguos (60 bits), en grupos de 4. */
export function generateRecoveryCode() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(bytes, (b) => B32[b % B32.length]).join('');
  return s.match(/.{4}/g).join('-');
}
const normCode = (c) =>
  String(c ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Configuración nueva del bloqueo.
 * @returns {{lock: object, recoveryCode: string}}
 */
export function createLockConfig(pin, minutes = DEFAULT_MINUTES, iterations = PIN_ITERATIONS) {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  const salt = randomHex(16);
  const rsalt = randomHex(16);
  const recoveryCode = generateRecoveryCode();
  return {
    lock: {
      v: 1,
      iter: iterations,
      salt,
      hash: pbkdf2(String(pin), salt, iterations),
      rsalt,
      rhash: pbkdf2(normCode(recoveryCode), rsalt, iterations),
      minutes: PIN_MINUTES.includes(minutes) ? minutes : DEFAULT_MINUTES,
    },
    recoveryCode,
  };
}

/** Comparación en tiempo constante. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const verifyPin = (lock, pin) => Boolean(lock?.hash) && same(pbkdf2(String(pin ?? ''), lock.salt, lock.iter), lock.hash);
export const verifyRecovery = (lock, code) => Boolean(lock?.rhash) && same(pbkdf2(normCode(code), lock.rsalt, lock.iter), lock.rhash);

/** ¿Es una configuración de bloqueo válida? (lo guardado puede venir alterado o de otra versión) */
export const isLockConfig = (l) =>
  Boolean(l) &&
  typeof l === 'object' &&
  /^[0-9a-f]{64}$/.test(l.hash || '') &&
  /^[0-9a-f]{32}$/.test(l.salt || '') &&
  Number.isInteger(l.iter) &&
  l.iter >= 1000;

/**
 * Espera tras intentos fallidos: libres los primeros FREE_ATTEMPTS; después
 * 30 s, 1 min, 2 min… hasta 15 min.
 * @param {number} fails intentos fallidos seguidos
 * @returns {number} ms de espera tras este fallo
 */
export function lockoutMs(fails) {
  if (fails < FREE_ATTEMPTS) return 0;
  return Math.min(30_000 * 2 ** (fails - FREE_ATTEMPTS), 15 * 60_000);
}
