/**
 * Capa de aplicación: las reglas de negocio de las acciones (guardar,
 * preingresar, re-vincular, mantener la ficha del paciente) como funciones
 * PURAS, sin DOM ni almacenamiento. La interfaz (ui/actions/) solo orquesta:
 * pide confirmaciones, persiste y re-dibuja. Así cada regla se prueba en Node.
 */
import { blankRecord, normalizeRecord, newRecordId, applyBirthDate, isSavedRecord } from '../core/record.js';
import { mergeRecords, sameContent, stampChanges, ensureFt } from '../core/merge.js';
import { resolvePatientId, patientFields, PATIENT_FIELDS, isDeletedPatient, DELETED_FIELD, renormalizePatient } from '../core/patient.js';
import { rutKey } from '../core/format.js';

/** @typedef {import('../domain').AtencionGuardada} AtencionGuardada */

/**
 * La atención con su id (invariante de las funciones de este módulo: siempre
 * le asignan uno válido). Si no lo tuviera, falla aquí y no al guardar.
 * @param {import('../domain').Atencion} r
 * @returns {AtencionGuardada}
 */
function withId(r) {
  if (!isSavedRecord(r)) throw new Error('Atención sin id válido');
  return r;
}

/**
 * Atención lista para guardar: normalizada, fusionada con la versión guardada
 * (si otro equipo la cambió mientras se editaba), vinculada a su paciente y
 * con la versión nueva.
 * @param {{rec: import('../domain').Atencion, stored?: import('../domain').Atencion | null, patients: import('../domain').Paciente[] | Map<string, import('../domain').Paciente>, procs: {id: string, n: string}[], now: number}} o
 *   `rec`: la atención en edición; `stored`: la guardada con el mismo id (si hay).
 * @returns {AtencionGuardada} la atención a guardar
 */
export function prepareSave({ rec: draft, stored = null, patients, procs, now }) {
  let rec = normalizeRecord(draft);
  if (!rec.id) {
    rec.id = newRecordId(now);
    rec.created = now;
  }
  if (stored) rec = normalizeRecord(mergeRecords(stored, rec));
  // Vínculo con la ficha: por RUT entre las fichas (si se agregó o corrigió el RUT, pasa a esa ficha).
  const prevPid = rec.pacienteId;
  rec.pacienteId = resolvePatientId(rec.f, patients, rec.pacienteId) || undefined;
  const { ft } = ensureFt(rec);
  rec.updated = Math.max(now, (stored?.updated || 0) + 1);
  // El vínculo es un campo más: su cambio se fecha para que la fusión entre equipos lo respete.
  if (rec.pacienteId !== prevPid) ft.pacienteId = rec.updated;
  rec.procNames = Object.fromEntries(
    Object.keys(rec.proc).map((id) => [id, procs.find((p) => p.id === id)?.n || rec.procNames?.[id] || id]),
  );
  return withId(rec);
}

/**
 * Preingreso: atención «por atender» con los datos del paciente (completados
 * desde su ficha, si existe), sin datos clínicos.
 * @param {{fields: Record<string, string>, fecha: string, operativo?: string, master?: {f?: Record<string, string>} | null, pacienteId: string, now: number}} o
 */
export function buildAdmission({ fields, fecha, operativo = '', master = null, pacienteId, now }) {
  const rec = blankRecord({ op: operativo });
  rec.f.fecha_atencion = fecha;
  Object.assign(rec.f, patientFields(master?.f), fields);
  applyBirthDate(rec);
  Object.assign(rec, { id: newRecordId(now), created: now, updated: now, pacienteId });
  stampChanges(rec, { f: {} }, now);
  return withId(normalizeRecord(rec));
}

/**
 * Campos no vacíos de un formulario de preingreso.
 * @template T
 * @param {Record<string, T>} data
 * @returns {Record<string, T>}
 */
export const nonEmpty = (data) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ''));

/**
 * La atención pasa a la ficha `pacienteId`: el cambio queda fechado y se
 * sincroniza campo a campo. Una atención antigua sin fechas por campo
 * conserva las de sus otros campos (ensureFt).
 * @param {import('../domain').Atencion} r
 * @param {string} pacienteId
 * @param {number} at
 */
export function relinkRecord(r, pacienteId, at) {
  const u = Math.max(at, (r.updated || 0) + 1);
  const next = ensureFt(structuredClone(r));
  return withId(normalizeRecord({ ...next, pacienteId, updated: u, ft: { ...next.ft, pacienteId: u } }));
}

/**
 * Fecha de edición de cada dato del paciente en la atención: la del campo o,
 * si la atención es antigua y no la trae, la de la atención (si el dato está).
 * @param {import('../domain').Atencion} rec
 * @param {Record<string, string>} fields datos del paciente en la atención
 * @returns {import('../domain').FechasPorCampo}
 */
