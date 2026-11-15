/**
 * Registro de errores de este equipo: captura los errores no esperados, las
 * promesas rechazadas sin manejar y los fallos que la app ya informa
 * (sincronización, almacenamiento, acciones). Se ve, se copia y se vacía en
 * Ajustes → Registro de errores. Nunca sale del equipo por sí solo.
 *
 * No importa ui/dom.js (dom.js registra sus errores aquí; se evita el ciclo).
 */
import { APP } from '../config/catalogs.js';
import { errorEntry, pushEntry, formatLog } from '../core/errlog.js';

/** @type {((e: object) => void) | null} */
let sink = null;
const pending = [];

/** Registra un error (antes de iniciar la app, queda en espera). */
export function logError(where, err) {
  const e = errorEntry(where, err, Date.now(), APP.version);
  if (sink) sink(e);
  else pending.push(e);
}

const q = (sel) => /** @type {any} */ (document.querySelector(sel));

/** @param {any} ctx contexto de la aplicación */
export function initErrorLog(ctx) {
  const { store } = ctx;
  const render = () => {
    const list = store.loadErrors();
    q('#errCount').textContent = String(list.length);
    q('#errEmpty').hidden = list.length > 0;
    q('#errText').hidden = !list.length;
    q('#errText').textContent = formatLog(list);
  };
  sink = (e) => {
    try {
      store.saveErrors(pushEntry(store.loadErrors(), e));
    } catch {
      /* sin espacio: el registro no debe causar más errores */
    }
    render();
  };
  for (const e of pending.splice(0)) sink(e);
  window.addEventListener('error', (ev) => logError('inesperado', ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => logError('promesa', ev.reason));
  q('#errCopy').addEventListener('click', async () => {
    const text = formatLog(store.loadErrors(), `Oftalmología HHR ${APP.version} · ${navigator.userAgent}`);
    try {
      await navigator.clipboard.writeText(text);
      q('#errCopy').textContent = 'Copiado';
    } catch {
      q('#errText').focus();
    }
  });
  q('#errClear').addEventListener('click', () => {
    store.saveErrors([]);
    render();
  });
  render();
}
