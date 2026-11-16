/**
 * Cuentas de usuario: reglas puras (sin red ni almacenamiento). Ver ADR 0014.
 *
 * - Una cuenta se identifica por el RUT de la persona.
 * - La clave inicial es el RUT sin dígito verificador; sirve solo para el
 *   primer ingreso (que exige cambiarla) y vence a los INITIAL_PASSWORD_DAYS.
 * - Clave nueva: al menos 6 caracteres, 1 mayúscula y 1 número, y distinta
 *   de la inicial.
 */
import { cleanRut, isValidRut, rutKey } from './format.js';

/** Días que dura la clave inicial sin usarse. */
export const INITIAL_PASSWORD_DAYS = 7;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
/** Intentos fallidos seguidos que bloquean la cuenta, y por cuánto tiempo. */
export const ACCOUNT_LOCK = Object.freeze({ maxFails: 5, lockMs: 15 * 60_000 });
/** Duración de una sesión. */
export const SESSION_MS = 12 * 3600_000;

/** Id de cuenta: `u` + 16 caracteres base36 aleatorios. */
export const USER_ID_RE = /^u[0-9a-z]{16}$/;

/**
 * Id nuevo de cuenta.
 * @param {(n: number) => Uint8Array} [rng]
 */
export function newUserId(rng = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  return 'u' + Array.from(rng(16), (b) => (b % 36).toString(36)).join('');
}

/**
 * Parte numérica del RUT, sin dígito verificador ni ceros a la izquierda:
 * «17.752.753-K» → «17752753». Es la clave inicial.
 * @param {unknown} rut
 */
export function rutBody(rut) {
  const c = cleanRut(rut);
  return c.length < 2 ? '' : c.slice(0, -1).replace(/^0+/, '');
}

/** Clave inicial de una cuenta (el RUT sin dígito verificador). @param {unknown} rut */
export const initialPassword = (rut) => rutBody(rut);

/**
 * RUT canónico para identificar la cuenta («17752753-K»), o '' si no es válido.
 * @param {unknown} rut
 */
export function accountRut(rut) {
  return isValidRut(rut) ? rutKey(rut) : '';
}

/**
 * ¿Sirve como clave nueva? Devuelve el motivo si no.
 * @param {unknown} password
 * @param {{rut?: unknown, current?: string}} [o] RUT de la cuenta (la clave no puede ser la inicial)
 *   y clave actual (la nueva debe ser distinta). La regla de la clave actual
 *   solo se puede revisar aquí: el servidor recibe la clave nueva ya derivada
 *   con otra sal y no puede compararlas.
 * @returns {string | null}
 */
export function passwordProblem(password, { rut, current } = {}) {
  const p = typeof password === 'string' ? password : '';
  if (p.length < PASSWORD_MIN) return `La clave debe tener al menos ${PASSWORD_MIN} caracteres.`;
  if (p.length > PASSWORD_MAX) return `La clave puede tener como máximo ${PASSWORD_MAX} caracteres.`;
  if (!/[A-ZÁÉÍÓÚÜÑ]/.test(p)) return 'La clave debe tener al menos una mayúscula.';
  if (!/[0-9]/.test(p)) return 'La clave debe tener al menos un número.';
  if (rut && p === initialPassword(rut)) return 'La clave nueva no puede ser la inicial (tu RUT).';
  if (current && p === current) return 'La clave nueva debe ser distinta de la actual.';
  return null;
}

/**
 * Estado de una cuenta para entrar.
 * @param {{estado?: string, debeCambiar?: boolean, tempExpira?: number | null, bloqueadaHasta?: number}} u
 * @param {number} now
 * @returns {'ok' | 'desactivada' | 'bloqueada' | 'clave_inicial_vencida'}
 */
export function loginState(u, now) {
  if (u.estado !== 'activo') return 'desactivada';
  if (u.bloqueadaHasta && u.bloqueadaHasta > now) return 'bloqueada';
  if (u.debeCambiar && u.tempExpira && u.tempExpira < now) return 'clave_inicial_vencida';
  return 'ok';
}
