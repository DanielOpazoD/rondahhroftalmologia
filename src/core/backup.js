/**
 * Respaldo JSON y unión de datos de varios equipos.
 * Compatible con respaldos de versiones anteriores (`{app, v:1|2, procs, atenciones}`).
 */
import { APP } from '../config/catalogs.js';
import { normalizeRecord, sortRecords, isValidId, isSavedRecord } from './record.js';
import { isFutureVersion, versionOf } from './migrations.js';
import { SCHEMA_VERSION } from '../config/catalogs.js';

/** Cuántas versiones de esquema por delante se aceptan en un respaldo. */
export const MAX_FUTURE_STEPS = 3;
import { mergeRecords, sameContent } from './merge.js';
import { mergeAuditDocs } from './audit.js';
import { normalizePatient } from './patient.js';
import { normalizeAttachment, sha256Hex } from './attachments.js';
import { createZip, readZip, isZip } from '../lib/zip.js';

/**
 * Datos que se respaldan o se unen (los locales y los leídos de un respaldo).
 * `futureRecords`: atenciones de versiones más nuevas de la app, intactas.
 * @typedef {{records: import('../domain').AtencionGuardada[], futureRecords?: RegistroFuturo[],
 *   procs: import('../domain').Procedimiento[], auditDocs?: import('../domain').AuditDoc[], patients?: import('../domain').Paciente[],
 *   attachments?: any[]}} DatosRespaldo
 *   `attachments`: metadatos de los adjuntos (su contenido va en el ZIP: ver packBackup).
 */

/**
 * Atención de una versión más nueva leída de un respaldo: solo se sabe que su id es válido.
 * @typedef {import('../domain').RegistroFusionable & {id: string}} RegistroFuturo
 */

/**
 * ¿Es una atención de versión futura plausible (con id válido)? Un archivo manipulado no puede declarar v999.
 * @param {Record<string, unknown>} r
 * @returns {r is RegistroFuturo}
 */
const isPlausibleFuture = (r) => isFutureVersion(r) && versionOf(r) <= SCHEMA_VERSION + MAX_FUTURE_STEPS && isValidId(r.id);

/**
 * Crea el objeto de respaldo.
 * @param {DatosRespaldo & {anonSecret?: string|null, practica?: boolean}} data
 *   `practica`: respaldo del modo práctica (datos de ejemplo; no se importa a los datos reales).
 */
export function buildBackup(
  { records, futureRecords = [], procs, anonSecret, auditDocs = [], patients = [], attachments = [], practica = false },
  now = new Date(),
) {
  return {
    app: APP.id,
    v: 3,
    version_app: APP.version,
    exportado: now.toISOString(),
    ...(practica ? { practica: true } : {}),
    procs,
    // Incluye intactas las atenciones de versiones más nuevas de la app.
    atenciones: [...records, ...futureRecords],
    bitacora: auditDocs,
    // Fichas de pacientes (desde la 2.9.0; los respaldos anteriores no las traen
    // y se reconstruyen a partir de las atenciones).
    pacientes: patients,
    // Metadatos de los adjuntos (desde la 2.15.0); su contenido va en el ZIP.
    ...(attachments.length ? { adjuntos: attachments } : {}),
    // La clave permite que los códigos seudónimos coincidan entre equipos.
    ...(anonSecret ? { anonSecret } : {}),
  };
}

/** @param {any} d documento de bitácora leído del respaldo (sin validar) */
const validAuditDoc = (d) =>
  d &&
  typeof d === 'object' &&
  isValidId(d.id) &&
  d.id.startsWith('b_') &&
  Array.isArray(d.entries) &&
  d.entries.every((/** @type {any} */ e) => e && typeof e.id === 'string' && Number.isFinite(e.at));

/**
 * Lee y valida un respaldo (v1, v2 o v3).
 * @param {string} text
 * @returns {DatosRespaldo & {practica: boolean, anonSecret: string|null}}
 * @throws {Error} si el contenido no es un respaldo válido
 */
