/**
 * Capa de aplicación: las reglas de negocio de las acciones (guardar,
 * preingresar, re-vincular, mantener la ficha del paciente) como funciones
 * PURAS, sin DOM ni almacenamiento. La interfaz (ui/actions/) solo orquesta:
 * pide confirmaciones, persiste y re-dibuja. Así cada regla se prueba en Node.
 */
import { blankRecord, normalizeRecord, newRecordId, applyBirthDate } from '../core/record.js';
import { mergeRecords, sameContent, stampChanges, ensureFt } from '../core/merge.js';
import { resolvePatientId, patientFields, PATIENT_FIELDS } from '../core/patient.js';

/**
 * Atención lista para guardar: normalizada, fusionada con la versión guardada
 * (si otro equipo la cambió mientras se editaba), vinculada a su paciente y
 * con la versión nueva.
 * @param {{rec: import('../domain').Atencion, stored?: import('../domain').Atencion | null, patients: import('../domain').Paciente[] | Map<string, import('../domain').Paciente>, procs: {id: string, n: string}[], now: number}} o
 *   `rec`: la atención en edición; `stored`: la guardada con el mismo id (si hay).
 * @returns {import('../domain').Atencion} la atención a guardar
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
  ensureFt(rec);
  rec.updated = Math.max(now, (stored?.updated || 0) + 1);
  // El vínculo es un campo más: su cambio se fecha para que la fusión entre equipos lo respete.
  if (rec.pacienteId !== prevPid) rec.ft.pacienteId = rec.updated;
  rec.procNames = Object.fromEntries(
    Object.keys(rec.proc).map((id) => [id, procs.find((p) => p.id === id)?.n || rec.procNames?.[id] || id]),
  );
  return rec;
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
  return normalizeRecord(rec);
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
  return normalizeRecord({ ...next, pacienteId, updated: u, ft: { ...next.ft, pacienteId: u } });
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
  /** @type {import('../domain').FechasPorCampo} */
  const ft = {};
  for (const k of PATIENT_FIELDS) {
    const t = rec.ft?.['f.' + k] ?? (fields[k] ? rec.updated : undefined);
    if (t) ft['f.' + k] = t;
  }
  const candidate = { id: rec.pacienteId, created: rec.created || rec.updated, updated: rec.updated, f: fields, ft, checks: {}, proc: {} };
  const next = current ? mergeRecords(current, candidate) : candidate;
  if (current && sameContent(next, current)) return null;
  next.updated = Math.max(current?.updated || 0, rec.updated || 0, now);
  return next;
}
