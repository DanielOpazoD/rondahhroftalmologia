/**
 * Piezas compartidas de los datos del paciente (Ingreso y Atención usan la
 * misma plantilla HTML: src/partials/paciente.html).
 */
import { SEXOS } from '../config/catalogs.js';
import { html, setHtml } from './html.js';

/** Texto corto de cada opción de sexo (el nombre completo va en title/aria-label). @param {string} key */
const short = (key) => (key === 'O' ? 'Otro' : key);

/**
 * Dibuja el selector de sexo y avisa la opción elegida (o '' al volver a tocarla).
 * @param {HTMLElement} el
 * @param {() => string} current valor actual
 * @param {(v: string) => void} onPick
 */
export function initSexSelector(el, current, onPick) {
  setHtml(
    el,
    html`${SEXOS.map(
      (s) =>
        html`<button type="button" data-v="${s.key}" title="${s.label}" aria-label="${s.label}" aria-pressed="false">${short(s.key)}</button>`,
    )}`,
  );
  el.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (b) onPick(current() === b.dataset.v ? '' : b.dataset.v || '');
  });
}

/** Marca la opción elegida. @param {HTMLElement} el @param {string} value */
export function renderSexSelector(el, value) {
  for (const b of /** @type {HTMLElement[]} */ ([...el.querySelectorAll('button')])) {
    b.classList.toggle('on', b.dataset.v === value);
    b.setAttribute('aria-pressed', String(b.dataset.v === value));
  }
}
