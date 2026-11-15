/**
 * Respaldo JSON y unión de datos de varios equipos.
 * Compatible con respaldos de versiones anteriores (`{app, v:1|2, procs, atenciones}`).
 */
import { APP } from '../config/catalogs.js';
import { normalizeRecord, sortRecords, isValidId } from './record.js';
import { isFutureVersion, versionOf } from './migrations.js';
import { SCHEMA_VERSION } from '../config/catalogs.js';

/** Cuántas versiones de esquema por delante se aceptan en un respaldo. */
export const MAX_FUTURE_STEPS = 3;
import { mergeRecords, sameContent } from './merge.js';
import { mergeAuditDocs } from './audit.js';
import { normalizePatient } from './patient.js';

/**
 * Crea el objeto de respaldo.
 * @param {{records: object[], futureRecords?: object[], procs: object[], anonSecret?: string|null, auditDocs?: object[], patients?: object[]}} data
 */
export function buildBackup({ records, futureRecords = [], procs, anonSecret, auditDocs = [], patients = [] }, now = new Date()) {
  return {
    app: APP.id,
    v: 3,
    version_app: APP.version,
    exportado: now.toISOString(),
    procs,
    // Incluye intactas las atenciones de versiones más nuevas de la app.
    atenciones: [...records, ...futureRecords],
    bitacora: auditDocs,
    // Fichas de pacientes (desde la 2.9.0; los respaldos anteriores no las traen
    // y se reconstruyen a partir de las atenciones).
    pacientes: patients,
    // La clave permite que los códigos seudónimos coincidan entre equipos.
    ...(anonSecret ? { anonSecret } : {}),
  };
}

const validAuditDoc = (d) =>
  d &&
  typeof d === 'object' &&
  isValidId(d.id) &&
  d.id.startsWith('b_') &&
  Array.isArray(d.entries) &&
  d.entries.every((e) => e && typeof e.id === 'string' && Number.isFinite(e.at));

/**
 * Lee y valida un respaldo (v1, v2 o v3).
 * @throws {Error} si el contenido no es un respaldo válido
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('El archivo no es JSON válido');
  }
  if (!data || !Array.isArray(data.atenciones)) throw new Error('El archivo no es un respaldo de esta aplicación');
  if (data.app && data.app !== APP.id) throw new Error(`El respaldo es de otra aplicación (${data.app})`);
  const objects = data.atenciones.filter((r) => r && typeof r === 'object');
  return {
    // normalizeRecord anula ids inválidos; esos registros se descartan.
    records: objects
      .filter((r) => !isFutureVersion(r))
      .map(normalizeRecord)
      .filter((r) => r.id),
    // Solo versiones futuras plausibles (un archivo manipulado no puede declarar v999).
    futureRecords: objects.filter((r) => isFutureVersion(r) && versionOf(r) <= SCHEMA_VERSION + MAX_FUTURE_STEPS && isValidId(r.id)),
    procs: Array.isArray(data.procs)
      ? data.procs
          .filter((p) => p && isValidId(p.id) && typeof p.n === 'string' && p.n.trim())
          .map((p) => ({ id: p.id, n: p.n.trim(), pio: p.pio ? 1 : 0 }))
      : [],
    auditDocs: Array.isArray(data.bitacora) ? data.bitacora.filter(validAuditDoc) : [],
    patients: Array.isArray(data.pacientes) ? data.pacientes.map(normalizePatient).filter(Boolean) : [],
    anonSecret: typeof data.anonSecret === 'string' && /^[0-9a-f]{64}$/.test(data.anonSecret) ? data.anonSecret : null,
  };
}

/**
 * Une un respaldo importado con los datos locales sin duplicar (por id).
 * Si una atención existe en ambos, se fusiona CAMPO A CAMPO (igual que la
 * sincronización): no se pierde lo que cada copia tenga. La bitácora se une.
 * Una atención de versión FUTURA que reemplazaría a una atención actual con el
 * mismo id NO se aplica salvo `allowFutureOverride` (la interfaz lo pregunta):
 * un respaldo manipulado no puede ocultar atenciones existentes en silencio.
 * @param {{allowFutureOverride?: boolean}} [opts]
 * Las fichas de pacientes también se fusionan campo a campo.
 * @returns {{records: object[], futureRecords: object[], procs: object[], auditDocs: object[], patients: object[], added: number, updated: number, unchanged: number, futureConflicts: string[]}}
 */
export function mergeBackup(local, incoming, opts = {}) {
  const { allowFutureOverride = false } = opts;
  const map = new Map(local.records.map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const r of incoming.records) {
    const cur = map.get(r.id);
    if (!cur) {
      map.set(r.id, r);
      added++;
      continue;
    }
    const m = normalizeRecord(mergeRecords(cur, r));
    if (sameContent(m, cur)) {
      unchanged++;
    } else {
      m.updated = Math.max(cur.updated || 0, r.updated || 0) + 1;
      map.set(r.id, m);
      updated++;
    }
  }
  // Versiones futuras: se conservan intactas; entre dos, la más nueva.
  const future = new Map((local.futureRecords || []).map((r) => [r.id, r]));
  const futureConflicts = [];
  for (const r of incoming.futureRecords || []) {
    if (map.has(r.id)) {
      // Reemplazaría una atención actual: solo con autorización explícita.
      futureConflicts.push(r.id);
      if (!allowFutureOverride) continue;
      map.delete(r.id);
    }
    if (!future.has(r.id) || (r.updated || 0) > (future.get(r.id).updated || 0)) future.set(r.id, r);
  }
  const audit = new Map((local.auditDocs || []).map((d) => [d.id, d]));
  for (const d of incoming.auditDocs || []) {
    const cur = audit.get(d.id);
    if (!cur) {
      audit.set(d.id, d);
      continue;
    }
    const m = mergeAuditDocs(cur, d);
    // Si el respaldo trae entradas que este equipo no tenía, es una versión
    // nueva (si no, la sincronización no sabría que cambió).
    if (m.entries.length > (cur.entries?.length || 0)) m.updated = Math.max(cur.updated || 0, d.updated || 0) + 1;
    audit.set(d.id, m);
  }

  const patients = new Map((local.patients || []).map((p) => [p.id, p]));
  for (const p of incoming.patients || []) {
    const cur = patients.get(p.id);
    if (!cur) patients.set(p.id, p);
    else {
      const m = normalizePatient(mergeRecords(cur, p));
      if (m && !sameContent(m, cur)) patients.set(p.id, { ...m, updated: Math.max(cur.updated || 0, p.updated || 0) + 1 });
    }
  }

  const procs = [...local.procs];
  for (const p of incoming.procs) if (!procs.some((x) => x.id === p.id)) procs.push(p);
  return {
    records: sortRecords([...map.values()]),
    futureRecords: [...future.values()],
    procs,
    auditDocs: [...audit.values()],
    patients: [...patients.values()],
    added,
    updated,
    unchanged,
    futureConflicts,
  };
}
