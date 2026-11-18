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
import { refreshNames } from './names.js';
import { normalizeRecord } from './record.js';
import { flatten, unflatten, isSafeKey } from './fields.js';
import { isFutureVersion } from './migrations.js';
import { mergeAuditDocs } from './audit.js';
import { MAX_AHEAD_MS } from './clock.js';

/** @typedef {import('../domain').RegistroFusionable} RegistroFusionable */

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
  const { ft } = ensureFt(rec);
  for (const p of paths) ft[p] = now;
  return rec;
}

/**
 * Da `ft` a un registro antiguo: todos sus campos con su fecha `updated`.
 * Modifica y devuelve `rec`, ya con `ft` garantizado.
 * @template {RegistroFusionable} T
 * @param {T} rec
 * @returns {T & {ft: import('../domain').FechasPorCampo}}
 */
export function ensureFt(rec) {
  const ft = rec.ft ?? {};
  if (!rec.ft) {
    const t = rec.updated || 0;
    if (t) for (const p of flatten(rec).keys()) ft[p] = t;
  }
  return Object.assign(rec, { ft });
}

/** Compara valores de forma determinista (para desempates). */
/** @param {unknown} v */
const rank = (v) => (v === undefined ? '' : JSON.stringify(v));

/**
 * Fusión campo a campo: en cada ruta gana el valor editado más recientemente
 * (a igual fecha, desempate determinista por valor). Una fecha más allá de
 * `maxT` cuenta como `maxT`: un campo fechado en 2099 (reloj malo o dato
 * manipulado) no puede ganar para siempre.
 * @param {RegistroFusionable} a
 * @param {RegistroFusionable} b
 * @param {number} maxT
 * @returns {{values: Map<string, import('./fields.js').ValorRuta>, ft: Record<string, number>}}
 *   `values`: ruta -> valor ganador; `ft`: ruta -> fecha más reciente
 */
function mergeFields(a, b, maxT) {
  const fa = flatten(a);
  const fb = flatten(b);
  const paths = new Set([...fa.keys(), ...fb.keys(), ...Object.keys(a.ft || {}), ...Object.keys(b.ft || {})]);
  const ft = Object.create(null);
  const values = new Map();
  for (const p of paths) {
    const ta = Math.min(ftOf(a, p), maxT);
    const tb = Math.min(ftOf(b, p), maxT);
    const va = fa.get(p);
    const vb = fb.get(p);
    const useA = ta !== tb ? ta > tb : rank(va) >= rank(vb);
    const v = useA ? va : vb;
    if (v !== undefined) values.set(p, v);
    const t = Math.max(ta, tb);
    if (t) ft[p] = t;
  }
  return { values, ft };
}

/**
 * Fusiona dos versiones de la MISMA atención (mismo id, o una atención nueva
 * que se combina con una existente). Devuelve un registro nuevo.
 * @param {RegistroFusionable} a
 * @param {RegistroFusionable} b
 * @param {{maxT?: number}} [o] fecha máxima creíble de una edición (por defecto,
 *   el mismo margen que acepta el reloj lógico: MAX_AHEAD_MS por delante de ahora)
 * @returns {RegistroFusionable}
 */
export function mergeRecords(a, b, { maxT = Date.now() + MAX_AHEAD_MS } = {}) {
  const { values, ft } = mergeFields(a, b, maxT);
  const merged = unflatten(values);
  refreshNames(merged.f);
  const created = [a.created, b.created].flatMap((t) => (t ? [t] : []));
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

/** @param {[string, unknown]} a @param {[string, unknown]} b */
const byPath = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Qué cuenta como contenido en cada tipo de elemento (ver syncFingerprint).
 * @type {Record<string, (data: Record<string, unknown>) => unknown>}
 */
const CONTENT_OF = {
  atencion: (data) => [...flatten(/** @type {RegistroFusionable} */ (data))].sort(byPath),
  paciente: (data) => [...flatten(/** @type {RegistroFusionable} */ (data))].sort(byPath),
  medico: (data) => [
    data?.nombre || '',
    data?.rut || '',
    data?.apellido_paterno ?? null,
    data?.apellido_materno ?? null,
    data?.nombres ?? null,
  ],
  operativo: (data) => [data?.nombre || ''],
  bitacora: (data) => /** @type {{id: string}[]} */ (data?.entries || []).map((e) => e.id).sort(),
};

/**
 * Representación canónica del CONTENIDO de un elemento sincronizado (sin
 * fechas de edición): dos versiones con igual huella tienen los mismos datos.
 * La sincronización la usa para detectar versiones con el mismo número pero
 * distinto contenido (dos equipos que fusionaron a la vez).
 * @param {string} kind
 * @param {Record<string, unknown>} data datos descifrados del elemento (forma según `kind`)
 */
export function syncFingerprint(kind, data) {
  return JSON.stringify(Object.hasOwn(CONTENT_OF, kind) ? CONTENT_OF[kind](data) : (data ?? null));
}
