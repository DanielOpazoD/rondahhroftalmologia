/**
 * Contrato de una especialidad.
 *
 * Una especialidad es una carpeta en src/specialties/<id>/ con:
 *   config.js        datos: identidad, catálogos, procedimientos, campos, etiquetas
 *   validacion.js    validarClinico(rec, warn, note)
 *   index.js         reexporta los módulos clínicos y sus salidas (ver REQUIRED_FUNCTIONS)
 *   formulario.html  parte clínica del formulario
 *   plantilla.pdf    plantilla del PDF oficial (opcional: sin ella, la especialidad dibuja
 *                    su PDF desde cero y buildAttentionPdf recibe una plantilla vacía)
 *
 * validateSpecialty() revisa el módulo antes de construir (scripts/build.mjs)
 * y en las pruebas: una especialidad mal configurada no llega a producción.
 */

/** Campos de texto que la plataforma usa en todas las especialidades. */
export const PLATFORM_FIELDS = [
  'operativo',
  'fecha_atencion',
  'paciente_nombre',
  'paciente_rut',
  'paciente_fnac',
  'paciente_edad',
  'paciente_sexo',
  'paciente_fono',
  'medico_nombre',
  'medico_rut',
];

/** Funciones que la plataforma llama en la especialidad. */
export const REQUIRED_FUNCTIONS = [
  // clínica y formulario
  'validarClinico',
  'proceduresDone',
  'diagnosesList',
  'coversEye',
  // salidas
  'buildNote',
  'buildAttentionPdf',
  'pdfFileName',
  'filterRecords',
  'operativosOf',
  'computeStats',
  'sortedEntries',
  'ageGroupLabels',
  'statsWorkbook',
  'anonymizeRecords',
  'anonymizedJson',
  'anonymizedSheets',
  // modo práctica
  'casosDeEjemplo',
];

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {Record<string, any>} mod módulo de la especialidad (export * de su index.js)
 * @param {{formHtml?: string}} [extra] HTML del formulario para verificar sus campos
 * @returns {string[]} problemas encontrados (vacío = válida)
 */
export function validateSpecialty(mod, extra = {}) {
  const p = [];
  const e = mod.ESPECIALIDAD;
  if (!e || !/^[a-z][a-z0-9-]{1,39}$/.test(e.id || '')) p.push('ESPECIALIDAD.id debe ser un identificador en minúsculas (a-z, 0-9, -)');
  if (!e?.nombre) p.push('ESPECIALIDAD.nombre es obligatorio');
  if (!/^[a-z]{2,6}_$/.test(e?.prefijo || '')) p.push('ESPECIALIDAD.prefijo debe ser 2–6 letras y "_" (p. ej. "oft_")');

  const keys = new Set();
  for (const group of ['ANTECEDENTES', 'SOLICITADOS', 'DIAGNOSTICOS']) {
    if (!Array.isArray(mod[group])) {
      p.push(`${group} debe ser una lista`);
      continue;
    }
    for (const d of mod[group]) {
      if (!SAFE_KEY.test(d?.key || '') || !d.label) p.push(`${group}: entrada inválida ${JSON.stringify(d)}`);
      else if (keys.has(d.key)) p.push(`Clave de casilla repetida: ${d.key}`);
      else keys.add(d.key);
    }
  }

  const procIds = new Set();
  if (!Array.isArray(mod.DEFAULT_PROCS)) p.push('DEFAULT_PROCS debe ser una lista');
  else {
    for (const pr of mod.DEFAULT_PROCS) {
      if (!SAFE_KEY.test(pr?.id || '') || !pr.n) p.push(`DEFAULT_PROCS: entrada inválida ${JSON.stringify(pr)}`);
      else if (procIds.has(pr.id)) p.push(`Procedimiento repetido: ${pr.id}`);
      else procIds.add(pr.id);
    }
  }

  if (!Array.isArray(mod.OJOS) || !mod.OJOS.length) p.push('OJOS (lados posibles de un procedimiento) no puede estar vacío');
  if (!Array.isArray(mod.MEDIDAS_PROC) || !mod.MEDIDAS_PROC.every((k) => SAFE_KEY.test(k) && k !== 'eye')) {
    p.push('MEDIDAS_PROC: claves inválidas');
  }

  const fields = Array.isArray(mod.TEXT_FIELDS) ? mod.TEXT_FIELDS : [];
  if (!fields.length) p.push('TEXT_FIELDS no puede estar vacío');
  for (const f of PLATFORM_FIELDS) if (!fields.includes(f)) p.push(`TEXT_FIELDS debe incluir "${f}" (lo usa la plataforma)`);
  for (const f of fields) {
    if (!SAFE_KEY.test(f)) p.push(`Campo inválido: ${f}`);
    if (!mod.ETIQUETAS?.[f]) p.push(`Falta la etiqueta (ETIQUETAS) del campo "${f}"`);
  }
  for (const f of mod.FREE_TEXT_FIELDS || []) if (!fields.includes(f)) p.push(`FREE_TEXT_FIELDS: "${f}" no está en TEXT_FIELDS`);

  for (const fn of REQUIRED_FUNCTIONS) if (typeof mod[fn] !== 'function') p.push(`Falta la función ${fn}()`);

  if (extra.formHtml !== undefined) {
    const html = extra.formHtml;
    for (const f of fields) {
      if (PLATFORM_FIELDS.includes(f)) continue; // están en la parte común del formulario
      if (!html.includes(`id="${f}"`)) p.push(`formulario.html no tiene el campo id="${f}"`);
    }
  }
  return p;
}
