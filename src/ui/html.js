/**
 * Plantillas HTML seguras.
 *
 * `html` escapa TODO valor interpolado salvo que ya sea HTML seguro (otra
 * plantilla `html` o un `join` de ellas). Así no hay
 * que acordarse de escapar en cada lugar: un nombre de paciente con `<` nunca
 * se interpreta como HTML. `setHtml` es la única forma de escribir innerHTML
 * en la interfaz (ESLint prohíbe asignarlo directamente).
 *
 *   setHtml(el, html`<b>${nombre}</b> ${lista.map((x) => html`<i>${x}</i>`)}`);
 */
import { escapeHtml } from '../core/format.js';

export class SafeHtml {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/**
 * Marca como seguro un texto ya escapado o escrito en este módulo. No se
 * exporta: fuera de aquí no hay forma de insertar HTML sin escapar.
 * @param {unknown} s
 */
const raw = (s) => new SafeHtml(String(s));

/**
 * @param {unknown} v valor interpolado (SafeHtml, arreglo o texto a escapar)
 * @returns {string}
 */
function render(v) {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return escapeHtml(String(v));
}

/**
 * Plantilla con escape automático. Los arreglos se concatenan; null,
 * undefined y false no escriben nada (útil para `${cond && html`…`}`).
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/**
 * Une fragmentos seguros con un separador (texto, se escapa).
 * @param {unknown[]} parts
 * @param {string} [sep]
 */
export const join = (parts, sep = '') => raw(parts.map(render).join(escapeHtml(sep)));

/**
 * Escribe HTML seguro en un elemento.
 * @param {Element} el
 * @param {SafeHtml} content
 */
export function setHtml(el, content) {
  if (!(content instanceof SafeHtml)) throw new TypeError('setHtml requiere una plantilla html`…`');
  // eslint-disable-next-line no-restricted-syntax -- único punto de escritura de innerHTML
  el.innerHTML = content.value;
}
