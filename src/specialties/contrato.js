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
  'paciente_apellido_paterno',
  'paciente_apellido_materno',
  'paciente_nombres',
  'paciente_rut',
  'paciente_fnac',
  'paciente_edad',
  'paciente_sexo',
  'paciente_fono',
  'medico_nombre',
  'medico_apellido_paterno',
  'medico_apellido_materno',
  'medico_nombres',
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
 * Módulo de la especialidad (export * de su index.js). `any` a propósito: su
 * forma es justo lo que se valida, y cada miembro se revisa antes de usarlo.
 * @typedef {Record<string, any>} ModuloEspecialidad
 */

/** Identidad: id, nombre y prefijo. @param {ModuloEspecialidad} mod @param {string[]} p */
function checkIdentity(mod, p) {
  const e = mod.ESPECIALIDAD;
  if (!e || !/^[a-z][a-z0-9-]{1,39}$/.test(e.id || '')) p.push('ESPECIALIDAD.id debe ser un identificador en minúsculas (a-z, 0-9, -)');
  if (!e?.nombre) p.push('ESPECIALIDAD.nombre es obligatorio');
  if (!/^[a-z]{2,6}_$/.test(e?.prefijo || '')) p.push('ESPECIALIDAD.prefijo debe ser 2–6 letras y "_" (p. ej. "oft_")');
}

/**
 * Una lista del catálogo: cada entrada válida (`ok`) y con clave única entre las listas que comparten `seen`.
 * @param {unknown} list @param {string} name @param {(x: any) => string | undefined} keyOf clave si la entrada es válida
 * @param {Set<string>} seen @param {string} repeated prefijo del mensaje de clave repetida @param {string[]} p
 */
function checkList(list, name, keyOf, seen, repeated, p) {
  if (!Array.isArray(list)) {
    p.push(`${name} debe ser una lista`);
    return;
  }
  for (const x of list) {
    const k = keyOf(x);
    if (!k) p.push(`${name}: entrada inválida ${JSON.stringify(x)}`);
    else if (seen.has(k)) p.push(`${repeated}: ${k}`);
    else seen.add(k);
  }
}

/** Casillas (antecedentes, solicitados, diagnósticos) y procedimientos. @param {ModuloEspecialidad} mod @param {string[]} p */
function checkCatalogs(mod, p) {
  const keys = new Set();
  const checkKey = (/** @type {any} */ d) => (SAFE_KEY.test(d?.key || '') && d.label ? d.key : undefined);
  for (const group of ['ANTECEDENTES', 'SOLICITADOS', 'DIAGNOSTICOS']) {
    checkList(mod[group], group, checkKey, keys, 'Clave de casilla repetida', p);
  }
  const procKey = (/** @type {any} */ pr) => (SAFE_KEY.test(pr?.id || '') && pr.n ? pr.id : undefined);
  checkList(mod.DEFAULT_PROCS, 'DEFAULT_PROCS', procKey, new Set(), 'Procedimiento repetido', p);
  if (!Array.isArray(mod.OJOS) || !mod.OJOS.length) p.push('OJOS (lados posibles de un procedimiento) no puede estar vacío');
  if (!Array.isArray(mod.MEDIDAS_PROC) || !mod.MEDIDAS_PROC.every((/** @type {string} */ k) => SAFE_KEY.test(k) && k !== 'eye')) {
    p.push('MEDIDAS_PROC: claves inválidas');
  }
}

/**
 * Campos de texto: incluyen los de la plataforma, tienen etiqueta y (si se da
 * el HTML) están en el formulario.
 * @param {ModuloEspecialidad} mod @param {string | undefined} html @param {string[]} p
 */
function checkFields(mod, html, p) {
  /** @type {string[]} */
  const fields = Array.isArray(mod.TEXT_FIELDS) ? mod.TEXT_FIELDS : [];
  if (!fields.length) p.push('TEXT_FIELDS no puede estar vacío');
  for (const f of PLATFORM_FIELDS) if (!fields.includes(f)) p.push(`TEXT_FIELDS debe incluir "${f}" (lo usa la plataforma)`);
  for (const f of fields) {
    if (!SAFE_KEY.test(f)) p.push(`Campo inválido: ${f}`);
    if (!mod.ETIQUETAS?.[f]) p.push(`Falta la etiqueta (ETIQUETAS) del campo "${f}"`);
    // Los de la plataforma están en la parte común del formulario.
    if (html !== undefined && !PLATFORM_FIELDS.includes(f) && !html.includes(`id="${f}"`)) {
      p.push(`formulario.html no tiene el campo id="${f}"`);
    }
  }
  for (const f of mod.FREE_TEXT_FIELDS || []) if (!fields.includes(f)) p.push(`FREE_TEXT_FIELDS: "${f}" no está en TEXT_FIELDS`);
}

/**
 * @param {ModuloEspecialidad} mod
 * @param {{formHtml?: string}} [extra] HTML del formulario para verificar sus campos
 * @returns {string[]} problemas encontrados (vacío = válida)
 */
export function validateSpecialty(mod, extra = {}) {
  /** @type {string[]} */
  const p = [];
  checkIdentity(mod, p);
  checkCatalogs(mod, p);
  checkFields(mod, extra.formHtml, p);
  for (const fn of REQUIRED_FUNCTIONS) if (typeof mod[fn] !== 'function') p.push(`Falta la función ${fn}()`);
  return p;
}
