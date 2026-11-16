/**
 * Bus de eventos de la interfaz.
 *
 * Las acciones anuncian QUÉ cambió (`emit('datos')`) en vez de llamar a cada
 * vista; las vistas se suscriben (`on('datos', render)`). Los avisos de un
 * mismo momento se agrupan: aunque una sincronización guarde 50 atenciones,
 * las listas se dibujan una sola vez (en la siguiente microtarea).
 */
import { logError } from './errorLog.js';

/** Temas de cambio. */
export const TOPICS = Object.freeze({
  /** Atenciones o fichas de pacientes guardadas, recibidas o eliminadas. */
  DATOS: 'datos',
});

/**
 * @param {{schedule?: (fn: () => void) => void}} [o] cómo diferir la entrega (por omisión, microtarea)
 */
export function createBus({ schedule = queueMicrotask } = {}) {
  /** @type {Map<string, Set<(topics: string[]) => void>>} */
  const subs = new Map();
  /** @type {Set<string>} */
  const pending = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    const topics = [...pending];
    pending.clear();
    // Cada suscriptor una sola vez, aunque escuche varios temas que cambiaron.
    /** @type {Set<(topics: string[]) => void>} */
    const fns = new Set();
    for (const t of topics) for (const fn of subs.get(t) || []) fns.add(fn);
    for (const fn of fns) {
      try {
        fn(topics);
      } catch (e) {
        // Una vista que falla no impide que las demás se actualicen.
        console.error(e);
        logError('interfaz', e);
      }
    }
  }

  return {
    /**
     * Se suscribe a un tema; devuelve la función para desuscribirse.
     * @param {string} topic
     * @param {(topics: string[]) => void} fn recibe los temas que cambiaron
     * @returns {() => void}
     */
    on(topic, fn) {
      let set = subs.get(topic);
      if (!set) subs.set(topic, (set = new Set()));
      set.add(fn);
      return () => subs.get(topic)?.delete(fn);
    },
    /** Anuncia un cambio; la entrega se agrupa con los demás avisos del momento. @param {string} topic */
    emit(topic) {
      pending.add(topic);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    /** Entrega ya lo pendiente (pruebas). */
    flush,
  };
}
