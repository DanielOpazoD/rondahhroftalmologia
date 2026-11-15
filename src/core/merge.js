/**
 * Fusión campo a campo de una misma atención editada en varios equipos.
 *
 * Cada atención guarda `ft`: la fecha (ms) en que se editó cada campo, por
 * ejemplo { "f.od_pio": 1763150000000, "checks.diagnostico_glaucoma": … }.
 * Al juntar dos versiones de la misma atención, cada campo toma el valor de
 * la versión que lo editó más recientemente. Así, si un profesional anota la
 * PIO y otro un diagnóstico, se conservan ambos; solo si los dos editan el
 * MISMO campo gana la edición más reciente.
 *
 * Granularidad: cada texto (`f.*`), cada casilla (`checks.*`), la lateralidad
 * de catarata (`cat`) y, por procedimiento, el ojo y cada PIO
 * (`proc.<id>.eye`, `proc.<id>.od`, `proc.<id>.oi`).
 *
 * La fusión es determinista, conmutativa e idempotente: todos los equipos
 * llegan al mismo resultado sin importar el orden en que reciben los cambios.
 * Registros antiguos sin `ft` usan su `updated` para todos sus campos.
 */
import { normalizeRecord } from './record.js';
import { MEDIDAS_PROC } from '../specialties/activa/config.js';
import { isFutureVersion } from './migrations.js';
import { mergeAuditDocs } from './audit.js';

/** @typedef {import('../domain').RegistroFusionable} RegistroFusionable */
/** Valor de una ruta: texto, o `true` para una casilla marcada. @typedef {string | true} ValorRuta */

/** Partes de un procedimiento realizado: el lado (`eye`) y las medidas por lado de la especialidad. */
const PROC_KEYS = ['eye', ...MEDIDAS_PROC];

/**
 * Claves aceptadas para campos, casillas e ids de procedimiento. Los datos
 * pueden venir de otros equipos o de respaldos: se rechazan claves como
 * `__proto__`/`constructor`/`prototype` (contaminación de prototipos).
 */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
/** @type {(k: unknown) => k is string} */
export const isSafeKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k) && !FORBIDDEN.has(k);

/**
 * Valores presentes de la atención como mapa ruta -> valor (vacíos y `false` se omiten).
 * @param {RegistroFusionable | null | undefined} rec
 * @returns {Map<string, ValorRuta>}
 */
export function flatten(rec) {
  /** @type {Map<string, ValorRuta>} */
  const m = new Map();
  for (const [k, v] of Object.entries(rec?.f || {})) {
    if (isSafeKey(k) && v !== undefined && v !== null && v !== '') m.set('f.' + k, String(v));
  }
  for (const [k, v] of Object.entries(rec?.checks || {})) if (isSafeKey(k) && v) m.set('checks.' + k, true);
  if (rec?.cat) m.set('cat', String(rec.cat));
  if (rec?.pacienteId) m.set('pacienteId', String(rec.pacienteId));
  // Cada procedimiento se recorre por partes (`eye` y las medidas de la especialidad).
  for (const [id, p] of /** @type {[string, Record<string, unknown>][]} */ (Object.entries(rec?.proc || {}))) {
    if (!isSafeKey(id) || !p || typeof p !== 'object') continue;
    for (const k of PROC_KEYS) if (p[k] !== undefined && p[k] !== null && p[k] !== '') m.set(`proc.${id}.${k}`, String(p[k]));
  }
  return m;
}

/**
 * Reconstruye f / checks / cat / proc desde un mapa ruta -> valor.
 * @param {Map<string, ValorRuta>} m
 */
export function unflatten(m) {
  /** @type {{f: Record<string, string>, checks: Record<string, boolean>, cat: string, pacienteId?: string, proc: Record<string, import('../domain').ProcRealizado>}} */
  const out = { f: {}, checks: {}, cat: '', proc: {} };
  for (const [path, v] of m) {
    if (path.startsWith('f.')) {
      const k = path.slice(2);
      if (isSafeKey(k)) out.f[k] = /** @type {string} */ (v);
    } else if (path.startsWith('checks.')) {
      const k = path.slice(7);
      if (isSafeKey(k)) out.checks[k] = true;
    } else if (path === 'cat') out.cat = /** @type {string} */ (v);
    else if (path === 'pacienteId') out.pacienteId = /** @type {string} */ (v);
    else if (path.startsWith('proc.')) {
      const rest = path.slice(5);
      const dot = rest.lastIndexOf('.');
      const id = rest.slice(0, dot);
      const key = rest.slice(dot + 1);
      if (!isSafeKey(id) || !PROC_KEYS.includes(key)) continue;
      // Se arma por partes: el que quede sin `eye` se descarta abajo.
      if (!Object.hasOwn(out.proc, id)) out.proc[id] = /** @type {import('../domain').ProcRealizado} */ ({});
      /** @type {Record<string, string>} */ (out.proc[id])[key] = /** @type {string} */ (v);
    }
  }
  // Un procedimiento sin ojo no existe (p. ej. se quitó el ojo pero quedó una PIO).
  for (const [id, p] of Object.entries(out.proc)) if (!p.eye) delete out.proc[id];
  return out;
}

/**
 * Rutas cuyo valor cambió entre dos versiones.
 * @param {RegistroFusionable | null | undefined} before
 * @param {RegistroFusionable | null | undefined} after
 */
export function changedPaths(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  /** @type {string[]} */
  const out = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) if (a.get(p) !== b.get(p)) out.push(p);
  return out;
}

