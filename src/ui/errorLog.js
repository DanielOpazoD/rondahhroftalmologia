/**
 * Registro de errores de este equipo: captura los errores no esperados, las
 * promesas rechazadas sin manejar y los fallos que la app ya informa
 * (sincronización, almacenamiento, acciones). Se ve, se copia y se vacía en
 * Ajustes → Registro de errores. Nunca sale del equipo por sí solo.
 */
import { APP } from '../config/catalogs.js';
import { $ } from './dom.js';
import { errorEntry, pushEntry, formatLog } from '../core/errlog.js';

/** @typedef {import('../core/errlog.js').ErrorEntry} ErrorEntry */

/** @type {((e: ErrorEntry) => void) | null} */
let sink = null;
/** @type {ErrorEntry[]} */
const pending = [];

/**
 * Registra un error (antes de iniciar la app, queda en espera).
 * @param {string} where dónde ocurrió (acción, sincronización, almacenamiento…)
 * @param {unknown} err
 */
export function logError(where, err) {
  const e = errorEntry(where, err, Date.now(), APP.version);
  if (sink) sink(e);
  else pending.push(e);
}

/** @param {import('./context.js').AppContext} ctx */
export function initErrorLog(ctx) {
  const { store } = ctx;
  const render = () => {
    const list = store.loadErrors();
    $('#errCount').textContent = String(list.length);
    $('#errEmpty').hidden = list.length > 0;
    $('#errText').hidden = !list.length;
    $('#errText').textContent = formatLog(list);
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
  $('#errCopy').addEventListener('click', async () => {
    const text = formatLog(store.loadErrors(), `Oftalmología HHR ${APP.version} · ${navigator.userAgent}`);
    try {
      await navigator.clipboard.writeText(text);
      $('#errCopy').textContent = 'Copiado';
    } catch {
      $('#errText').focus();
    }
  });
  $('#errClear').addEventListener('click', () => {
    store.saveErrors([]);
    render();
  });
  render();
}