export function parseBackup(text) {
  /** @type {any} JSON del archivo, sin validar */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('El archivo no es JSON válido');
  }
  if (!data || !Array.isArray(data.atenciones)) throw new Error('El archivo no es un respaldo de esta aplicación');
  if (data.app && data.app !== APP.id) throw new Error(`El respaldo es de otra aplicación (${data.app})`);
  /** @type {Record<string, unknown>[]} */
  const objects = data.atenciones.filter((/** @type {unknown} */ r) => r && typeof r === 'object');
  return {
    // normalizeRecord anula ids inválidos; esos registros se descartan.
    records: objects
      .filter((r) => !isFutureVersion(r))
      .map(normalizeRecord)
      .filter(isSavedRecord),
    // Solo versiones futuras plausibles.
    futureRecords: objects.filter(isPlausibleFuture),
    procs: Array.isArray(data.procs)
      ? data.procs
          .filter((/** @type {any} */ p) => p && isValidId(p.id) && typeof p.n === 'string' && p.n.trim())
          .map((/** @type {any} */ p) => ({ id: p.id, n: p.n.trim(), pio: p.pio ? 1 : 0 }))
      : [],
    auditDocs: Array.isArray(data.bitacora) ? data.bitacora.filter(validAuditDoc) : [],
    patients: Array.isArray(data.pacientes) ? data.pacientes.map(normalizePatient).filter(Boolean) : [],
    attachments: Array.isArray(data.adjuntos) ? data.adjuntos.map(normalizeAttachment).filter(Boolean) : [],
    practica: data.practica === true,
    anonSecret: typeof data.anonSecret === 'string' && /^[0-9a-f]{64}$/.test(data.anonSecret) ? data.anonSecret : null,
  };
}

/** Versión nueva tras fusionar dos copias distintas (mayor que ambas). @param {{updated?: number}} a @param {{updated?: number}} b */
const bumped = (a, b) => Math.max(a.updated || 0, b.updated || 0) + 1;

/** @typedef {import('../domain').AtencionGuardada} AtencionGuardada */

/**
 * Atenciones: las nuevas se agregan; las que existen en ambos se fusionan campo a campo.
 * @param {AtencionGuardada[]} local @param {AtencionGuardada[]} incoming
 */
function mergeRecordsById(local, incoming) {
  const map = new Map(local.map((r) => [r.id, r]));
  const count = { added: 0, updated: 0, unchanged: 0 };
  for (const r of incoming) {
    const cur = map.get(r.id);
    if (!cur) {
      map.set(r.id, r);
      count.added++;
      continue;
    }
    const m = normalizeRecord(mergeRecords(cur, r));
    if (sameContent(m, cur)) count.unchanged++;
    else {
      map.set(r.id, { ...m, id: r.id, updated: bumped(cur, r) });
      count.updated++;
    }
  }
  return { map, ...count };
}

/**
 * Versiones futuras: se conservan intactas; entre dos, la más nueva. Una que
 * reemplazaría una atención actual (en `current`) solo se aplica con
 * `allowOverride`, y entonces sale de `current`.
 * @param {RegistroFuturo[]} local @param {RegistroFuturo[]} incoming
 * @param {Map<string, AtencionGuardada>} current @param {boolean} allowOverride
 */
function mergeFuture(local, incoming, current, allowOverride) {
  const future = new Map(local.map((r) => [r.id, r]));
  /** @type {string[]} */
  const conflicts = [];
  for (const r of incoming) {
    if (current.has(r.id)) {
      conflicts.push(r.id);
      if (!allowOverride) continue;
      current.delete(r.id);
    }
    const cur = future.get(r.id);
    if (!cur || (r.updated || 0) > (cur.updated || 0)) future.set(r.id, r);
  }
  return { future, conflicts };
}

/**
 * Bitácoras: se unen las entradas. Si el respaldo trae entradas que este equipo
 * no tenía, es una versión nueva (si no, la sincronización no sabría que cambió).
 * @param {import('../domain').AuditDoc[]} local @param {import('../domain').AuditDoc[]} incoming
 */
function mergeAuditById(local, incoming) {
  const audit = new Map(local.map((d) => [d.id, d]));
  for (const d of incoming) {
    const cur = audit.get(d.id);
    if (!cur) {
      audit.set(d.id, d);
      continue;
    }
    const m = mergeAuditDocs(cur, d);
    if (m.entries.length > (cur.entries?.length || 0)) m.updated = bumped(cur, d);
    audit.set(d.id, m);
  }
  return [...audit.values()];
}

/** Fichas de pacientes: se fusionan campo a campo. @param {import('../domain').Paciente[]} local @param {import('../domain').Paciente[]} incoming */
function mergePatientsById(local, incoming) {
  const patients = new Map(local.map((p) => [p.id, p]));
  for (const p of incoming) {
    const cur = patients.get(p.id);
    if (!cur) {
      patients.set(p.id, p);
      continue;
    }
    const m = normalizePatient(mergeRecords(cur, p));
    if (m && !sameContent(m, cur)) patients.set(p.id, { ...m, updated: bumped(cur, p) });
  }
  return [...patients.values()];
}

