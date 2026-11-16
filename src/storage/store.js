/**
 * Persistencia local detrás de una interfaz pequeña (localStorage + repositorio IndexedDB).
 *
 * Toda lectura/escritura de datos pasa por aquí: la interfaz no toca
 * localStorage directamente. Recibe el `storage` por parámetro para poder
 * probarlo con un objeto en memoria.
 */
import { STORAGE_KEYS as K, DEFAULT_SETTINGS } from '../config/catalogs.js';
import { DEFAULT_PROCS } from '../specialties/activa/config.js';
import { makeMedico, makeOperativo } from '../core/catalog.js';

export class StorageError extends Error {}

/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} KeyValueStorage */
/** @typedef {ReturnType<typeof import('./repo.js').createRepo>} Repo */
/** @typedef {import('../domain').RegistroFusionable} RegistroFusionable */
/** @typedef {import('../config/catalogs.js').Ajustes} Ajustes */
/** @typedef {import('../specialties/activa/config.js').ProcDef} ProcDef */
/** @typedef {import('../core/catalog.js').Medico} Medico */
/** @typedef {import('../core/catalog.js').Operativo} Operativo */
/** @typedef {import('../core/pin.js').LockConfig} LockConfig */
/** @typedef {import('../core/errlog.js').ErrorEntry} ErrorEntry */
/** @typedef {import('../sync/accountSession.js').CuentaLocal} CuentaLocal */
/**
 * Médico y operativo recordados en este equipo (nombre, RUT, operativo y partes del nombre).
 * @typedef {{n?: string, r?: string, op?: string, apellido_paterno?: string, apellido_materno?: string, nombres?: string}} MedicoRecordado
 */
/** Evento del registro de accesos pendiente de enviar (ver sync/accountSession.js). @typedef {{ev: string, obj?: string, n?: number, at: number, off?: boolean}} EventoPendiente */
/**
 * Configuración de sincronización de este equipo (la escribe ui/syncController.js al activarla).
 * @typedef {{encKey: string, token: string, hash: string, activatedAt: number, lastSync: number | null}} SyncConfig
 */

/**
 * Almacenamiento en memoria con la misma interfaz que localStorage (tests / fallback).
 * @returns {KeyValueStorage}
 */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

/**
 * Lee los datos clínicos que versiones anteriores guardaban en localStorage
 * (para migrarlos a IndexedDB). Registros sin id válido se descartan.
 * @param {KeyValueStorage} storage
 * @returns {{records: object[], tombstones: Record<string, number>}}
 */
export function readLegacyData(storage) {
  /**
   * @param {string} k
   * @param {unknown} fb
   * @returns {unknown} JSON sin validar (se valida abajo)
   */
  const parse = (k, fb) => {
    try {
      const v = JSON.parse(storage.getItem(k) || 'null');
      return v ?? fb;
    } catch {
      return fb;
    }
  };
  const records = parse(K.records, []);
  const tombstones = parse(K.tombstones, {});
  return {
    records: Array.isArray(records) ? records.filter((r) => r && typeof r === 'object' && r.id) : [],
    tombstones:
      tombstones && typeof tombstones === 'object' && !Array.isArray(tombstones) ? /** @type {Record<string, number>} */ (tombstones) : {},
  };
}

/** Libera el espacio de los datos antiguos tras migrarlos. @param {KeyValueStorage} storage */
export function clearLegacyData(storage) {
  storage.removeItem(K.records);
  storage.removeItem(K.tombstones);
}

/**
 * Almacenamiento de la app. Los datos clínicos (atenciones, eliminaciones,
 * bitácora) viven en el repositorio (IndexedDB, ver repo.js); el resto
 * (ajustes, catálogos, borrador, sincronización) en localStorage.
 * @param {KeyValueStorage} storage normalmente window.localStorage
 * @param {Repo} repo
 */
