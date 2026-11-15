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
 */
export function readLegacyData(storage) {
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
    tombstones: tombstones && typeof tombstones === 'object' && !Array.isArray(tombstones) ? tombstones : {},
  };
}

/** Libera el espacio de los datos antiguos tras migrarlos. */
export function clearLegacyData(storage) {
  storage.removeItem(K.records);
  storage.removeItem(K.tombstones);
}

/**
 * Almacenamiento de la app. Los datos clínicos (atenciones, eliminaciones,
 * bitácora) viven en el repositorio (IndexedDB, ver repo.js); el resto
 * (ajustes, catálogos, borrador, sincronización) en localStorage.
 * @param {KeyValueStorage} storage normalmente window.localStorage
 * @param {ReturnType<import('./repo.js').createRepo>} repo
 */
export function createStore(storage, repo) {
  const read = (key, fallback) => {
    try {
      const v = storage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };
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
    upsertRecord: (r) => repo.upsertRecord(r),
    deleteRecord: (id) => repo.deleteRecord(id),
    saveRecords: (list) => repo.saveRecords(list),
    loadFutureRecords: () => repo.loadFutureRecords(),
    loadTombstones: () => repo.loadTombstones(),
    saveTombstones: (t) => repo.saveTombstones(t),
    addTombstone: (id, t) => repo.addTombstone(id, t),
    auditFor: (id) => repo.auditFor(id),
    addAuditEntry: (id, e) => repo.addAuditEntry(id, e),
    loadAuditDocs: () => repo.loadAuditDocs(),
    saveAuditDocs: (docs) => repo.saveAuditDocs(docs),
    loadPatients: () => repo.loadPatients(),
    getPatient: (id) => repo.getPatient(id),
    upsertPatient: (p) => repo.upsertPatient(p),
    savePatients: (list) => repo.savePatients(list),

    /** Identificador estable de este equipo (para la bitácora). */
    loadDeviceId() {
      let id = read(K.device, null);
      if (typeof id !== 'string' || !/^[a-z0-9]{6,20}$/.test(id)) {
        id = 'pc' + Math.random().toString(36).slice(2, 10);
        write(K.device, id);
      }
      return id;
    },

    loadProcs() {
      const p = read(K.procs, null);
      return Array.isArray(p) && p.length ? p : structuredClone(DEFAULT_PROCS);
    },
    saveProcs(procs) {
      write(K.procs, procs);
    },

    loadDraft() {
      return read(K.draft, null);
    },
    saveDraft(draft) {
      write(K.draft, draft);
    },

    /** Médico y operativo recordados: {n, r, op}. */
    loadMedico() {
      return read(K.medico, {});
    },
    saveMedico(m) {
      write(K.medico, m);
    },

    loadSettings() {
      return { ...DEFAULT_SETTINGS, ...read(K.settings, {}) };
    },
    saveSettings(s) {
      write(K.settings, s);
    },

    /** Clave de seudonimización del equipo (null si aún no existe). */
    loadSecret() {
      const s = read(K.anonSecret, null);
      return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? s : null;
    },
    saveSecret(secret) {
      write(K.anonSecret, secret);
    },

    /** Perfiles de médico (catálogo compartido). */
    loadMedicos() {
      const l = read(K.medicos, []);
      return Array.isArray(l) ? l.map((m) => makeMedico(m)).filter(Boolean) : [];
    },
    saveMedicos(l) {
      write(K.medicos, l);
    },
    /** Perfil que registra en este equipo (el último elegido): id o null. */
    loadUser() {
      const u = read(K.user, null);
      return typeof u?.id === 'string' ? u.id : null;
    },
    saveUser(id) {
      write(K.user, id ? { id } : null);
    },
    /** Pares de fichas marcadas como personas distintas ("idA|idB"). */
    loadNotDuplicates() {
      const l = read(K.notDuplicates, []);
      return new Set(Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []);
    },
    saveNotDuplicates(set) {
      write(K.notDuplicates, [...set]);
    },
    /** Fecha (ms) del último uso / último respaldo descargado en este equipo. */
    loadLastUse: () => Number(read(K.lastUse, 0)) || 0,
    saveLastUse: (t) => write(K.lastUse, t),
    loadLastBackup: () => Number(read(K.lastBackup, 0)) || 0,
    saveLastBackup: (t) => write(K.lastBackup, t),
    /** Bloqueo con PIN (ver core/pin.js). */
    loadLock: () => read(K.lock, null),
    saveLock: (l) => write(K.lock, l),
    loadLockFails: () => {
      const f = read(K.lockFails, null);
      return { fails: Number(f?.fails) || 0, until: Number(f?.until) || 0 };
    },
    saveLockFails: (f) => write(K.lockFails, f),
    /** Registro local de errores (ver core/errlog.js). */
    loadErrors: () => {
      const l = read(K.errors, []);
      return Array.isArray(l) ? l.filter((e) => e && Number.isFinite(e.at) && typeof e.msg === 'string') : [];
    },
    saveErrors: (l) => write(K.errors, l),
    saveLockSignal: (t) => write(K.lockSignal, t),
    /** Clave del aviso entre pestañas (el evento "storage" trae la clave real). */
    lockSignalKey: K.lockSignal,
    loadLockActivity: () => Number(read(K.lockActivity, 0)) || 0,
    saveLockActivity: (t) => write(K.lockActivity, t),
    /** Operativos / rondas (catálogo compartido). */
    loadOperativos() {
      const l = read(K.operativos, []);
      return Array.isArray(l) ? l.map((o) => makeOperativo(o)).filter(Boolean) : [];
    },
    saveOperativos(l) {
      write(K.operativos, l);
    },

    /** Última hora del reloj lógico (ver core/clock.js). */
    loadClock() {
      return Number(read(K.clock, 0)) || 0;
    },
    saveClock(t) {
      write(K.clock, t);
    },

    /** Configuración de sincronización de este equipo, o null si está desactivada. */
    loadSyncConfig() {
      const c = read(K.sync, null);
      return c && typeof c.encKey === 'string' && typeof c.token === 'string' ? c : null;
    },
    saveSyncConfig(c) {
      if (c) write(K.sync, c);
      else storage.removeItem(K.sync);
    },
  };
}
