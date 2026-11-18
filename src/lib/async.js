/**
 * Utilidades de asincronía sin dominio.
 */

/**
 * Ejecuta `fn` sobre los elementos con concurrencia limitada. Devuelve los
 * resultados en el mismo orden que los elementos.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit cuántas a la vez
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
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