/**
 * Une un respaldo importado con los datos locales sin duplicar (por id).
 * Si una atención existe en ambos, se fusiona CAMPO A CAMPO (igual que la
 * sincronización): no se pierde lo que cada copia tenga. La bitácora se une.
 * Una atención de versión FUTURA que reemplazaría a una atención actual con el
 * mismo id NO se aplica salvo `allowFutureOverride` (la interfaz lo pregunta):
 * un respaldo manipulado no puede ocultar atenciones existentes en silencio.
 * Las fichas de pacientes también se fusionan campo a campo.
 * @param {DatosRespaldo} local
 * @param {DatosRespaldo} incoming
 * @param {{allowFutureOverride?: boolean}} [opts]
 * @returns {Required<Omit<DatosRespaldo, 'attachments'>> & {added: number, updated: number, unchanged: number, futureConflicts: string[]}}
 */
export function mergeBackup(local, incoming, opts = {}) {
  const { map, added, updated, unchanged } = mergeRecordsById(local.records, incoming.records);
  const { future, conflicts } = mergeFuture(
    local.futureRecords || [],
    incoming.futureRecords || [],
    map,
    Boolean(opts.allowFutureOverride),
  );
  const procs = [...local.procs];
  for (const p of incoming.procs) if (!procs.some((x) => x.id === p.id)) procs.push(p);
  return {
    records: sortRecords([...map.values()]),
    futureRecords: [...future.values()],
    procs,
    auditDocs: mergeAuditById(local.auditDocs || [], incoming.auditDocs || []),
    patients: mergePatientsById(local.patients || [], incoming.patients || []),
    added,
    updated,
    unchanged,
    futureConflicts: conflicts,
  };
}

/* ------------------------------------------------ respaldo con adjuntos */

const BACKUP_JSON = 'respaldo.json';
const CONTENT_DIR = 'adjuntos/';

/**
 * Respaldo en un ZIP: `respaldo.json` y el contenido de cada adjunto en
 * `adjuntos/<id>` (los nombres legibles están en los metadatos).
 * @param {object} backup objeto de buildBackup
 * @param {Map<string, Uint8Array>} contents id del adjunto → contenido
 */
export function packBackup(backup, contents, now = new Date()) {
  /** @type {{name: string, data: Uint8Array | string}[]} */
  const entries = [{ name: BACKUP_JSON, data: JSON.stringify(backup) }];
  for (const [id, data] of contents) entries.push({ name: CONTENT_DIR + id, data });
  return createZip(entries, now);
}

/**
 * Lee un archivo de respaldo: JSON (versiones anteriores, o sin adjuntos) o ZIP.
 * @param {Uint8Array} bytes
 * @returns {{text: string, contents: Map<string, Uint8Array>}}
 */
export function unpackBackup(bytes) {
  if (!isZip(bytes)) return { text: new TextDecoder().decode(bytes), contents: new Map() };
  const files = readZip(bytes);
  const json = files.get(BACKUP_JSON);
  if (!json) throw new Error('El ZIP no es un respaldo de esta aplicación');
  /** @type {Map<string, Uint8Array>} */
  const contents = new Map();
  for (const [name, data] of files) if (name.startsWith(CONTENT_DIR)) contents.set(name.slice(CONTENT_DIR.length), data);
  return { text: new TextDecoder().decode(json), contents };
}

/**
 * Qué adjuntos de un respaldo entran a este equipo: los que no están. El
 * contenido se acepta solo si coincide con su huella (un archivo dañado o
 * manipulado no entra); si falta, el adjunto entra igual y su contenido
 * llegará al sincronizar.
 * @param {any[]} metas metadatos del respaldo (ya normalizados)
 * @param {Map<string, Uint8Array>} contents
 * @param {(id: string) => boolean} known ¿este equipo ya tiene ese adjunto?
 * @returns {Promise<{metas: any[], contents: Map<string, Uint8Array>, rechazados: string[]}>}
 */
export async function attachmentsToImport(metas, contents, known) {
  const add = metas.filter((m) => !known(m.id));
  /** @type {Map<string, Uint8Array>} */
  const ok = new Map();
  /** @type {string[]} */
  const rechazados = [];
  for (const m of add) {
    const data = contents.get(m.id);
    if (!data) continue;
    if (data.length === m.tamano && (await sha256Hex(data)) === m.sha256) ok.set(m.id, data);
    else rechazados.push(m.nombre);
  }
  return { metas: add, contents: ok, rechazados };
}
