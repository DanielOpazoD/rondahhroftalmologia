/**
 * Repositorio de datos clínicos: atenciones, eliminaciones y bitácora.
 *
 * - Mantiene todo en memoria (lecturas síncronas, como el resto de la app) y
 *   persiste en segundo plano solo lo que cambió (un documento por atención).
 * - Usa IndexedDB si está disponible; si no, localStorage (ver backends.js).
 * - La primera vez migra los datos guardados por versiones anteriores en
 *   localStorage y libera ese espacio.
 * - Las atenciones de una versión FUTURA de la app se guardan y sincronizan
 *   intactas, pero no se muestran ni se editan (ver core/migrations.js).
 *
 * Los objetos devueltos son de solo lectura: para modificar, copiar y guardar.
 */
import { normalizeRecord, sortRecords, isValidId } from '../core/record.js';
import { isFutureVersion } from '../core/migrations.js';

/**
 * @typedef {{getAll: Function, put: Function, putMany: Function, delete: Function, clear: Function, name: string}} Backend
 * @typedef {{id: string, atencionId: string, updated: number, entries: object[]}} AuditDoc
 */

/**
 * @param {Backend} backend
 * @param {{onError?: (e: Error) => void}} [opts] `onError`: avisa si falla una escritura en segundo plano
 */
