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
 *
 * Identidad a lo largo de los años (`resolvePatientId`): el id es solo una
 * llave estable; al paciente se lo encuentra por su RUT entre las fichas
 * existentes. Así, si alguien fue ingresado solo con nombre y después se
 * agrega su RUT, sigue siendo la misma ficha. Los duplicados que aun así
 * aparezcan se detectan (`findDuplicatePairs`) y se unen (`mergePatients`):
 * la ficha absorbida queda marcada con `f.fusionado_en` y sus atenciones se
 * re-vinculan. La marca se sincroniza campo a campo como cualquier dato.
 */
import { sha256 } from '../lib/sha256.js';
import { rutKey, normalizeText } from './format.js';
import { unknownFields, isSafeField } from './compat.js';

/** Campos de la ficha del paciente (mismos nombres que en la atención). */
export const PATIENT_FIELDS = ['paciente_rut', 'paciente_nombre', 'paciente_fnac', 'paciente_sexo', 'paciente_fono'];

export const PATIENT_SCHEMA = 1;

/** Campo de sistema: id de la ficha en que se unió esta (no es dato del paciente). */
export const MERGED_FIELD = 'fusionado_en';

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
  /** @type {Record<string, any>} */
  const p = {
    // Campos que agregue una versión más nueva se conservan (ver core/compat.js).
    ...unknownFields(raw, ['id', 'tipo', 'v', 'created', 'updated', 'f', 'ft', 'checks', 'proc']),
    id: raw.id,
    tipo: 'paciente',
    v: Math.max(PATIENT_SCHEMA, Number(raw.v) || 0),
    created: Number(raw.created) || Number(raw.updated) || 0,
    updated: Number(raw.updated) || 0,
    f: { ...unknownTextFields(raw.f), ...patientFields(raw.f) },
    checks: {},
    proc: {},
  };
  delete p.f[MERGED_FIELD];
  const into = raw.f?.[MERGED_FIELD];
  if (isValidId(into) && into.startsWith('p_') && into !== raw.id) p.f[MERGED_FIELD] = into;
  if (raw.ft && typeof raw.ft === 'object') {
    p.ft = {};
    for (const [k, v] of Object.entries(raw.ft)) if (k.startsWith('f.') && Number.isFinite(v)) p.ft[k] = v;
  }
  return p;
}

