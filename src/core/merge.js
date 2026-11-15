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

const PROC_KEYS = ['eye', 'od', 'oi'];

/** Valores presentes de la atención como mapa ruta -> valor (vacíos y `false` se omiten). */
export function flatten(rec) {
  const m = new Map();
  for (const [k, v] of Object.entries(rec?.f || {})) if (v !== undefined && v !== null && v !== '') m.set('f.' + k, String(v));
  for (const [k, v] of Object.entries(rec?.checks || {})) if (v) m.set('checks.' + k, true);
  if (rec?.cat) m.set('cat', rec.cat);
  for (const [id, p] of Object.entries(rec?.proc || {})) {
    for (const k of PROC_KEYS) if (p && p[k] !== undefined && p[k] !== null && p[k] !== '') m.set(`proc.${id}.${k}`, String(p[k]));
  }
  return m;
}

/** Reconstruye f / checks / cat / proc desde un mapa ruta -> valor. */
export function unflatten(m) {
  const out = { f: {}, checks: {}, cat: '', proc: {} };
  for (const [path, v] of m) {
    if (path.startsWith('f.')) out.f[path.slice(2)] = v;
    else if (path.startsWith('checks.')) out.checks[path.slice(7)] = true;
    else if (path === 'cat') out.cat = v;
    else if (path.startsWith('proc.')) {
      const rest = path.slice(5);
      const dot = rest.lastIndexOf('.');
      const id = rest.slice(0, dot);
      (out.proc[id] ||= {})[rest.slice(dot + 1)] = v;
    }
  }
  // Un procedimiento sin ojo no existe (p. ej. se quitó el ojo pero quedó una PIO).
  for (const [id, p] of Object.entries(out.proc)) if (!p.eye) delete out.proc[id];
  return out;
}

/** Rutas cuyo valor cambió entre dos versiones. */
export function changedPaths(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const out = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) if (a.get(p) !== b.get(p)) out.push(p);
  return out;
}

/** Fecha de edición de un campo (registros sin `ft`: su `updated`). */
export function ftOf(rec, path) {
  return rec?.ft ? rec.ft[path] || 0 : rec?.updated || 0;
}

/**
 * Marca como editados ahora los campos que cambiaron respecto de `before`.
 * Modifica y devuelve `rec`.
 */
export function stampChanges(rec, before, now = Date.now()) {
  const paths = changedPaths(before, rec);
  if (!paths.length) return rec;
  ensureFt(rec);
  for (const p of paths) rec.ft[p] = now;
  return rec;
}

/** Da `ft` a un registro antiguo: todos sus campos con su fecha `updated`. */
export function ensureFt(rec) {
  if (rec.ft) return rec;
  const t = rec.updated || 0;
  rec.ft = {};
  if (t) for (const p of flatten(rec).keys()) rec.ft[p] = t;
  return rec;
}

/** Compara valores de forma determinista (para desempates). */
const rank = (v) => (v === undefined ? '' : JSON.stringify(v));

/**
 * Fusiona dos versiones de la MISMA atención (mismo id, o una atención nueva
 * que se combina con una existente). Devuelve un registro nuevo.
 */
export function mergeRecords(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const paths = new Set([...fa.keys(), ...fb.keys(), ...Object.keys(a.ft || {}), ...Object.keys(b.ft || {})]);
  const values = new Map();
  const ft = {};
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
    procNames: { ...(b.procNames || {}), ...(a.procNames || {}) },
    ft,
  };
}

/** ¿Tienen los mismos datos (sin mirar fechas)? */
export function sameContent(a, b) {
  return changedPaths(a, b).length === 0;
}

/**
 * Función de fusión para la sincronización (ver sync/protocol.js, MergeFn):
 * las atenciones se fusionan campo a campo; médicos y operativos, la versión más nueva.
 */
export function syncMerge(kind, local, remote) {
  if (kind !== 'atencion') return null;
  const data = mergeRecords(local, remote);
  return { data, sameAsRemote: sameContent(data, remote) };
}
