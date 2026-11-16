/**
 * Modelo de datos de una atención: creación, migración y validación.
 *
 * Forma de un registro (ver docs/MODELO_DATOS.md):
 * {
 *   v: 3,                         // versión de esquema
 *   especialidad: 'oftalmologia', // separa datos de distintas rondas
 *   id: 'a…' | null,              // null mientras no se guarda
 *   created, updated: number,     // epoch ms
 *   f: { [campo]: string },       // campos de texto (TEXT_FIELDS)
 *   checks: { [key]: boolean },   // antecedentes / solicitados / diagnósticos
 *   cat: '' | 'OD' | 'OI' | 'AO', // lateralidad de catarata
 *   proc: { [procId]: { eye: 'OD'|'OI'|'AO', od?: string, oi?: string } },
 *   procNames: { [procId]: string }, // nombre del procedimiento al guardar
 *   ft: { [ruta]: number }   // fecha de edición de cada campo (fusión entre equipos, ver merge.js)
 * }
 */
import { SCHEMA_VERSION, LIMITS, SEXOS, ESPECIALIDAD } from '../config/catalogs.js';
import { OJOS } from '../specialties/activa/config.js';
import { validarClinico } from '../specialties/activa/validacion.js';
import { migrate } from './migrations.js';
import { refreshNames, nameParts, personName } from './names.js';
import { todayIso, isIsoDate, isValidRut, rutKey, normalizeText, parseNumber, ageAt, compareCode } from './format.js';

/**
 * Atención recién creada en el formulario. Es una Atencion (normalizeRecord
 * devuelve una que se le puede asignar), salvo `proc`, que el formulario
 * completa por partes (ver ProcRealizado en domain.d.ts).
 * @typedef {{v: number, especialidad: string, id: string|null, checks: Record<string, boolean>, cat: string,
 *   proc: {}, ft?: import('../domain').FechasPorCampo, f: Record<string, string>,
 *   created?: number, updated?: number, pacienteId?: string, procNames?: Record<string, string>}} AtencionEnBlanco
 */

/**
 * Registro vacío listo para completar.
 * @param {{n?: string, r?: string, op?: string, apellido_paterno?: string, apellido_materno?: string, nombres?: string}} [medico] datos recordados del médico
 * @returns {AtencionEnBlanco}
 */
export function blankRecord(medico = {}, now = new Date()) {
  return {
    v: SCHEMA_VERSION,
    especialidad: ESPECIALIDAD.id,
    id: null,
    checks: {},
    cat: '',
    proc: {},
    ft: {}, // fecha de edición por campo (ver core/merge.js)
    f: {
      fecha_atencion: todayIso(now),
      medico_nombre: medico.n || '',
      ...Object.fromEntries(Object.entries(nameParts(medico)).map(([k, v]) => ['medico_' + k, v])),
      medico_rut: medico.r || '',
      operativo: medico.op || '',
    },
  };
}

/**
 * Lleva cualquier registro (versión anterior, posiblemente incompleto) a la
 * forma actual sin perder información. No modifica el objeto recibido.
 * @param {unknown} raw
 * @returns {import('../domain').Atencion}
 * @throws {import('./migrations.js').FutureVersionError} si es de una versión más nueva
 */
export function normalizeRecord(raw) {
  // Migra paso a paso (lanza FutureVersionError si es de una versión más nueva: no se degrada).
  // Desde aquí se completa y valida cada parte: al final tiene la forma de una atención.
  const r = /** @type {import('../domain').Atencion} */ (migrate(raw && typeof raw === 'object' ? structuredCloneSafe(raw) : {}));
  r.especialidad = typeof r.especialidad === 'string' && r.especialidad ? r.especialidad : ESPECIALIDAD.id;
  // Los ids vienen también de respaldos importados: solo se aceptan caracteres seguros.
  r.id = isValidId(r.id) ? r.id : null;
  r.f = objectOr(r.f);
  r.checks = objectOr(r.checks);
  r.proc = objectOr(r.proc);
  r.cat = OJOS.includes(r.cat) ? r.cat : '';
  cleanStamps(r);
  for (const [id, p] of Object.entries(r.proc)) if (!safeKey(id) || !p || !OJOS.includes(p.eye)) delete r.proc[id];
  for (const obj of [r.f, r.checks]) for (const k of Object.keys(obj)) if (!safeKey(k)) delete obj[k];
  // Campos: siempre texto; null/undefined se quitan.
  for (const [k, v] of Object.entries(r.f)) {
    if (v === null || v === undefined) delete r.f[k];
    else if (typeof v !== 'string') r.f[k] = String(v);
  }
  refreshNames(r.f);
  return r;
}

