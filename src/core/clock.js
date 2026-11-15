/**
 * Reloj lógico híbrido (HLC simplificado) para fechar ediciones.
 *
 * Problema: cada PC usa su propia hora. Si un PC tiene el reloj atrasado, sus
 * ediciones perderían frente a ediciones ANTERIORES de otro PC con la hora
 * adelantada, aunque las hizo después de verlas.
 *
 * Solución: la hora de una edición es max(hora del PC, última hora vista + 1).
 * "Última hora vista" incluye las fechas que llegan de otros equipos. Así,
 * una edición hecha después de recibir otra siempre queda con fecha posterior
 * (se respeta la causalidad), aunque el reloj del PC esté atrasado.
 *
 * Para no propagar un reloj muy adelantado, no se aceptan fechas observadas
 * más de MAX_AHEAD por delante de la hora local (y la app avisa del desfase).
 */
export const MAX_AHEAD_MS = 12 * 3600 * 1000;

/**
 * @param {{now?: () => number, load?: () => number, save?: (t: number) => void}} [opts]
 *   `load`/`save` persisten la última hora (para respetar la causalidad entre recargas).
 */
export function createClock({ now = Date.now, load = () => 0, save = () => {} } = {}) {
  let last = Number(load()) || 0;
  return {
    /** Hora para una edición nueva: nunca menor ni igual a la última vista. */
    tick() {
      last = Math.max(now(), last + 1);
      save(last);
      return last;
    },
    /** Registra una fecha recibida de otro equipo. */
    observe(t) {
      if (!Number.isFinite(t)) return;
      const capped = Math.min(t, now() + MAX_AHEAD_MS);
      if (capped > last) {
        last = capped;
        save(last);
      }
    },
    get last() {
      return last;
    },
  };
}

/** Reloj de la aplicación (se configura con persistencia en main.js). */
export let clock = createClock();
export function setClock(c) {
  clock = c;
}
