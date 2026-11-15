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
import { appendAuditEntry } from '../core/audit.js';
import { normalizeAttachment } from '../core/attachments.js';
import { normalizeRecord, sortRecords, isValidId } from '../core/record.js';
import { isFutureVersion } from '../core/migrations.js';
import { normalizePatient, patientLabel } from '../core/patient.js';

/**
 * @typedef {{getAll: Function, put: Function, putMany: Function, delete: Function, clear: Function, name: string,
 *   get: Function, keys: Function, binary?: boolean}} Backend
 * @typedef {{id: string, atencionId: string, updated: number, entries: object[]}} AuditDoc
 */

/**
 * @param {Backend} backend
 * @param {{onError?: (e: Error) => void, retries?: number, sleep?: (ms: number) => Promise<void>}} [opts]
 *   `onError`: avisa si falla una escritura en segundo plano (tras los reintentos).
 *   Una escritura fallida NO se da por guardada: queda pendiente y se reintenta
 *   en el próximo `flush`/`retryFailed` (y la interfaz lo llama cada minuto).
 */
export function createRepo(
  backend,
  { onError = (e) => console.error(e), retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  /** @type {Map<string, object>} */
  const records = new Map();
  /** Atenciones de una versión más nueva de la app: se conservan sin tocar. */
  const future = new Map();
  /** @type {Map<string, number>} id -> fecha de eliminación */
  const tombs = new Map();
  /** @type {Map<string, AuditDoc>} */
  const audit = new Map();
  /** Fichas de pacientes (comunes a todas las especialidades). */
  const patients = new Map();
  /** Metadatos de adjuntos (los bytes se leen de a uno: ver loadAttachmentData). */
  const attachments = new Map();
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
  /**
   * Escrituras que fallaron tras los reintentos: clave -> {col, doc} (o {col, id, del}).
   * Se vuelven a intentar en flush()/retryFailed(); mientras tanto los datos
   * siguen en memoria y NO se marcan como guardados.
   */
  const failed = new Map();

  /** Ejecuta `op` con reintentos inmediatos (retroceso corto) ante fallos. */
  const withRetries = async (op) => {
    for (let i = 0; ; i++) {
      try {
        return await op();
      } catch (e) {
        // Sin espacio: reintentar en el acto no sirve; queda pendiente para más tarde.
        if (i >= retries || /** @type {any} */ (e)?.name === 'QuotaExceededError') throw e;
        await sleep(100 * 2 ** i);
      }
    }
  };

  /** Escribe documentos; si falla, los desmarca y los deja pendientes. */
  const write = (col, docs) =>
    run(
      withRetries(() => (docs.length === 1 ? backend.put(col, docs[0]) : backend.putMany(col, docs))).then(
        () => {
          for (const d of docs) failed.delete(keyOf(col, d.id));
        },
        (e) => {
          for (const d of docs) {
            persisted.delete(keyOf(col, d.id));
            failed.set(keyOf(col, d.id), { col, doc: d });
          }
          throw e;
        },
      ),
    );

  const putIfChanged = (col, doc) => {
    if (markChanged(col, doc)) write(col, [doc]);
  };
  /** Escribe en UNA transacción todos los documentos que cambiaron (sincronización, importación). */
  const putManyIfChanged = (col, docs) => {
    const changed = docs.filter((d) => markChanged(col, d));
    if (changed.length) write(col, changed);
  };
  const remove = (col, id) => {
    persisted.delete(keyOf(col, id));
    failed.delete(keyOf(col, id));
    run(
      withRetries(() => backend.delete(col, id)).catch((e) => {
        failed.set(keyOf(col, id), { col, id, del: true });
        throw e;
      }),
    );
  };

  /** Vuelve a intentar las escrituras pendientes (la versión más reciente de cada documento). */
  const retryFailed = () => {
    const items = [...failed.values()];
    failed.clear();
    const byCol = new Map();
    for (const it of items) {
      if (it.del) {
        remove(it.col, it.id);
        continue;
      }
      if (!byCol.has(it.col)) byCol.set(it.col, []);
      byCol.get(it.col).push(it.doc);
    }
    for (const [col, docs] of byCol) {
      for (const d of docs) persisted.set(keyOf(col, d.id), JSON.stringify(d));
      write(col, docs);
    }
    return items.length;
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
      const [recs, dels, docs, pats, atts] = await Promise.all([
        backend.getAll('atenciones'),
        backend.getAll('eliminadas'),
        backend.getAll('bitacora'),
        backend.getAll('pacientes'),
        backend.getAll('adjuntos').catch(() => []),
      ]);
      for (const raw of atts) {
        const a = normalizeAttachment(raw);
        if (!a) continue;
        attachments.set(a.id, a);
        persisted.set(keyOf('adjuntos', a.id), JSON.stringify(a));
      }
      for (const raw of pats) {
        const p = normalizePatient(raw);
        if (!p) continue;
        patients.set(p.id, p);
        persisted.set(keyOf('pacientes', p.id), JSON.stringify(p));
      }
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
    /** Espera las escrituras en curso (reintentando antes las que fallaron). */
    flush: () => {
      retryFailed();
      return Promise.all([...pending].map((x) => x.catch(() => {})));
    },
    retryFailed,
    /** Cuántas escrituras están pendientes por fallos (para avisar al usuario). */
    failedCount: () => failed.size,

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

    /* ----------------------------------------------------------- pacientes */

    /** Fichas de pacientes, ordenadas por nombre. */
    loadPatients: () =>
      [...patients.values()].sort((a, b) => patientLabel(a).localeCompare(patientLabel(b), 'es', { sensitivity: 'base' })),
    getPatient: (id) => patients.get(id),
    upsertPatient(raw) {
      const p = normalizePatient(raw);
      if (!p) return null;
      patients.set(p.id, p);
      putIfChanged('pacientes', p);
      return p;
    },
    /** Reemplaza/agrega fichas (sincronización, migración) en una sola escritura. */
    savePatients(list) {
      const valid = list.map(normalizePatient).filter(Boolean);
      for (const p of valid) patients.set(p.id, p);
      putManyIfChanged('pacientes', valid);
    },

    /* ----------------------------------------------------------- adjuntos */

    /** ¿Este almacenamiento puede guardar archivos? (localStorage no). */
    supportsAttachments: () => backend.binary !== false,
    /** Metadatos de todos los adjuntos, o los de una atención (por fecha de creación). */
    loadAttachments: (atencionId) =>
      [...attachments.values()]
        .filter((a) => !atencionId || a.atencionId === atencionId)
        .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1)),
    getAttachment: (id) => attachments.get(id),
    /** Reemplaza/agrega metadatos (al adjuntar o al recibir de otro equipo). */
    saveAttachments(list) {
      const valid = list.map(normalizeAttachment).filter(Boolean);
      for (const a of valid) attachments.set(a.id, a);
      putManyIfChanged('adjuntos', valid);
      return valid;
    },
    /** Quita los metadatos (la lápida la agrega quien elimina). */
    removeAttachment(id) {
      if (!attachments.delete(id)) return;
      remove('adjuntos', id);
    },
    /** Contenido de un adjunto (o undefined si este equipo aún no lo tiene). */
    async loadAttachmentData(id) {
      const doc = await backend.get('adjuntos_datos', id);
      return doc ? { bytes: /** @type {Uint8Array} */ (doc.bytes) } : undefined;
    },
    /** Guarda el contenido (en una transacción propia; se espera a que quede escrito). */
    async saveAttachmentData(id, bytes) {
      if (backend.binary === false) throw new Error('Este navegador no permite guardar adjuntos (sin IndexedDB).');
      await backend.put('adjuntos_datos', { id, bytes });
    },
    async deleteAttachmentData(id) {
      await backend.delete('adjuntos_datos', id);
    },
    /** Ids de los adjuntos cuyo contenido está en este equipo. */
    attachmentDataIds: async () => /** @type {string[]} */ (await backend.keys('adjuntos_datos')),

    /* ----------------------------------------------------------- bitácora */

    /** Documentos de bitácora (uno por atención). */
    loadAuditDocs: () => [...audit.values()],
    /** Entradas de la bitácora de una atención, de la más reciente a la más antigua. */
    auditFor: (atencionId) => [...(audit.get('b_' + atencionId)?.entries || [])].sort((a, b) => b.at - a.at),
    /** Agrega una entrada a la bitácora de una atención. */
    addAuditEntry(atencionId, entry) {
      const id = 'b_' + atencionId;
      const cur = audit.get(id);
      const doc = { id, atencionId, updated: entry.at, entries: appendAuditEntry(cur?.entries || [], entry) };
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