/**
 * Fecha de edición de un campo (registros sin `ft`: su `updated`).
 * @param {RegistroFusionable | null | undefined} rec
 * @param {string} path
 * @returns {number}
 */
export function ftOf(rec, path) {
  return rec?.ft ? rec.ft[path] || 0 : rec?.updated || 0;
}

/**
 * Marca como editados ahora los campos que cambiaron respecto de `before`.
 * Modifica y devuelve `rec`.
 * @template {RegistroFusionable} T
 * @param {T} rec
 * @param {RegistroFusionable | null | undefined} before
 * @returns {T}
 */
export function stampChanges(rec, before, now = Date.now()) {
  const paths = changedPaths(before, rec);
  if (!paths.length) return rec;
  ensureFt(rec);
  for (const p of paths) rec.ft[p] = now;
  return rec;
}

/**
 * Da `ft` a un registro antiguo: todos sus campos con su fecha `updated`.
 * @template {RegistroFusionable} T
 * @param {T} rec
 * @returns {T}
 */
export function ensureFt(rec) {
  if (rec.ft) return rec;
  const t = rec.updated || 0;
  rec.ft = {};
  if (t) for (const p of flatten(rec).keys()) rec.ft[p] = t;
  return rec;
}

/** Compara valores de forma determinista (para desempates). */
/** @param {unknown} v */
const rank = (v) => (v === undefined ? '' : JSON.stringify(v));

/**
 * Fusiona dos versiones de la MISMA atención (mismo id, o una atención nueva
 * que se combina con una existente). Devuelve un registro nuevo.
 * @param {RegistroFusionable} a
 * @param {RegistroFusionable} b
 * @returns {RegistroFusionable}
 */
export function mergeRecords(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const paths = new Set([...fa.keys(), ...fb.keys(), ...Object.keys(a.ft || {}), ...Object.keys(b.ft || {})]);
  const ft = Object.create(null);
  const values = new Map();
  for (const p of paths) {
    const ta = ftOf(a, p);
    const tb = ftOf(b, p);
    const va = fa.get(p);
    const vb = fb.get(p);
    const useA = ta !== tb ? ta > tb : rank(va) >= rank(vb);
    const v = useA ? va : vb;
    if (v !== undefined) values.set(p, v);
    const t = Math.max(ta, tb);
    if (t) ft[p] = t;
  }
  const merged = unflatten(values);
  const created = [a.created, b.created].filter(Boolean);
  return {
    ...b,
    ...a,
    ...merged,
    id: a.id || b.id,
    created: created.length ? Math.min(...created) : undefined,
    updated: Math.max(a.updated || 0, b.updated || 0),
    procNames: Object.fromEntries(Object.entries({ ...(b.procNames || {}), ...(a.procNames || {}) }).filter(([k]) => isSafeKey(k))),
    ft: { ...ft },
  };
}

/**
 * ¿Tienen los mismos datos (sin mirar fechas)?
 * @param {RegistroFusionable | null | undefined} a
 * @param {RegistroFusionable | null | undefined} b
 */
export function sameContent(a, b) {
  return changedPaths(a, b).length === 0;
}

/**
 * Función de fusión para la sincronización (ver sync/protocol.js, MergeFn):
 * las atenciones se fusionan campo a campo; médicos y operativos, la versión más nueva.
 * Los datos llegan descifrados de otro equipo (forma no verificada): cada rama
 * los trata según su tipo.
 * @type {import('../sync/protocol.js').MergeFn}
 */
export function syncMerge(kind, local, remote) {
  if (kind === 'bitacora') {
    const data = mergeAuditDocs(local, remote);
    return { data, sameAsRemote: data.entries.length === /** @type {unknown[]} */ (remote.entries || []).length };
  }
  if (kind === 'paciente') {
    const data = mergeRecords(/** @type {RegistroFusionable} */ (local), /** @type {RegistroFusionable} */ (remote));
    return { data, sameAsRemote: sameContent(data, /** @type {RegistroFusionable} */ (remote)) };
  }
  if (kind !== 'atencion') return null;
  // Una versión más nueva de la app no se fusiona con lógica antigua: gana entera la más nueva.
  if (isFutureVersion(local) || isFutureVersion(remote)) return null;
  const data = mergeRecords(normalizeRecord(local), normalizeRecord(remote));
  return { data, sameAsRemote: sameContent(data, /** @type {RegistroFusionable} */ (remote)) };
}

/**
 * Representación canónica del CONTENIDO de un elemento sincronizado (sin
 * fechas de edición): dos versiones con igual huella tienen los mismos datos.
 * La sincronización la usa para detectar versiones con el mismo número pero
 * distinto contenido (dos equipos que fusionaron a la vez).
 * @param {string} kind
 * @param {Record<string, unknown>} data datos descifrados del elemento (forma según `kind`)
 */
export function syncFingerprint(kind, data) {
  if (kind === 'atencion' || kind === 'paciente') {
    return JSON.stringify([...flatten(/** @type {RegistroFusionable} */ (data))].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  }
  if (kind === 'medico') return JSON.stringify([data?.nombre || '', data?.rut || '']);
  if (kind === 'operativo') return JSON.stringify([data?.nombre || '']);
  if (kind === 'bitacora') return JSON.stringify(/** @type {{id: string}[]} */ (data?.entries || []).map((e) => e.id).sort());
  return JSON.stringify(data ?? null);
}
