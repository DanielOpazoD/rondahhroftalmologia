/**
 * Verificador visual de RUT: ✓ verde si el dígito verificador es correcto,
 * ✗ roja si no lo es, nada si el campo está vacío. Se actualiza al escribir.
 */
import { isValidRut, cleanRut } from '../core/format.js';
import { $$, dataOf } from './dom.js';

/** Actualiza la marca de un campo RUT. @param {HTMLInputElement} input */
export function updateRutMark(input) {
  const mark = /** @type {HTMLElement | null} */ (document.querySelector(`[data-rut-for="${input.id}"]`));
  if (!mark) return;
  const v = input.value.trim();
  const state = !v ? '' : cleanRut(v).length < 2 ? 'bad' : isValidRut(v) ? 'ok' : 'bad';
  mark.className = 'rutmark' + (state ? ' ' + state : '');
  mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : '';
  mark.title = state === 'ok' ? 'RUT válido' : state === 'bad' ? 'RUT inválido (revisa el dígito verificador)' : '';
  mark.setAttribute('aria-label', mark.title);
}

/** Enlaza todas las marcas de RUT de la página (y las actualiza al escribir). */
export function initRutMarks() {
  for (const mark of $$('[data-rut-for]')) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(dataOf(mark, 'rutFor')));
    if (!input) continue;
    input.addEventListener('input', () => updateRutMark(input));
    input.addEventListener('blur', () => updateRutMark(input));
    updateRutMark(input);
  }
}

/** Refresca todas las marcas (tras cargar datos en el formulario por código). */
export function refreshRutMarks() {
  for (const mark of $$('[data-rut-for]')) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(dataOf(mark, 'rutFor')));
    if (input) updateRutMark(input);
  }
}
