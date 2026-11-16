/** Nombres explícitos. Nunca deduce apellidos a partir de un nombre antiguo. */
export const NAME_PARTS = /** @type {const} */ (['apellido_paterno', 'apellido_materno', 'nombres']);

/** @param {Record<string, unknown>} source @param {string} [prefix] */
export function hasNameParts(source, prefix = '') {
  return NAME_PARTS.some((k) => Object.hasOwn(source, prefix + k));
}

/** @param {Record<string, unknown>} source @param {string} [prefix] */
export function nameParts(source, prefix = '') {
  return Object.fromEntries(
    NAME_PARTS.filter((k) => Object.hasOwn(source, prefix + k)).map((k) => [k, String(source[prefix + k] ?? '').trim()]),
  );
}

/** Apellido paterno, apellido materno, nombres; el texto anterior es el respaldo.
 * @param {Record<string, unknown>} source @param {string} [prefix]
 */
export function personName(source, prefix = '') {
  if (!hasNameParts(source, prefix)) return String(source[prefix + 'nombre'] ?? '').trim();
  return NAME_PARTS.map((k) => String(source[prefix + k] ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Mantiene el nombre completo para lectores y exportaciones anteriores.
 * Los componentes siguen siendo la fuente del nombre cuando existen.
 * @param {Record<string, string>} fields
 */
export function refreshNames(fields) {
  for (const prefix of ['paciente_', 'medico_']) {
    if (hasNameParts(fields, prefix)) fields[prefix + 'nombre'] = personName(fields, prefix);
  }
  return fields;
}