/** El objeto si es un objeto; si no, uno vacío. @template T @param {T} v @returns {T} */
const objectOr = (v) => (v && typeof v === 'object' ? v : /** @type {T} */ ({}));

/** Sellos de tiempo por campo (`ft`): solo números finitos; si no es un objeto, se quita. @param {import('../domain').Atencion} r */
function cleanStamps(r) {
  if (r.ft === undefined) return;
  if (!r.ft || typeof r.ft !== 'object' || Array.isArray(r.ft)) delete r.ft;
  else for (const [k, v] of Object.entries(r.ft)) if (!Number.isFinite(v)) delete r.ft[k];
}

/**
 * Id seguro para atenciones y procedimientos: letras, números, "_" o "-" (1–64).
 * @param {unknown} id
 * @returns {id is string}
 */
export function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * ¿La atención tiene un id válido (ya se guardó)? normalizeRecord deja en null los inválidos.
 * @param {import('../domain').Atencion} r
 * @returns {r is import('../domain').AtencionGuardada}
 */
export const isSavedRecord = (r) => isValidId(r.id);

/** Claves aceptadas en f / checks / proc (evita `__proto__` y similares en datos externos). */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
/** @param {string} k */
const safeKey = (k) => SAFE_KEY.test(k) && !UNSAFE.has(k);

/** Genera un id único para una atención. */
export function newRecordId(now = Date.now(), rand = Math.random) {
  return 'a' + now.toString(36) + rand().toString(36).slice(2, 6);
}

/**
 * Valida un registro antes de guardarlo.
 * - errors: impiden guardar.
 * - warnings: se informan pero permiten guardar (datos de terreno pueden ser incompletos).
 * @param {import('../domain').Atencion} rec
 * @returns {{errors: string[], warnings: string[], fields: Record<string, {msg: string, level: 'error'|'warn'}>}}
 *   `fields` asocia id de campo -> mensaje y nivel, para marcarlo en la interfaz.
 */
export function validateRecord(rec, now = new Date()) {
  const f = rec.f || {};
  /** @type {Validacion} */
  const v = { errors: [], warnings: [], fields: {} };
  /** @type {Avisar} */
  const warn = (field, msg) => {
    v.warnings.push(msg);
    v.fields[field] = { msg, level: 'warn' };
  };
  /** @type {(field: string, msg: string, fieldMsg?: string) => void} */
  const error = (field, msg, fieldMsg = msg) => {
    v.errors.push(msg);
    v.fields[field] = { msg: fieldMsg, level: 'error' };
  };
  checkIdentity(f, warn, error);
  checkDates(f, warn, error, todayIso(now));
  checkDemographics(f, warn);
  // Validaciones clínicas propias de la especialidad activa.
  validarClinico(rec, warn, (msg) => v.warnings.push(msg));
  return v;
}

/**
 * @typedef {{errors: string[], warnings: string[], fields: Record<string, {msg: string, level: 'error'|'warn'}>}} Validacion
 * @typedef {(field: string, msg: string) => void} Avisar
 * @typedef {(field: string, msg: string, fieldMsg?: string) => void} MarcarError
 */

/** Paciente identificable (nombre o RUT) y RUT con dígito verificador correcto. @param {Record<string, string>} f @param {Avisar} warn @param {MarcarError} error */
function checkIdentity(f, warn, error) {
  if (!f.paciente_nombre?.trim() && !f.paciente_rut?.trim()) {
    error('paciente_nombres', 'Falta nombre o RUT del paciente', 'Requerido (nombre o RUT)');
  }
  if (f.paciente_rut?.trim() && !isValidRut(f.paciente_rut)) warn('paciente_rut', 'RUT con dígito verificador inválido');
  if (f.medico_rut?.trim() && !isValidRut(f.medico_rut)) warn('medico_rut', 'RUT del médico inválido');
}

