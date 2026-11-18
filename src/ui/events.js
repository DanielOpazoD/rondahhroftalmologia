/**
 * Bus de eventos de la interfaz.
 *
 * Las acciones anuncian QUÉ cambió (`emit(TOPICS.DATOS)`) en vez de llamar a
 * cada vista; las vistas se suscriben (`on(TOPICS.DATOS, render)`). Los temas
 * son una lista cerrada (`Topic`): un nombre mal escrito no pasa la revisión de tipos. Los avisos de un
 * mismo momento se agrupan: aunque una sincronización guarde 50 atenciones,
 * las listas se dibujan una sola vez (en la siguiente microtarea).
 */
import { logError } from './errorLog.js';

/** Temas de cambio. */
export const TOPICS = Object.freeze({
  /** Atenciones o fichas de pacientes guardadas, recibidas o eliminadas. */
  DATOS: /** @type {const} */ ('datos'),
  /** La atención abierta cambió (otra atención, o llegaron cambios de otro equipo). */
  ATENCION: /** @type {const} */ ('atencion'),
  /** Adjuntos agregados, eliminados o recibidos. */
  ADJUNTOS: /** @type {const} */ ('adjuntos'),
  /** Entró o salió una persona, o cambió su rol (cuentas de usuario). */
  CUENTA: /** @type {const} */ ('cuenta'),
});

/**
 * Tema que se anuncia al mostrar una pestaña (p. ej. Ajustes carga lo que muestra).
 * @param {string} id id de la sección de la pestaña ('t-aj', 't-reg'…)
 * @returns {`tab:${string}`}
 */
export const tabTopic = (id) => `tab:${id}`;

/** @typedef {(typeof TOPICS)[keyof typeof TOPICS] | `tab:${string}`} Topic */

/**
 * @param {{schedule?: (fn: () => void) => void}} [o] cómo diferir la entrega (por omisión, microtarea)
 */
export function createBus({ schedule = queueMicrotask } = {}) {
  /** @type {Map<Topic, Set<(topics: Topic[]) => void>>} */
  const subs = new Map();
  /** @type {Set<Topic>} */
  const pending = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    const topics = [...pending];
    pending.clear();
    // Cada suscriptor una sola vez, aunque escuche varios temas que cambiaron.
    /** @type {Set<(topics: Topic[]) => void>} */
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
     * @param {Topic} topic
     * @param {(topics: Topic[]) => void} fn recibe los temas que cambiaron
     * @returns {() => void}
     */
    on(topic, fn) {
      let set = subs.get(topic);
      if (!set) subs.set(topic, (set = new Set()));
      set.add(fn);
      return () => subs.get(topic)?.delete(fn);
    },
    /** Anuncia un cambio; la entrega se agrupa con los demás avisos del momento. @param {Topic} topic */
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
