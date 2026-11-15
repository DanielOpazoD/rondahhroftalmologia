/**
 * Pacientes como unidad.
 *
 * Un paciente es una ficha maestra (datos demográficos) compartida por todas
 * las especialidades; cada atención es un EPISODIO de una especialidad que
 * apunta a su paciente (`pacienteId`). Así un paciente acumula, a lo largo de
 * los años, atenciones de distintas fechas y especialidades.
 *
 * Forma (usa la misma estructura que una atención para reutilizar la fusión
 * campo a campo y la bitácora):
 *   { id: 'p_…', tipo: 'paciente', v: 1, created, updated, ft,
 *     f: { paciente_rut, paciente_nombre, paciente_fnac, paciente_sexo, paciente_fono },
 *     checks: {}, proc: {} }
 *
 * El id se deriva del RUT (o del nombre si no hay RUT): dos equipos que
 * registran al mismo paciente por separado obtienen el mismo id y sus datos
 * se fusionan en lugar de duplicarse.
 */
import { sha256 } from '../lib/sha256.js';
import { rutKey, normalizeText } from './format.js';

/** Campos de la ficha del paciente (mismos nombres que en la atención). */
export const PATIENT_FIELDS = ['paciente_rut', 'paciente_nombre', 'paciente_fnac', 'paciente_sexo', 'paciente_fono'];

export const PATIENT_SCHEMA = 1;

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const isValidId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
const hashId = (s) => Array.from(sha256(s).slice(0, 10), (b) => B32[b & 31]).join('');

/**
 * Id del paciente a partir de sus datos: por RUT si lo hay; si no, por nombre.
 * Devuelve null si no hay con qué identificarlo.
 * @param {Record<string, any>} f datos con paciente_rut / paciente_nombre
 */
export function patientIdFor(f = {}) {
  const k = rutKey(f.paciente_rut);
  if (k) return 'p_' + hashId('rut:' + k);
  const n = normalizeText(f.paciente_nombre);
  if (n) return 'p_' + hashId('nombre:' + n);
  return null;
}

/** Datos del paciente tomados de una atención (o de cualquier objeto con `f`). */
export function patientFields(f = {}) {
  const out = {};
  for (const k of PATIENT_FIELDS) if (f[k] !== undefined && f[k] !== null && String(f[k]).trim() !== '') out[k] = String(f[k]).trim();
  return out;
}

/**
 * Normaliza una ficha de paciente; null si no es válida.
 * @param {object} raw
 */
export function normalizePatient(raw) {
  if (!raw || typeof raw !== 'object' || !isValidId(raw.id) || !raw.id.startsWith('p_')) return null;
  const p = {
    id: raw.id,
    tipo: 'paciente',
    v: PATIENT_SCHEMA,
    created: Number(raw.created) || Number(raw.updated) || 0,
    updated: Number(raw.updated) || 0,
    f: patientFields(raw.f),
    checks: {},
    proc: {},
  };
  if (raw.ft && typeof raw.ft === 'object') {
    p.ft = {};
    for (const [k, v] of Object.entries(raw.ft)) if (k.startsWith('f.') && Number.isFinite(v)) p.ft[k] = v;
  }
  return p;
}

/**
 * Ficha nueva a partir de los datos de una atención. Sus campos quedan
 * fechados con `at` (fecha de la edición que los aportó).
 */
export function patientFromRecord(rec, at) {
  const id = rec.pacienteId || patientIdFor(rec.f);
  if (!id) return null;
  const f = patientFields(rec.f);
  return normalizePatient({ id, created: at, updated: at, f, ft: Object.fromEntries(Object.keys(f).map((k) => ['f.' + k, at])) });
}

/** Edad de referencia y texto breve del paciente para listas. */
export function patientLabel(p) {
  const f = p?.f || {};
  return f.paciente_nombre || f.paciente_rut || '(sin nombre)';
}

/**
 * Fichas que faltan para atenciones que apuntan a un paciente inexistente
 * (migración desde versiones sin pacientes, o atenciones recibidas de otro
 * equipo antes que su ficha). Idempotente: ids deterministas.
 * @param {object[]} records atenciones
 * @param {Map<string, object>|Record<string, object>} patients fichas existentes por id
 * @returns {object[]} fichas nuevas (la más reciente de cada paciente aporta los datos)
 */
export function missingPatients(records, patients) {
  const has = (id) => (patients instanceof Map ? patients.has(id) : Boolean(patients[id]));
  const out = new Map();
  for (const r of records) {
    const id = r.pacienteId || patientIdFor(r.f);
    if (!id || has(id)) continue;
    const at = r.updated || r.created || 0;
    const cur = out.get(id);
    if (!cur || at > cur.updated) out.set(id, patientFromRecord({ ...r, pacienteId: id }, at));
  }
  return [...out.values()].filter(Boolean);
}

/** Atenciones de un paciente, de la más reciente a la más antigua. */
export function attentionsOf(records, pacienteId) {
  return records
    .filter((r) => r.pacienteId === pacienteId)
    .sort(
      (a, b) =>
        (b.f?.fecha_atencion || '').localeCompare(a.f?.fecha_atencion || '') ||
        (b.created || 0) - (a.created || 0) ||
        (b.updated || 0) - (a.updated || 0),
    );
}

/**
 * ¿La atención ya tiene datos clínicos? (si no, es un preingreso pendiente).
 * Se consideran clínicos todos los campos que no son del paciente ni de la
 * organización (operativo, fecha, médico).
 */
const NON_CLINICAL = new Set([...PATIENT_FIELDS, 'paciente_edad', 'operativo', 'fecha_atencion', 'medico_nombre', 'medico_rut']);
export function isAttended(rec) {
  if (Object.values(rec.checks || {}).some(Boolean)) return true;
  if (Object.keys(rec.proc || {}).length || rec.cat) return true;
  return Object.entries(rec.f || {}).some(([k, v]) => !NON_CLINICAL.has(k) && String(v ?? '').trim() !== '');
}
