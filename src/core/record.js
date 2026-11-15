/**
 * Modelo de datos de una atención: creación, migración y validación.
 *
 * Forma de un registro (ver docs/MODELO_DATOS.md):
 * {
 *   v: 2,                         // versión de esquema
 *   id: 'a…' | null,              // null mientras no se guarda
 *   created, updated: number,     // epoch ms
 *   f: { [campo]: string },       // campos de texto (TEXT_FIELDS)
 *   checks: { [key]: boolean },   // antecedentes / solicitados / diagnósticos
 *   cat: '' | 'OD' | 'OI' | 'AO', // lateralidad de catarata
 *   proc: { [procId]: { eye: 'OD'|'OI'|'AO', od?: string, oi?: string } },
 *   procNames: { [procId]: string } // nombre del procedimiento al guardar
 * }
 */
import { SCHEMA_VERSION, LIMITS, OJOS, SEXOS } from '../config/catalogs.js';
import { todayIso, isIsoDate, isValidRut, rutKey, normalizeText, parseNumber } from './format.js';

/**
 * Registro vacío listo para completar.
 * @param {{n?: string, r?: string, op?: string}} [medico] datos recordados del médico
 */
export function blankRecord(medico = {}, now = new Date()) {
  return {
    v: SCHEMA_VERSION,
    id: null,
    checks: {},
    cat: '',
    proc: {},
    f: {
      fecha_atencion: todayIso(now),
      medico_nombre: medico.n || '',
      medico_rut: medico.r || '',
      operativo: medico.op || '',
    },
  };
}

/**
 * Lleva cualquier registro (v1 o v2, posiblemente incompleto) a la forma
 * actual sin perder información. No modifica el objeto recibido.
 */
export function normalizeRecord(raw) {
  const r = raw && typeof raw === 'object' ? structuredCloneSafe(raw) : {};
  r.v = SCHEMA_VERSION;
  // Los ids vienen también de respaldos importados: solo se aceptan caracteres seguros.
  r.id = isValidId(r.id) ? r.id : null;
  r.f = r.f && typeof r.f === 'object' ? r.f : {};
  r.checks = r.checks && typeof r.checks === 'object' ? r.checks : {};
  r.proc = r.proc && typeof r.proc === 'object' ? r.proc : {};
  r.cat = OJOS.includes(r.cat) ? r.cat : '';
  for (const [id, p] of Object.entries(r.proc)) {
    if (!p || !OJOS.includes(p.eye)) delete r.proc[id];
  }
  for (const [k, v] of Object.entries(r.f)) {
    if (v === null || v === undefined) delete r.f[k];
    else if (typeof v !== 'string') r.f[k] = String(v);
  }
  return r;
}

/** Id seguro para atenciones y procedimientos: letras, números, "_" o "-" (1–64). */
export function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Genera un id único para una atención. */
export function newRecordId(now = Date.now(), rand = Math.random) {
  return 'a' + now.toString(36) + rand().toString(36).slice(2, 6);
}

/**
 * Valida un registro antes de guardarlo.
 * - errors: impiden guardar.
 * - warnings: se informan pero permiten guardar (datos de terreno pueden ser incompletos).
 * @returns {{errors: string[], warnings: string[], fields: Record<string, {msg: string, level: 'error'|'warn'}>}}
 *   `fields` asocia id de campo -> mensaje y nivel, para marcarlo en la interfaz.
 */
export function validateRecord(rec, now = new Date()) {
  const f = rec.f || {};
  const errors = [];
  const warnings = [];
  const fields = {};
  const warn = (field, msg) => {
    warnings.push(msg);
    fields[field] = { msg, level: 'warn' };
  };
  const error = (field, msg, fieldMsg = msg) => {
    errors.push(msg);
    fields[field] = { msg: fieldMsg, level: 'error' };
  };

  if (!f.paciente_nombre?.trim() && !f.paciente_rut?.trim()) {
    error('paciente_nombre', 'Falta nombre o RUT del paciente', 'Requerido (nombre o RUT)');
  }
  if (f.paciente_rut?.trim() && !isValidRut(f.paciente_rut)) warn('paciente_rut', 'RUT con dígito verificador inválido');
  if (f.medico_rut?.trim() && !isValidRut(f.medico_rut)) warn('medico_rut', 'RUT del médico inválido');

  if (!isIsoDate(f.fecha_atencion)) {
    error('fecha_atencion', 'Falta la fecha de atención', 'Requerida');
  } else if (f.fecha_atencion > todayIso(now)) {
    warn('fecha_atencion', 'La fecha de atención es futura');
  }

  if (f.paciente_edad?.trim()) {
    const e = parseNumber(f.paciente_edad);
    if (e === null || e < 0 || e > LIMITS.edadMax || !Number.isInteger(e)) warn('paciente_edad', 'Edad no válida (años enteros 0–120)');
  }
  if (f.paciente_sexo && !SEXOS.some((s) => s.key === f.paciente_sexo)) warn('paciente_sexo', 'Sexo no reconocido');

  const pioOk = (v) => {
    const n = parseNumber(v);
    return n !== null && n >= LIMITS.pioMin && n <= LIMITS.pioMax;
  };
  for (const e of ['od', 'oi']) {
    const v = f[`${e}_pio`];
    if (v?.trim() && !pioOk(v)) warn(`${e}_pio`, `PIO ${e.toUpperCase()} fuera de rango (0–80 mmHg)`);
  }
  for (const p of Object.values(rec.proc || {})) {
    for (const e of ['od', 'oi']) {
      if (p[e]?.trim() && !pioOk(p[e])) {
        warnings.push(`PIO ${e.toUpperCase()} de un procedimiento fuera de rango (0–80 mmHg)`);
      }
    }
  }
  if (rec.checks?.diagnostico_catarata && !rec.cat) warn('catSeg', 'Catarata sin ojo indicado');

  return { errors, warnings, fields };
}

/**
 * Clave que identifica a un paciente para contar "pacientes distintos" y
 * generar su código seudónimo: RUT canónico si existe; si no, el nombre
 * normalizado.
 * @returns {{key: string, basis: 'rut'|'nombre'|'id'}}
 */
export function patientKey(rec) {
  const k = rutKey(rec.f?.paciente_rut);
  if (k) return { key: 'rut:' + k, basis: 'rut' };
  const n = normalizeText(rec.f?.paciente_nombre);
  if (n) return { key: 'nombre:' + n, basis: 'nombre' };
  return { key: 'id:' + rec.id, basis: 'id' };
}

/**
 * Busca otra atención del mismo paciente en la misma fecha (posible duplicado).
 * @returns {object|undefined}
 */
export function findDuplicate(rec, records) {
  const key = patientKey(rec).key;
  return records.find(
    (r) => r.id !== rec.id && r.f?.fecha_atencion === rec.f?.fecha_atencion && patientKey(r).key === key,
  );
}

/** Ordena atenciones: fecha más reciente primero; a igual fecha, la última creada primero. */
export function sortRecords(records) {
  return [...records].sort(
    (a, b) => (b.f?.fecha_atencion || '').localeCompare(a.f?.fecha_atencion || '') || (b.created || 0) - (a.created || 0),
  );
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}