export function createRepo(backend, { onError = (e) => console.error(e) } = {}) {
  /** @type {Map<string, object>} */
  const records = new Map();
  /** Atenciones de una versión más nueva de la app: se conservan sin tocar. */
  const future = new Map();
  /** @type {Map<string, number>} id -> fecha de eliminación */
  const tombs = new Map();
  /** @type {Map<string, AuditDoc>} */
  const audit = new Map();
  /** Última versión persistida de cada documento (para escribir solo lo que cambió). */
  const persisted = new Map();
  const pending = new Set();
  let sortedCache = null;

  /** Escritura en segundo plano; los errores se informan, nunca se pierden en silencio. */
  const run = (p) => {
    const tracked = p.catch(onError).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return tracked;
  };
  const keyOf = (col, id) => `${col}:${id}`;
  /** Marca el documento como persistido; devuelve true si cambió respecto de lo guardado. */
  const markChanged = (col, doc) => {
    const json = JSON.stringify(doc);
    if (persisted.get(keyOf(col, doc.id)) === json) return false;
    persisted.set(keyOf(col, doc.id), json);
    return true;
  };
  const putIfChanged = (col, doc) => {
    if (markChanged(col, doc)) run(backend.put(col, doc));
  };
  /** Escribe en UNA transacción todos los documentos que cambiaron (sincronización, importación). */
  const putManyIfChanged = (col, docs) => {
    const changed = docs.filter((d) => markChanged(col, d));
    if (changed.length) run(backend.putMany(col, changed));
  };
  const remove = (col, id) => {
    persisted.delete(keyOf(col, id));
    run(backend.delete(col, id));
  };

  /** Guarda una atención en memoria (separando las de versiones futuras). */
  function setRecord(raw) {
    if (!raw || !isValidId(raw.id)) return null;
    sortedCache = null;
    if (isFutureVersion(raw)) {
      future.set(raw.id, raw);
      records.delete(raw.id);
      return raw;
    }
    const r = normalizeRecord(raw);
    records.set(r.id, r);
    future.delete(r.id);
    return r;
  }

  const repo = {
    backendName: backend.name,

    /**
     * Carga todo desde el motor. Si el motor está vacío y hay datos de
     * versiones anteriores en localStorage, los migra.
     * @param {{legacy?: {records: object[], tombstones: Record<string, number>}, clearLegacy?: () => void}} [migration]
     */
    async init({ legacy, clearLegacy } = {}) {
      const [recs, dels, docs] = await Promise.all([
        backend.getAll('atenciones'),
        backend.getAll('eliminadas'),
        backend.getAll('bitacora'),
      ]);
      for (const r of recs) {
        const saved = setRecord(r);
        if (saved) persisted.set(keyOf('atenciones', r.id), JSON.stringify(r));
      }
      for (const d of dels) {
        tombs.set(d.id, d.t);
        persisted.set(keyOf('eliminadas', d.id), JSON.stringify(d));
      }
      for (const d of docs) {
        audit.set(d.id, d);
        persisted.set(keyOf('bitacora', d.id), JSON.stringify(d));
      }
      const empty = !recs.length && !dels.length;
      if (empty && legacy && (legacy.records.length || Object.keys(legacy.tombstones).length)) {
        for (const r of legacy.records) setRecord(r);
        for (const [id, t] of Object.entries(legacy.tombstones)) tombs.set(id, t);
        await backend.putMany('atenciones', [...records.values(), ...future.values()]);
        await backend.putMany(
          'eliminadas',
          [...tombs].map(([id, t]) => ({ id, t })),
        );
        for (const r of [...records.values(), ...future.values()]) persisted.set(keyOf('atenciones', r.id), JSON.stringify(r));
        for (const [id, t] of tombs) persisted.set(keyOf('eliminadas', id), JSON.stringify({ id, t }));
        // Solo después de escribir y confirmar se libera el espacio antiguo.
        const check = await backend.getAll('atenciones');
        if (check.length >= records.size + future.size) clearLegacy?.();
        return { migrated: legacy.records.length };
      }
      return { migrated: 0 };
    },

    /** Espera a que terminen las escrituras pendientes. */
    flush: () => Promise.all([...pending]),

    /* ---------------------------------------------------------- atenciones */

    /** Atenciones vigentes (versión actual), de la más reciente a la más antigua. */
    loadRecords() {
      return (sortedCache ||= sortRecords([...records.values()]));
    },
    /** Atenciones de versiones futuras (para sincronizarlas sin modificarlas). */
    loadFutureRecords: () => [...future.values()],
    getRecord: (id) => records.get(id),

    upsertRecord(rec) {
      const saved = setRecord(rec);
      if (saved) putIfChanged('atenciones', saved);
      return repo.loadRecords();
    },

    deleteRecord(id) {
      sortedCache = null;
      records.delete(id);
      future.delete(id);
      remove('atenciones', id);
      return repo.loadRecords();
    },

    /**
     * Reemplaza el conjunto completo (sincronización, importación, borrado
     * masivo): escribe solo lo que cambió y elimina lo que ya no está.
     */
    saveRecords(list) {
      const ids = new Set();
      const docs = [];
      for (const raw of list) {
        const saved = setRecord(raw);
        if (!saved) continue;
        ids.add(saved.id);
        docs.push(saved);
      }
      putManyIfChanged('atenciones', docs);
      for (const id of [...records.keys(), ...future.keys()]) {
        if (!ids.has(id)) {
          records.delete(id);
          future.delete(id);
          remove('atenciones', id);
        }
      }
      sortedCache = null;
    },

    /* ----------------------------------------------------- eliminaciones */

    loadTombstones: () => Object.fromEntries(tombs),
    saveTombstones(obj) {
      for (const [id, t] of Object.entries(obj)) tombs.set(id, t);
      putManyIfChanged(
        'eliminadas',
        Object.entries(obj).map(([id, t]) => ({ id, t })),
      );
      for (const id of [...tombs.keys()]) {
        if (!(id in obj)) {
          tombs.delete(id);
          remove('eliminadas', id);
        }
      }
    },
    addTombstone(id, t) {
      tombs.set(id, t);
      putIfChanged('eliminadas', { id, t });
    },

    /* ----------------------------------------------------------- bitácora */

    /** Documentos de bitácora (uno por atención). */
    loadAuditDocs: () => [...audit.values()],
    /** Entradas de la bitácora de una atención, de la más reciente a la más antigua. */
    auditFor: (atencionId) => [...(audit.get('b_' + atencionId)?.entries || [])].sort((a, b) => b.at - a.at),
    /** Agrega una entrada a la bitácora de una atención. */
    addAuditEntry(atencionId, entry) {
      const id = 'b_' + atencionId;
      const cur = audit.get(id);
      const doc = { id, atencionId, updated: entry.at, entries: [...(cur?.entries || []), entry] };
      if (cur?.updated >= doc.updated) doc.updated = cur.updated + 1;
      audit.set(id, doc);
      putIfChanged('bitacora', doc);
      return doc;
    },
    /** Reemplaza/combina documentos de bitácora (sincronización, importación). */
    saveAuditDocs(docs) {
      const valid = docs.filter((d) => d && isValidId(d.id) && Array.isArray(d.entries));
      for (const d of valid) audit.set(d.id, d);
      putManyIfChanged('bitacora', valid);
    },
  };
  return repo;
}
