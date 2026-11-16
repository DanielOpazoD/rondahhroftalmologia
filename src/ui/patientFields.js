/**
 * Piezas compartidas de los datos del paciente (Ingreso y Atención usan la
 * misma plantilla HTML: src/partials/paciente.html).
 */
import { SEXOS } from '../config/catalogs.js';
import { NAME_PARTS, hasNameParts } from '../core/names.js';
import { html, setHtml } from './html.js';

/** Campos explícitos para perfiles y cuentas; el nombre anterior queda visible al organizarlo. */
export function profileNameFields(person = {}) {
  return [
    ...(!hasNameParts(person) && person.nombre
      ? [{ id: 'nombre', label: 'Nombre anterior (completa los campos separados para organizarlo)', value: person.nombre }]
      : []),
    ...NAME_PARTS.map((id, i) => ({ id, label: ['Apellido paterno', 'Apellido materno', 'Nombres'][i], value: person[id] || '' })),
  ];
}

/** Campos de perfil para guardar; editar otro dato no reparte un nombre antiguo. */
export function profileNameValues(values, previous = {}) {
  return hasNameParts(previous) || NAME_PARTS.some((k) => values[k]?.trim())
    ? Object.fromEntries(NAME_PARTS.map((k) => [k, values[k]?.trim() || '']))
    : { nombre: values.nombre || previous.nombre || '' };
}

/** Conserva visible el texto antiguo, sin asignarlo a un apellido ni a los nombres. */
export function renderLegacyName(prefix, fields) {
  const hint = document.querySelector(`[data-legacy-name="${prefix}"]`);
  if (!(hint instanceof HTMLElement)) return;
  hint.hidden = hasNameParts(fields, 'paciente_') || !fields.paciente_nombre;
  hint.textContent = `Nombre anterior: ${fields.paciente_nombre || ''}. Completa apellidos y nombres para organizarlo.`;
}

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
