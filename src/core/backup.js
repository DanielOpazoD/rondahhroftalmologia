/**
 * Respaldo JSON y unión de datos de varios equipos.
 * Compatible con respaldos de versiones anteriores (`{app, v:1|2, procs, atenciones}`).
 */
import { APP } from '../config/catalogs.js';
import { normalizeRecord, sortRecords, isValidId } from './record.js';
import { isFutureVersion } from './migrations.js';
import { mergeRecords, sameContent } from './merge.js';
import { mergeAuditDocs } from './audit.js';

/**
 * Crea el objeto de respaldo.
 * @param {{records: object[], futureRecords?: object[], procs: object[], anonSecret?: string|null, auditDocs?: object[]}} data
 */
export function buildBackup({ records, futureRecords = [], procs, anonSecret, auditDocs = [] }, now = new Date()) {
  return {
    app: APP.id,
    v: 3,
    version_app: APP.version,
    exportado: now.toISOString(),
    procs,
    // Incluye intactas las atenciones de versiones más nuevas de la app.
    atenciones: [...records, ...futureRecords],
    bitacora: auditDocs,
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
    futureRecords: objects.filter((r) => isFutureVersion(r) && isValidId(r.id)),
    procs: Array.isArray(data.procs)
      ? data.procs
          .filter((p) => p && isValidId(p.id) && typeof p.n === 'string' && p.n.trim())
          .map((p) => ({ id: p.id, n: p.n.trim(), pio: p.pio ? 1 : 0 }))
      : [],
    auditDocs: Array.isArray(data.bitacora) ? data.bitacora.filter(validAuditDoc) : [],
    anonSecret: typeof data.anonSecret === 'string' && /^[0-9a-f]{64}$/.test(data.anonSecret) ? data.anonSecret : null,
  };
}

/**
 * Une un respaldo importado con los datos locales sin duplicar (por id).
 * Si una atención existe en ambos, se fusiona CAMPO A CAMPO (igual que la
 * sincronización): no se pierde lo que cada copia tenga. La bitácora se une.
 * @returns {{records: object[], futureRecords: object[], procs: object[], auditDocs: object[], added: number, updated: number, unchanged: number}}
 */
export function mergeBackup(local, incoming) {
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
  for (const r of incoming.futureRecords || []) {
    if (!future.has(r.id) || (r.updated || 0) > (future.get(r.id).updated || 0)) future.set(r.id, r);
  }
  const audit = new Map((local.auditDocs || []).map((d) => [d.id, d]));
  for (const d of incoming.auditDocs || []) audit.set(d.id, audit.has(d.id) ? mergeAuditDocs(audit.get(d.id), d) : d);

  const procs = [...local.procs];
  for (const p of incoming.procs) if (!procs.some((x) => x.id === p.id)) procs.push(p);
  return {
    records: sortRecords([...map.values()]),
    futureRecords: [...future.values()],
    procs,
    auditDocs: [...audit.values()],
    added,
    updated,
    unchanged,
  };
}
