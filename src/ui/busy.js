/**
 * Acción asíncrona con el botón deshabilitado mientras corre; si falla, se
 * registra y se avisa a la persona (nunca se pierde en silencio).
 */
import { logError } from './errorLog.js';
import { uiAlert } from './modal.js';

/**
 * @template T
 * @param {HTMLButtonElement | null | undefined} button
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | undefined>}
 */
export async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    logError('acción', e);
    void uiAlert({ title: 'No se pudo completar la acción', message: String(/** @type {any} */ (e)?.message || e), tone: 'danger' });
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}
