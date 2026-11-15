/**
 * Respaldo JSON y unión de datos de varios equipos.
 * Compatible con respaldos de la versión 1 (`{app, v:1, procs, atenciones}`).
 */
import { APP } from '../config/catalogs.js';
import { normalizeRecord, sortRecords } from './record.js';

/** Crea el objeto de respaldo. */
export function buildBackup({ records, procs, anonSecret }, now = new Date()) {
  return {
    app: APP.id,
    v: 2,
    version_app: APP.version,
    exportado: now.toISOString(),
    procs,
    atenciones: records,
    // La clave permite que los códigos seudónimos coincidan entre equipos.
    ...(anonSecret ? { anonSecret } : {}),
  };
}

/**
 * Lee y valida un respaldo.
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
  return {
    records: data.atenciones.filter((r) => r && typeof r === 'object' && r.id).map(normalizeRecord),
    procs: Array.isArray(data.procs) ? data.procs.filter((p) => p && p.id && p.n) : [],
    anonSecret: typeof data.anonSecret === 'string' && /^[0-9a-f]{64}$/.test(data.anonSecret) ? data.anonSecret : null,
  };
}

/**
 * Une atenciones importadas con las locales sin duplicar (por id).
 * Si un id existe en ambos, gana la versión con `updated` más reciente.
 * @returns {{records: object[], procs: object[], added: number, updated: number, unchanged: number}}
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
    } else if ((r.updated || 0) > (cur.updated || 0)) {
      map.set(r.id, r);
      updated++;
    } else {
      unchanged++;
    }
  }
  const procs = [...local.procs];
  for (const p of incoming.procs) if (!procs.some((x) => x.id === p.id)) procs.push(p);
  return { records: sortRecords([...map.values()]), procs, added, updated, unchanged };
}
