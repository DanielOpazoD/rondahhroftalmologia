/**
 * Registro local de errores (lógica pura). La app no envía errores a ningún
 * servidor (hay datos clínicos): quedan en este equipo, acotados, para que el
 * usuario los copie y los mande a soporte si algo falla en terreno.
 */
export const MAX_ENTRIES = 50;

/**
 * Entrada del registro, con el mensaje y las primeras líneas de la pila, acotados.
 * @param {string} where dónde ocurrió (acción, sincronización, almacenamiento…)
 * @param {unknown} err
 */
export function errorEntry(where, err, now = Date.now(), version = '') {
  const e = /** @type {any} */ (err);
  const msg = String(e?.message ?? e ?? 'Error desconocido').slice(0, 300);
  const stack = typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 6).join('\n').slice(0, 800) : '';
  return { at: now, where: String(where).slice(0, 40), msg, ...(stack ? { stack } : {}), ...(version ? { v: version } : {}) };
}

/** Agrega una entrada y conserva solo las últimas `max`. */
export function pushEntry(list, entry, max = MAX_ENTRIES) {
  return [...(Array.isArray(list) ? list : []), entry].slice(-max);
}

/** Texto para copiar y enviar a soporte (más reciente primero). */
export function formatLog(list, header = '') {
  const lines = [...list]
    .reverse()
    .map(
      (e) =>
        `[${new Date(e.at).toISOString()}] ${e.where}${e.v ? ' · v' + e.v : ''}: ${e.msg}${e.stack ? '\n  ' + e.stack.replace(/\n/g, '\n  ') : ''}`,
    );
  return [header, ...lines].filter(Boolean).join('\n');
}