/** Fecha de atención (requerida, no futura) y de nacimiento (válida y plausible). @param {Record<string, string>} f @param {Avisar} warn @param {MarcarError} error @param {string} today */
function checkDates(f, warn, error, today) {
  const fecha = isIsoDate(f.fecha_atencion) ? f.fecha_atencion : '';
  if (!fecha) error('fecha_atencion', 'Falta la fecha de atención', 'Requerida');
  else if (fecha > today) warn('fecha_atencion', 'La fecha de atención es futura');
  if (!f.paciente_fnac) return;
  if (!isIsoDate(f.paciente_fnac)) warn('paciente_fnac', 'Fecha de nacimiento no válida');
  else if (fecha && f.paciente_fnac > fecha) warn('paciente_fnac', 'Nacimiento posterior a la fecha de atención');
  else {
    // Sin edad (null) cuando, sin fecha de atención, el nacimiento es posterior a hoy.
    const edad = ageAt(f.paciente_fnac, fecha || today);
    if (edad !== null && edad > LIMITS.edadMax) warn('paciente_fnac', 'Fecha de nacimiento implausible');
  }
}

/** Edad (años enteros 0–120) y sexo del catálogo. @param {Record<string, string>} f @param {Avisar} warn */
function checkDemographics(f, warn) {
  if (f.paciente_edad?.trim()) {
    const e = parseNumber(f.paciente_edad);
    if (e === null || e < 0 || e > LIMITS.edadMax || !Number.isInteger(e)) warn('paciente_edad', 'Edad no válida (años enteros 0–120)');
  }
  if (f.paciente_sexo && !SEXOS.some((s) => s.key === f.paciente_sexo)) warn('paciente_sexo', 'Sexo no reconocido');
}

/**
 * Clave que identifica a un paciente para contar "pacientes distintos" y
 * generar su código seudónimo: RUT canónico si existe; si no, el nombre
 * normalizado.
 * @param {import('../domain').RegistroFusionable} rec
 * @returns {{key: string, basis: 'rut'|'nombre'|'id'}}
 */
export function patientKey(rec) {
  const k = rutKey(rec.f?.paciente_rut);
  if (k) return { key: 'rut:' + k, basis: 'rut' };
  const n = normalizeText(personName(rec.f || {}, 'paciente_'));
  if (n) return { key: 'nombre:' + n, basis: 'nombre' };
  return { key: 'id:' + rec.id, basis: 'id' };
}

/** Identidad para conteo y duplicados: conserva la ficha al organizar un nombre sin RUT.
 * @param {import('../domain').RegistroFusionable} rec
 */
export function patientIdentityKey(rec) {
  const p = patientKey(rec);
  return p.basis !== 'rut' && rec.pacienteId ? 'paciente:' + rec.pacienteId : p.key;
}

/**
 * Busca otra atención del mismo paciente en la misma fecha (posible duplicado).
 * @template {import('../domain').RegistroFusionable} T
 * @param {import('../domain').RegistroFusionable} rec
 * @param {T[]} records
 * @returns {T|undefined}
 */
export function findDuplicate(rec, records) {
  const key = patientKey(rec).key;
  return records.find(
    (r) =>
      r.id !== rec.id &&
      r.f?.fecha_atencion === rec.f?.fecha_atencion &&
      (patientIdentityKey(r) === patientIdentityKey(rec) || patientKey(r).key === key),
  );
}

/**
 * Ordena atenciones: fecha más reciente primero; a igual fecha, la última creada primero.
 * @template {import('../domain').RegistroFusionable} T
 * @param {T[]} records
 * @returns {T[]}
 */
export function sortRecords(records) {
  return [...records].sort(
    (a, b) => compareCode(b.f?.fecha_atencion || '', a.f?.fecha_atencion || '') || (b.created || 0) - (a.created || 0),
  );
}

/**
 * @param {object} o
 * @returns {object}
 */
function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

/**
 * Si hay fecha de nacimiento válida, calcula la edad a la fecha de atención
 * (o a hoy) y la deja en `f.paciente_edad`. Devuelve true si cambió la edad.
 * @param {import('../domain').RegistroFusionable} rec
 */
export function applyBirthDate(rec, now = new Date()) {
  const f = rec.f || {};
  if (!isIsoDate(f.paciente_fnac)) return false;
  const age = ageAt(f.paciente_fnac, isIsoDate(f.fecha_atencion) ? f.fecha_atencion : todayIso(now));
  const next = age === null ? '' : String(age);
  if ((f.paciente_edad || '') === next) return false;
  f.paciente_edad = next;
  return true;
}
