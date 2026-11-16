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
import { compareEs } from '../core/format.js';

/** @typedef {import('./backends.js').Backend} Backend */
/** @typedef {import('./backends.js').Documento} Documento */
/** @typedef {import('./backends.js').DocumentoLeido} DocumentoLeido */
/** @typedef {import('../domain').AtencionGuardada} AtencionGuardada */
/** @typedef {import('../domain').AtencionFutura} AtencionFutura */
/** @typedef {import('../domain').Paciente} Paciente */
/** @typedef {import('../domain').Adjunto} Adjunto */
/** @typedef {import('../domain').AuditDoc} AuditDoc */
/** @typedef {import('../domain').AuditEntry} AuditEntry */
/**
 * Atención recibida para guardar (del formulario, de otro equipo, de un respaldo o
 * de versiones anteriores): se valida aquí antes de aceptarla.
 * @typedef {{id?: unknown} | null | undefined} AtencionEntrante
 */
/** Ficha recibida para guardar (sin validar; ver normalizePatient). @typedef {Parameters<typeof normalizePatient>[0]} FichaEntrante */
/**
 * Escritura que falló tras los reintentos: `{col, doc}` (documento por guardar)
 * o `{col, id, del: true}` (documento por borrar).
 * @typedef {{col: string, doc: Documento} | {col: string, id: string, del: true}} EscrituraFallida
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
  /** @type {Map<string, AtencionGuardada>} */
  const records = new Map();
  /** Atenciones de una versión más nueva de la app: se conservan sin tocar. @type {Map<string, AtencionFutura>} */
  const future = new Map();
  /** @type {Map<string, number>} id -> fecha de eliminación */
  const tombs = new Map();
  /** @type {Map<string, AuditDoc>} */
  const audit = new Map();
  /** Fichas de pacientes (comunes a todas las especialidades). @type {Map<string, Paciente>} */
  const patients = new Map();
  /** Fichas ordenadas por nombre (se recalcula solo si cambió alguna). @type {Paciente[] | null} */
  let patientsSorted = null;
  /** Metadatos de adjuntos (los bytes se leen de a uno: ver loadAttachmentData). @type {Map<string, Adjunto>} */
  const attachments = new Map();
  /** Última versión persistida de cada documento (JSON), para escribir solo lo que cambió. @type {Map<string, string>} */
  const persisted = new Map();
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  /** @type {AtencionGuardada[] | null} */
  let sortedCache = null;

  /**
   * Escritura en segundo plano; los errores se informan, nunca se pierden en silencio.
   * @param {Promise<unknown>} p
   */
  const run = (p) => {
    /** @type {Promise<unknown>} */
    const tracked = p.catch(onError).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return tracked;
  };
  /** @param {string} col @param {string} id */
  const keyOf = (col, id) => `${col}:${id}`;
  /**
   * Marca el documento como persistido; devuelve true si cambió respecto de lo guardado.
   * @param {string} col
   * @param {Documento} doc
   */
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
   * @type {Map<string, EscrituraFallida>}
   */
  const failed = new Map();

  /**
   * Ejecuta `op` con reintentos inmediatos (retroceso corto) ante fallos.
   * @template T
   * @param {() => Promise<T>} op
   * @returns {Promise<T>}
   */
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

  /**
   * Escribe documentos; si falla, los desmarca y los deja pendientes.
   * @param {string} col
   * @param {Documento[]} docs
   */
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

  /**
   * @template {Documento} D
   * @param {string} col
   * @param {D} doc
   */
  const putIfChanged = (col, doc) => {
    if (markChanged(col, doc)) write(col, [doc]);
  };
  /**
   * Escribe en UNA transacción todos los documentos que cambiaron (sincronización, importación).
   * @param {string} col
   * @param {Documento[]} docs
   */
  const putManyIfChanged = (col, docs) => {
    const changed = docs.filter((d) => markChanged(col, d));
    if (changed.length) write(col, changed);
  };
  /** @param {string} col @param {string} id */
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
    /** @type {Map<string, Documento[]>} */
    const byCol = new Map();
    for (const it of items) {
      if ('del' in it) {
        remove(it.col, it.id);
        continue;
      }
      const docs = byCol.get(it.col);
      if (docs) docs.push(it.doc);
      else byCol.set(it.col, [it.doc]);
    }
    for (const [col, docs] of byCol) {
      for (const d of docs) persisted.set(keyOf(col, d.id), JSON.stringify(d));
      write(col, docs);
    }
    return items.length;
  };

  /**
   * Guarda una atención en memoria (separando las de versiones futuras).
   * @param {AtencionEntrante} raw
   * @returns {AtencionGuardada | AtencionFutura | null} null si no tiene un id válido
   */
  function setRecord(raw) {
    if (!raw || !isValidId(raw.id)) return null;
    sortedCache = null;
    if (isFutureVersion(raw)) {
      // Se conserva tal cual (con su `v` de una versión más nueva).
      const fut = /** @type {AtencionFutura} */ (raw);
      future.set(raw.id, fut);
      records.delete(raw.id);
      return fut;
    }
    // El id ya es válido y normalizeRecord lo conserva.
    const r = /** @type {AtencionGuardada} */ (normalizeRecord(raw));
    records.set(r.id, r);
    future.delete(r.id);
    return r;
  }

  /**
   * Carga en memoria lo leído del motor y lo marca como ya persistido.
   * @param {{recs: DocumentoLeido[], dels: DocumentoLeido[], docs: DocumentoLeido[], pats: DocumentoLeido[], atts: DocumentoLeido[]}} read
   */
  function hydrate({ recs, dels, docs, pats, atts }) {
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
      patientsSorted = null;
      persisted.set(keyOf('pacientes', p.id), JSON.stringify(p));
    }
    for (const r of recs) {
      const saved = setRecord(r);
      if (saved) persisted.set(keyOf('atenciones', r.id), JSON.stringify(r));
    }
    for (const d of dels) {
      // Las lápidas ({id, t}) solo las escribe este repositorio.
      tombs.set(d.id, /** @type {number} */ (d.t));
      persisted.set(keyOf('eliminadas', d.id), JSON.stringify(d));
    }
    for (const d of docs) {
      // La bitácora solo la escribe este repositorio (addAuditEntry, y saveAuditDocs tras validarla).
      audit.set(d.id, /** @type {AuditDoc} */ (/** @type {unknown} */ (d)));
      persisted.set(keyOf('bitacora', d.id), JSON.stringify(d));
    }
  }

  /**
   * Si hay datos de versiones anteriores (atenciones o eliminaciones) por migrar.
   * @param {{records: object[], tombstones: Record<string, number>}} legacy
   */
  const hasLegacyData = (legacy) => Boolean(legacy.records.length || Object.keys(legacy.tombstones).length);

  /**
   * Migra al motor los datos de versiones anteriores guardados en localStorage.
   * @param {{records: object[], tombstones: Record<string, number>}} legacy
   * @param {(() => void) | undefined} clearLegacy libera el espacio antiguo
   */
  async function migrateLegacy(legacy, clearLegacy) {
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
        backend.getAll('adjuntos').catch(/** @returns {DocumentoLeido[]} */ () => []),
      ]);
      hydrate({ recs, dels, docs, pats, atts });
      const empty = !recs.length && !dels.length;
      if (empty && legacy && hasLegacyData(legacy)) return await migrateLegacy(legacy, clearLegacy);
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
    /** @param {string} id */
    getRecord: (id) => records.get(id),

    /** @param {AtencionEntrante} rec */
    upsertRecord(rec) {
      const saved = setRecord(rec);
      if (saved) putIfChanged('atenciones', saved);
      return repo.loadRecords();
    },

    /** @param {string} id */
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
     * @param {AtencionEntrante[]} list
     */
    saveRecords(list) {
      /** @type {Set<string>} */
      const ids = new Set();
      /** @type {(AtencionGuardada | AtencionFutura)[]} */
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
    /** @param {Record<string, number>} obj id -> fecha de eliminación */
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
    /** @param {string} id @param {number} t */
    addTombstone(id, t) {
      tombs.set(id, t);
      putIfChanged('eliminadas', { id, t });
    },

    /* ----------------------------------------------------------- pacientes */

    /** Fichas de pacientes, ordenadas por nombre (copia: quien la recibe puede ordenarla o filtrarla). */
    loadPatients() {
      if (!patientsSorted) {
        const labeled = [...patients.values()].map((p) => ({ p, k: patientLabel(p) }));
        patientsSorted = labeled.sort((a, b) => compareEs(a.k, b.k)).map((x) => x.p);
      }
      return [...patientsSorted];
    },
    /** @param {string} id */
    getPatient: (id) => patients.get(id),
    /** @param {FichaEntrante} raw */
    upsertPatient(raw) {
      const p = normalizePatient(raw);
      if (!p) return null;
      patients.set(p.id, p);
      patientsSorted = null;
      putIfChanged('pacientes', p);
      return p;
    },
    /**
     * Reemplaza/agrega fichas (sincronización, migración) en una sola escritura.
     * @param {FichaEntrante[]} list
     */
    savePatients(list) {
      // Las fichas no válidas (normalizePatient → null) se descartan.
      const valid = list.map(normalizePatient).filter((p) => p !== null);
      for (const p of valid) patients.set(p.id, p);
      patientsSorted = null;
      putManyIfChanged('pacientes', valid);
    },

    /* ----------------------------------------------------------- adjuntos */

    /** ¿Este almacenamiento puede guardar archivos? (localStorage no). */
    supportsAttachments: () => backend.binary !== false,
    /**
     * Metadatos de todos los adjuntos, o los de una atención (por fecha de creación).
     * @param {string} [atencionId]
     * @returns {Adjunto[]}
     */
    loadAttachments: (atencionId) =>
      [...attachments.values()]
        .filter((a) => !atencionId || a.atencionId === atencionId)
        .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1)),
    /** @param {string} id */
    getAttachment: (id) => attachments.get(id),
    /**
     * Reemplaza/agrega metadatos (al adjuntar o al recibir de otro equipo).
     * @param {unknown[]} list metadatos sin validar (ver normalizeAttachment)
     * @returns {Adjunto[]} los válidos
     */
    saveAttachments(list) {
      const valid = list.map(normalizeAttachment).filter((a) => a !== null);
      for (const a of valid) attachments.set(a.id, a);
      putManyIfChanged('adjuntos', valid);
      return valid;
    },
    /** Quita los metadatos (la lápida la agrega quien elimina). @param {string} id */
    removeAttachment(id) {
      if (!attachments.delete(id)) return;
      remove('adjuntos', id);
    },
    /**
     * Contenido de un adjunto (o undefined si este equipo aún no lo tiene).
     * @param {string} id
     * @returns {Promise<{bytes: Uint8Array} | undefined>}
     */
    async loadAttachmentData(id) {
      const doc = await backend.get('adjuntos_datos', id);
      return doc ? { bytes: /** @type {Uint8Array} */ (doc.bytes) } : undefined;
    },
    /**
     * Guarda el contenido (en una transacción propia; se espera a que quede escrito).
     * @param {string} id
     * @param {Uint8Array} bytes
     */
    async saveAttachmentData(id, bytes) {
      if (backend.binary === false) throw new Error('Este navegador no permite guardar adjuntos (sin IndexedDB).');
      await backend.put('adjuntos_datos', { id, bytes });
    },
    /** @param {string} id */
    async deleteAttachmentData(id) {
      await backend.delete('adjuntos_datos', id);
    },
    /** Ids de los adjuntos cuyo contenido está en este equipo. */
    attachmentDataIds: async () => backend.keys('adjuntos_datos'),

    /* ----------------------------------------------------------- bitácora */

    /** Documentos de bitácora (uno por atención). */
    loadAuditDocs: () => [...audit.values()],
    /**
     * Entradas de la bitácora de una atención, de la más reciente a la más antigua.
     * @param {string} atencionId
     */
    auditFor: (atencionId) => [...(audit.get('b_' + atencionId)?.entries || [])].sort((a, b) => b.at - a.at),
    /**
     * Agrega una entrada a la bitácora de una atención.
     * @param {string} atencionId
     * @param {AuditEntry} entry
     * @returns {AuditDoc}
     */
    addAuditEntry(atencionId, entry) {
      const id = 'b_' + atencionId;
      const cur = audit.get(id);
      const doc = { id, atencionId, updated: entry.at, entries: appendAuditEntry(cur?.entries || [], entry) };
      // Nunca retrocede la versión del documento (p. ej. con el reloj del equipo atrasado).
      if (cur && cur.updated >= doc.updated) doc.updated = cur.updated + 1;
      audit.set(id, doc);
      putIfChanged('bitacora', doc);
      return doc;
    },
    /**
     * Reemplaza/combina documentos de bitácora (sincronización, importación).
     * @param {(Partial<AuditDoc> | null | undefined)[]} docs
     */
    saveAuditDocs(docs) {
      const valid = docs.filter(/** @returns {d is AuditDoc} */ (d) => !!d && isValidId(d.id) && Array.isArray(d.entries));
      for (const d of valid) audit.set(d.id, d);
      putManyIfChanged('bitacora', valid);
    },
  };
  return repo;
}