export function createStore(storage, repo) {
  /**
   * Valor JSON guardado bajo `key`, o `fallback` si no está o no se puede leer.
   * Sin validar: cada lector lo valida o declara qué espera (lo escribió su `save…`).
   * @param {string} key
   * @param {unknown} fallback
   * @returns {unknown}
   */
  const read = (key, fallback) => {
    try {
      const v = storage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };
  /**
   * @param {string} key
   * @param {unknown} value
   */
  const write = (key, value) => {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      throw new StorageError('No se pudo guardar en este navegador (¿almacenamiento lleno o modo privado?)', { cause: e });
    }
  };

  return {
    /* Datos clínicos: repositorio */
    repo,
    loadRecords: () => repo.loadRecords(),
    /** @type {Repo['upsertRecord']} */
    upsertRecord: (r) => repo.upsertRecord(r),
    /** @type {Repo['deleteRecord']} */
    deleteRecord: (id) => repo.deleteRecord(id),
    /** @type {Repo['saveRecords']} */
    saveRecords: (list) => repo.saveRecords(list),
    loadFutureRecords: () => repo.loadFutureRecords(),
    loadTombstones: () => repo.loadTombstones(),
    /** @type {Repo['saveTombstones']} */
    saveTombstones: (t) => repo.saveTombstones(t),
    /** @type {Repo['addTombstone']} */
    addTombstone: (id, t) => repo.addTombstone(id, t),
    /** @type {Repo['auditFor']} */
    auditFor: (id) => repo.auditFor(id),
    /** @type {Repo['addAuditEntry']} */
    addAuditEntry: (id, e) => repo.addAuditEntry(id, e),
    loadAuditDocs: () => repo.loadAuditDocs(),
    /** @type {Repo['saveAuditDocs']} */
    saveAuditDocs: (docs) => repo.saveAuditDocs(docs),
    supportsAttachments: () => repo.supportsAttachments(),
    /** @type {Repo['loadAttachments']} */
    loadAttachments: (atencionId) => repo.loadAttachments(atencionId),
    /** @type {Repo['getAttachment']} */
    getAttachment: (id) => repo.getAttachment(id),
    /** @type {Repo['saveAttachments']} */
    saveAttachments: (list) => repo.saveAttachments(list),
    /** @type {Repo['removeAttachment']} */
    removeAttachment: (id) => repo.removeAttachment(id),
    /** @type {Repo['loadAttachmentData']} */
    loadAttachmentData: (id) => repo.loadAttachmentData(id),
    /** @type {Repo['saveAttachmentData']} */
    saveAttachmentData: (id, bytes) => repo.saveAttachmentData(id, bytes),
    /** Adjuntos cuyo contenido ya está confirmado en el servidor (ids). @returns {Set<string>} */
    loadAttachmentsUploaded: () => {
      const l = read(K.attachmentsUploaded, []);
      return new Set(Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []);
    },
    /** @param {Set<string>} set */
    saveAttachmentsUploaded: (set) => write(K.attachmentsUploaded, [...set]),
    /** @type {Repo['deleteAttachmentData']} */
    deleteAttachmentData: (id) => repo.deleteAttachmentData(id),
    attachmentDataIds: () => repo.attachmentDataIds(),
    /** Ids de adjuntos eliminados cuyo contenido aún hay que borrar del servidor. */
    /** @returns {string[]} */
    loadAttachmentPurges: () => {
      const l = read(K.attachmentPurges, []);
      return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : [];
    },
    /** @param {string[]} l */
    saveAttachmentPurges: (l) => write(K.attachmentPurges, l),
    loadPatients: () => repo.loadPatients(),
    /** @type {Repo['getPatient']} */
    getPatient: (id) => repo.getPatient(id),
    /** @type {Repo['upsertPatient']} */
    upsertPatient: (p) => repo.upsertPatient(p),
    /** @type {Repo['savePatients']} */
    savePatients: (list) => repo.savePatients(list),

    /** Identificador estable de este equipo (para la bitácora). */
    loadDeviceId() {
      const saved = read(K.device, null);
      if (typeof saved === 'string' && /^[a-z0-9]{6,20}$/.test(saved)) return saved;
      const id = 'pc' + Math.random().toString(36).slice(2, 10);
      write(K.device, id);
      return id;
    },

    /** @returns {ProcDef[]} */
    loadProcs() {
      const p = read(K.procs, null);
      if (!Array.isArray(p) || !p.length) return structuredClone(DEFAULT_PROCS);
      /** @type {ProcDef[]} lo escribió saveProcs */
      const saved = p;
      // Opciones agregadas en versiones nuevas (p. ej. descripción del FO y la BMC):
      // los procedimientos de la lista por defecto las toman si aún no las tienen.
      return saved.map((x) => {
        const d = DEFAULT_PROCS.find((y) => y.id === x?.id);
        if (!d) return x;
        return {
          ...x,
          ...(x.desc === undefined && d.desc ? { desc: d.desc } : {}),
          ...(x.abrev === undefined && d.abrev ? { abrev: d.abrev } : {}),
        };
      });
    },
    /** @param {ProcDef[]} procs */
    saveProcs(procs) {
      write(K.procs, procs);
    },

    /** Atención a medio llenar que quedó al cerrar (la valida normalizeRecord al restaurarla). */
    loadDraft() {
      return /** @type {RegistroFusionable | null} */ (read(K.draft, null));
    },
    /** @param {RegistroFusionable} draft */
    saveDraft(draft) {
      write(K.draft, draft);
    },

    /** Médico y operativo recordados: {n, r, op}. */
    loadMedico() {
      return /** @type {MedicoRecordado} */ (read(K.medico, {}));
    },
    /** @param {MedicoRecordado} m */
    saveMedico(m) {
      write(K.medico, m);
    },

    /** @returns {Ajustes} */
    loadSettings() {
      return { ...DEFAULT_SETTINGS, .../** @type {Partial<Ajustes>} */ (read(K.settings, {})) };
    },
    /** @param {Ajustes} s */
    saveSettings(s) {
      write(K.settings, s);
    },

    /** Clave de seudonimización del equipo (null si aún no existe). */
    loadSecret() {
      const s = read(K.anonSecret, null);
      return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? s : null;
    },
    /** @param {string} secret */
    saveSecret(secret) {
      write(K.anonSecret, secret);
    },

    /** Perfiles de médico (catálogo compartido). */
    /** @returns {Medico[]} */
    loadMedicos() {
      const l = read(K.medicos, []);
      return Array.isArray(l) ? l.map((m) => makeMedico(m)).filter((m) => m !== null) : [];
    },
    /** @param {{id: string}[]} l perfiles (se normalizan al leerlos) */
    saveMedicos(l) {
      write(K.medicos, l);
    },
    /** Perfil que registra en este equipo (el último elegido): id o null. */
    loadUser() {
      const u = /** @type {{id?: unknown} | null} */ (read(K.user, null));
      return typeof u?.id === 'string' ? u.id : null;
    },
    /** @param {string | null} id */
    saveUser(id) {
      write(K.user, id ? { id } : null);
    },
    /** Pares de fichas marcadas como personas distintas ("idA|idB"). */
    /** @returns {Set<string>} */
    loadNotDuplicates() {
      const l = read(K.notDuplicates, []);
      return new Set(Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []);
    },
    /** @param {Set<string>} set */
    saveNotDuplicates(set) {
      write(K.notDuplicates, [...set]);
    },
    /** Fecha (ms) del último uso / último respaldo descargado en este equipo. */
    loadLastUse: () => Number(read(K.lastUse, 0)) || 0,
    /** @param {number} t */
    saveLastUse: (t) => write(K.lastUse, t),
    loadLastBackup: () => Number(read(K.lastBackup, 0)) || 0,
    /** @param {number} t */
    saveLastBackup: (t) => write(K.lastBackup, t),
    /** Bloqueo con PIN (ver core/pin.js). Puede venir alterado: quien lo usa lo valida con isLockConfig. */
    loadLock: () => /** @type {LockConfig | null} */ (read(K.lock, null)),
    /** @param {LockConfig | null} l */
    saveLock: (l) => write(K.lock, l),
    loadLockFails: () => {
      const f = /** @type {{fails?: unknown, until?: unknown} | null} */ (read(K.lockFails, null));
      return { fails: Number(f?.fails) || 0, until: Number(f?.until) || 0 };
    },
    /** @param {{fails: number, until: number}} f */
    saveLockFails: (f) => write(K.lockFails, f),
    /** Registro local de errores (ver core/errlog.js). @returns {ErrorEntry[]} */
    loadErrors: () => {
      const l = read(K.errors, []);
      return Array.isArray(l) ? l.filter((e) => e && Number.isFinite(e.at) && typeof e.msg === 'string') : [];
    },
    /** @param {ErrorEntry[]} l */
    saveErrors: (l) => write(K.errors, l),
    /** @param {number} t */
    saveLockSignal: (t) => write(K.lockSignal, t),
    /** Clave del aviso entre pestañas (el evento "storage" trae la clave real). */
    lockSignalKey: K.lockSignal,
    loadLockActivity: () => Number(read(K.lockActivity, 0)) || 0,
    /** @param {number} t */
    saveLockActivity: (t) => write(K.lockActivity, t),
    /** Operativos / rondas (catálogo compartido). @returns {Operativo[]} */
    loadOperativos() {
      const l = read(K.operativos, []);
      return Array.isArray(l) ? l.map((o) => makeOperativo(o)).filter((o) => o !== null) : [];
    },
    /** @param {{id: string}[]} l operativos (se normalizan al leerlos) */
    saveOperativos(l) {
      write(K.operativos, l);
    },

    /** Última hora del reloj lógico (ver core/clock.js). */
    loadClock() {
      return Number(read(K.clock, 0)) || 0;
    },
    /** @param {number} t */
    saveClock(t) {
      write(K.clock, t);
    },

    /** Configuración de sincronización de este equipo, o null si está desactivada. */
    /* ------------------------------------------------ cuentas (ADR 0014) */
    loadAccountsOn: () => read(K.accountsOn, false) === true,
    /** @param {boolean} on */
    saveAccountsOn: (on) => write(K.accountsOn, Boolean(on)),
    /**
     * Cuentas que entraron en este PC: {[uid]: {uid, rut, sal, iter, localHash, nombre, rol, admin}}.
     * @returns {Record<string, CuentaLocal>}
     */
    loadLocalAccounts() {
      const m = read(K.localAccounts, {});
      return m && typeof m === 'object' && !Array.isArray(m) ? /** @type {Record<string, CuentaLocal>} */ (m) : {};
    },
    /** @param {Record<string, CuentaLocal>} m */
    saveLocalAccounts: (m) => write(K.localAccounts, m),
    /** @returns {EventoPendiente[]} */
    loadAccountEvents() {
      const l = read(K.accountEvents, []);
      return Array.isArray(l) ? l : [];
    },
    /** @param {EventoPendiente[]} l */
    saveAccountEvents: (l) => write(K.accountEvents, l.slice(-500)),
    loadSessionLockMinutes() {
      const m = Number(read(K.sessionLock, 15));
      return [5, 10, 15, 30, 60].includes(m) ? m : 15;
    },
    /** @param {number} m */
    saveSessionLockMinutes: (m) => write(K.sessionLock, m),

    /** @returns {SyncConfig | null} */
    loadSyncConfig() {
      const c = /** @type {Partial<SyncConfig> | null} */ (read(K.sync, null));
      return c && typeof c.encKey === 'string' && typeof c.token === 'string' ? /** @type {SyncConfig} */ (c) : null;
    },
    /** @param {SyncConfig | null} c */
    saveSyncConfig(c) {
      if (c) write(K.sync, c);
      else storage.removeItem(K.sync);
    },
  };
}
