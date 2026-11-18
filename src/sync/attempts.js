/**
 * Registro de intentos para los límites del servidor (por cuenta y por red).
 *
 * Netlify Blobs no tiene incrementos atómicos: leer un contador, sumar y
 * escribir pierde intentos cuando llegan a la vez (300 intentos simultáneos
 * quedaban contados como uno). Aquí cada intento es una clave propia y contar
 * es listar los recientes: nada se pisa. Lo vencido se borra al contar.
 *
 * Claves: `<prefijo><ámbito>/<id>/<momento base36>-<azar>`.
 */
import { toHex } from '../lib/sha256.js';

/** @typedef {import('./server.js').BlobStore} BlobStore */

/** Ancho fijo del momento (base 36): las claves quedan ordenadas por tiempo. */
const TIME_WIDTH = 9;

/** @param {string} key @returns {number} momento del intento */
const timeOf = (key) => parseInt(key.slice(key.lastIndexOf('/') + 1).split('-')[0], 36);

/**
 * @param {BlobStore} store
 * @param {string} [prefix]
 */
export function createAttempts(store, prefix = '_limites/') {
  /** @param {string} scope @param {string} id */
  const dir = (scope, id) => `${prefix}${scope}/${id}/`;

  /**
   * Momentos de los intentos dentro de la ventana, del más antiguo al más nuevo
   * (los vencidos se borran).
   * @param {string} scope @param {string} id @param {number} t @param {number} windowMs
   * @returns {Promise<number[]>}
   */
  async function recent(scope, id, t, windowMs) {
    const { blobs } = await store.list({ prefix: dir(scope, id) });
    /** @type {number[]} */
    const fresh = [];
    for (const b of blobs) {
      const at = timeOf(b.key);
      if (t - at < windowMs) fresh.push(at);
      else await store.delete(b.key);
    }
    return fresh.sort((a, b) => a - b);
  }

  return {
    recent,

    /**
     * Anota un intento. Devuelve su clave (para quitarlo si no debe contar).
     * @param {string} scope @param {string} id @param {number} t
     */
    async add(scope, id, t) {
      const rand = toHex(globalThis.crypto.getRandomValues(new Uint8Array(6)));
      const key = `${dir(scope, id)}${t.toString(36).padStart(TIME_WIDTH, '0')}-${rand}`;
      await store.setJSON(key, { t });
      return key;
    },

    /** Quita un intento anotado. @param {string} key */
    remove: (key) => store.delete(key),

    /** Olvida los intentos (p. ej. tras entrar bien o al restablecer la clave). @param {string} scope @param {string} id */
    async clear(scope, id) {
      const { blobs } = await store.list({ prefix: dir(scope, id) });
      for (const b of blobs) await store.delete(b.key);
    },
  };
}

/**
 * Cuánto falta para que los intentos bajen de `max` en la ventana (0 si ya bajaron).
 * @param {number[]} times del más antiguo al más nuevo
 * @param {number} max
 * @param {number} t
 * @param {number} windowMs
 */
export function waitMs(times, max, t, windowMs) {
  if (times.length < max) return 0;
  return Math.max(0, times[times.length - max] + windowMs - t);
}