function patientStamps(rec, fields) {
  /** @type {import('../domain').FechasPorCampo} */
  const ft = {};
  for (const k of PATIENT_FIELDS) {
    const t = rec.ft?.['f.' + k] ?? (fields[k] ? rec.updated : undefined);
    if (t) ft['f.' + k] = t;
  }
  return ft;
}

/**
 * Fecha de la restauración de una ficha eliminada: posterior a su eliminación,
 * para que la restauración gane.
 * @param {import('../domain').Paciente} current ficha eliminada
 * @param {number} now
 * @returns {number}
 */
function restoreStamp(current, now) {
  return Math.max(now, current.ft?.['f.' + DELETED_FIELD] || 0) + 1;
}

/**
 * Ficha del paciente actualizada con los datos de una atención, fusionada
 * campo a campo con la existente (gana lo editado más recientemente).
 * @param {import('../domain').Atencion} rec
 * @param {import('../domain').Paciente | null | undefined} current
 * @param {number} now
 * @returns {import('../domain').RegistroFusionable | null} la ficha a guardar, o null si no cambia nada
 */
export function patientUpdateFromRecord(rec, current, now) {
  if (!rec.pacienteId) return null;
  const fields = patientFields(rec.f);
  const ft = patientStamps(rec, fields);
  // Una atención que vuelve a usar una ficha eliminada la restaura (la restauración gana a la eliminación).
  if (current && isDeletedPatient(current)) ft['f.' + DELETED_FIELD] = restoreStamp(current, now);
  const candidate = { id: rec.pacienteId, created: rec.created || rec.updated, updated: rec.updated, f: fields, ft, checks: {}, proc: {} };
  const next = current ? mergeRecords(current, candidate) : candidate;
  if (current && sameContent(next, current)) return null;
  next.updated = Math.max(current?.updated || 0, rec.updated || 0, now);
  return next;
}

/**
 * Otra ficha (vigente) que ya tiene este RUT; null si no hay. Antes de
 * corregir el RUT de un paciente: si el RUT ya es de otra ficha, son la misma
 * persona y lo que corresponde es unirlas.
 * @param {import('../domain').Paciente[]} patients
 * @param {string} rut
 * @param {string} exceptId
 */
export function rutOwner(patients, rut, exceptId) {
  const k = rutKey(rut);
  if (!k) return null;
  return patients.find((p) => p.id !== exceptId && !isDeletedPatient(p) && !p.f?.fusionado_en && rutKey(p.f?.paciente_rut) === k) || null;
}

/** Valor de un campo editado, sin espacios en los extremos ('' si no hay). @param {unknown} v */
const cleanValue = (v) => String(v ?? '').trim();

/**
 * Escribe los campos corregidos (un valor vacío borra el dato) y fecha cada uno.
 * @param {Record<string, string>} f datos a corregir
 * @param {Record<string, number>} ft fechas por campo
 * @param {string[]} changed campos corregidos
 * @param {Record<string, string>} fields valores nuevos
 * @param {number} at fecha de la corrección
 */
function writeEdits(f, ft, changed, fields, at) {
  for (const k of changed) {
    const v = cleanValue(fields[k]);
    if (v) f[k] = v;
    else delete f[k];
    ft['f.' + k] = at;
  }
}

/**
 * Corrige los datos personales de un paciente (RUT, nombre, nacimiento, sexo,
 * fono) en su ficha y en todas sus atenciones, SIN cambiar el id de la ficha:
 * el historial y la continuidad de cada caso se mantienen. Cada campo queda
 * fechado (se sincroniza campo a campo sin pisar otros cambios). Un valor
 * vacío borra el dato.
 * @param {{patient: import('../domain').Paciente, fields: Record<string, string>, records: import('../domain').Atencion[], now: number}} o
 *   `records`: las atenciones de este equipo (se corrigen las de este paciente).
 * @returns {{patient: import('../domain').Paciente, records: {before: import('../domain').Atencion, after: AtencionGuardada}[], changed: string[]}}
 */
export function editPatientData({ patient, fields, records, now }) {
  const changed = PATIENT_FIELDS.filter((k) => k in fields && cleanValue(fields[k]) !== cleanValue(patient.f?.[k]));
  if (!changed.length) return { patient, records: [], changed };
  const p = structuredClone(patient);
  p.ft = { ...(p.ft || {}) };
  writeEdits(p.f, p.ft, changed, fields, now);
  p.updated = Math.max(now, (patient.updated || 0) + 1);
  const out = [];
  for (const r of records) {
    if (r.pacienteId !== patient.id) continue;
    const next = ensureFt(structuredClone(r));
    const u = Math.max(now, (r.updated || 0) + 1);
    writeEdits(next.f, next.ft, changed, fields, u);
    // La edad de cada atención se recalcula con la fecha de nacimiento corregida.
    if (changed.includes('paciente_fnac') && applyBirthDate(next)) next.ft['f.paciente_edad'] = u;
    next.updated = u;
    out.push({ before: r, after: withId(normalizeRecord(next)) });
  }
  return { patient: renormalizePatient(p), records: out, changed };
}
