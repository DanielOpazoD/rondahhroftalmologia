/**
 * Compatibilidad entre versiones de la app («lector tolerante», ADR 0012).
 *
 * Varios PC pueden tener versiones distintas durante un tiempo (uno se
 * actualizó y otro no). Para que un PC con una versión anterior NO borre lo
 * que agregó una versión más nueva, al normalizar se CONSERVAN los campos
 * desconocidos (con claves seguras y valores de datos), en vez de descartarlos.
 */

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
export const isSafeField = (k) => typeof k === 'string' && SAFE.test(k) && !FORBIDDEN.has(k);

/** ¿Es un valor de datos (JSON) razonable para conservar? */
function isDataValue(v, depth = 0) {
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
    return typeof v !== 'string' || v.length <= 10_000;
  }
  if (depth > 4) return false;
  if (Array.isArray(v)) return v.length <= 1000 && v.every((x) => isDataValue(x, depth + 1));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const entries = Object.entries(v);
    return entries.length <= 200 && entries.every(([k, x]) => isSafeField(k) && isDataValue(x, depth + 1));
  }
  return false;
}

/**
 * Campos de `obj` que esta versión no conoce, para conservarlos tal cual.
 * @param {object} obj
 * @param {Iterable<string>} known campos que la versión actual maneja
 * @returns {Record<string, unknown>}
 */
export function unknownFields(obj, known) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const k = new Set(known);
  for (const [key, v] of Object.entries(obj)) {
    if (k.has(key) || !isSafeField(key) || !isDataValue(v)) continue;
    out[key] = structuredClone(v);
  }
  return out;
}
