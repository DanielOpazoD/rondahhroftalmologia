/** Borradores de formularios por atención; f.* y ft conservan la fusión por campo. */
import { isSafeKey } from './fields.js';

/** @typedef {'ges' | 'ipd' | 'receta'} FormKind */

/** @param {FormKind} kind @param {string} key */
const fieldKey = (kind, key) => `form_${kind}_${key}`;
/** Un valor vacío también está guardado si tiene sello de edición.
 * @param {import('../domain').Atencion} rec @param {string} key
 */
const hasValue = (rec, key) => Object.hasOwn(rec.f, key) || Object.hasOwn(rec.ft || {}, 'f.' + key);

/** Los datos de identificación de un borrador no convierten un preingreso en atención clínica.
 * @param {string} key
 */
export const isClinicalFormContent = (key) =>
  /^form_ges_patologia$|^form_ipd_(problema|subgrupo|diagnostico|fundamentos|tratamiento)$|^form_receta_(lejos_(od|oi|dp)|cerca_(od|oi|dp)|tabo_eje_(od|oi))$/.test(
    key,
  );

/** @template {Record<string, string>} T
 * @param {import('../domain').Atencion} rec @param {FormKind} kind @param {T} defaults
 * @returns {T}
 */
export function clinicalFormValues(rec, kind, defaults) {
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const field = fieldKey(kind, key);
    if (hasValue(rec, field)) Object.assign(out, { [key]: rec.f[field] || '' });
  }
  return out;
}

/** Aplica solo las ediciones de esta ventana sobre la atención más reciente.
 * Los campos aún sin guardar se inicializan como una instantánea completa;
 * los vacíos se fechan para que borrar un dato sobreviva a la sincronización.
 * @param {import('../domain').Atencion} rec @param {FormKind} kind
 * @param {Record<string, string>} previous @param {Record<string, string>} values @param {number} at
 */
export function rememberClinicalForm(rec, kind, previous, values, at) {
  const keys = Object.keys(previous).filter((key) => {
    const field = fieldKey(kind, key);
    return isSafeKey(field) && typeof values[key] === 'string' && (values[key] !== previous[key] || !hasValue(rec, field));
  });
  if (!keys.length) return rec;
  const next = { ...rec, f: { ...rec.f }, ft: { ...rec.ft } };
  for (const key of keys) {
    const field = fieldKey(kind, key);
    next.f[field] = values[key];
    // Un valor propuesto no debe ganar a una edición manual de otro equipo.
    next.ft['f.' + field] = values[key] !== previous[key] ? at : Math.max(1, Math.min(rec.created || 1, at));
  }
  return next;
}