/** Textos de la ficha que esta versión no conoce (de una versión más nueva): se conservan. */
function unknownTextFields(f) {
  const out = {};
  if (!f || typeof f !== 'object') return out;
  for (const [k, v] of Object.entries(f)) {
    if (!PATIENT_FIELDS.includes(k) && k !== MERGED_FIELD && isSafeField(k) && typeof v === 'string' && v.trim() && v.length <= 2000) {
      out[k] = v;
    }
  }
  return out;
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

/* ------------------------------------------------- identidad y duplicados */

/** Fichas por id (acepta lista o Map). */
const asMap = (patients) => (patients instanceof Map ? patients : new Map((patients || []).map((p) => [p.id, p])));

/**
 * Ficha vigente de un id, siguiendo las uniones (A → B → C). Si dos equipos
 * unieron en sentidos opuestos (A → B y B → A), gana el id menor: el
 * resultado es el mismo en todos los equipos y ninguna ficha se pierde.
 */
export function canonicalPatientId(patients, id) {
  const map = asMap(patients);
  const seen = [];
  let cur = id;
  while (cur && !seen.includes(cur)) {
    seen.push(cur);
    const next = map.get(cur)?.f?.[MERGED_FIELD];
    if (!next) return cur;
    cur = next;
  }
  // Ciclo: el id menor del ciclo es la ficha vigente.
  const cycle = seen.slice(seen.indexOf(cur));
  return [...cycle].sort()[0];
}

/** ¿Es una ficha vigente (no unida a otra)? */
export const isCanonicalPatient = (patients, p) => canonicalPatientId(patients, p.id) === p.id;

/**
 * Id del paciente al que corresponden estos datos:
 * 1. si hay RUT y alguna ficha tiene ese RUT, esa ficha;
 * 2. si la atención ya estaba vinculada a una ficha, esa (aunque ahora se le agregue el RUT);
 * 3. si no, el id derivado de los datos (ficha nueva o ya existente).
 * Siempre devuelve la ficha vigente (siguiendo uniones).
 * @param {Record<string, any>} f
 * @param {object[] | Map<string, object>} patients
 * @param {string} [currentId]
 */
export function resolvePatientId(f, patients, currentId) {
  const map = asMap(patients);
  const k = rutKey(f?.paciente_rut);
  if (k) {
    const derived = 'p_' + hashId('rut:' + k);
    if (map.has(derived)) return canonicalPatientId(map, derived);
    for (const p of map.values()) if (rutKey(p.f?.paciente_rut) === k) return canonicalPatientId(map, p.id);
  }
  if (currentId) return canonicalPatientId(map, currentId);
  const id = patientIdFor(f);
  return id && map.has(id) ? canonicalPatientId(map, id) : id;
}

/**
 * Pares de fichas que probablemente son la misma persona (solo fichas vigentes):
 * - `rut`: mismo RUT (seguro);
 * - `nombre`: mismo nombre (sin tildes ni mayúsculas) y nada que las distinga
 *   (no tienen RUT distintos ni fechas de nacimiento distintas).
 * @param {object[] | Map<string, object>} patients
 * @param {Set<string>} [dismissed] pares "idA|idB" marcados como personas distintas
 * @returns {{a: object, b: object, motivo: 'rut' | 'nombre'}[]}
 */
export function findDuplicatePairs(patients, dismissed = new Set()) {
  const map = asMap(patients);
  const live = [...map.values()].filter((p) => isCanonicalPatient(map, p));
  const pairs = new Map();
  const add = (a, b, motivo) => {
    const [x, y] = a.id < b.id ? [a, b] : [b, a];
    const key = x.id + '|' + y.id;
    if (dismissed.has(key) || pairs.has(key)) return;
    pairs.set(key, { a: x, b: y, motivo });
  };
  const group = (keyOf) => {
    const g = new Map();
    for (const p of live) {
      const k = keyOf(p);
      if (!k) continue;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(p);
    }
    return [...g.values()].filter((list) => list.length > 1);
  };
  for (const list of group((p) => rutKey(p.f.paciente_rut))) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i], list[j], 'rut');
  }
  const differ = (a, b, k) => a.f[k] && b.f[k] && (k === 'paciente_rut' ? rutKey(a.f[k]) !== rutKey(b.f[k]) : a.f[k] !== b.f[k]);
  for (const list of group((p) => normalizeText(p.f.paciente_nombre))) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (!differ(a, b, 'paciente_rut') && !differ(a, b, 'paciente_fnac')) add(a, b, 'nombre');
      }
    }
  }
  return [...pairs.values()];
}

/**
 * Une la ficha `drop` en `keep`: `keep` completa sus datos vacíos con los de
 * `drop`, y `drop` queda marcada como unida. No une personas con RUT distintos.
 * Las atenciones se re-vinculan aparte (ver la acción de la interfaz).
 * @returns {{keep: object, drop: object}}
 */
export function mergePatients(keep, drop, at) {
  if (keep.id === drop.id) throw new Error('Es la misma ficha');
  const rk = rutKey(keep.f.paciente_rut);
  const rd = rutKey(drop.f.paciente_rut);
  if (rk && rd && rk !== rd) throw new Error('Tienen RUT distintos: no son la misma persona');
  const k = structuredClone(keep);
  k.ft ||= {};
  for (const f of PATIENT_FIELDS) {
    if (!k.f[f] && drop.f[f]) {
      k.f[f] = drop.f[f];
      k.ft['f.' + f] = at;
    }
  }
  k.updated = Math.max(at, (keep.updated || 0) + 1);
  const d = structuredClone(drop);
  d.ft ||= {};
  d.f[MERGED_FIELD] = keep.id;
  d.ft['f.' + MERGED_FIELD] = at;
  d.updated = Math.max(at, (drop.updated || 0) + 1);
  return { keep: normalizePatient(k), drop: normalizePatient(d) };
}
