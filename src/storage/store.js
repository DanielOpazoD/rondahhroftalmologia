/**
 * Persistencia local (localStorage) detrás de una interfaz pequeña.
 *
 * Toda lectura/escritura de datos pasa por aquí: la interfaz no toca
 * localStorage directamente. Recibe el `storage` por parámetro para poder
 * probarlo con un objeto en memoria.
 */
import { STORAGE_KEYS as K, DEFAULT_PROCS, DEFAULT_SETTINGS } from '../config/catalogs.js';
import { normalizeRecord, sortRecords } from '../core/record.js';
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
 * @param {KeyValueStorage} storage normalmente window.localStorage
 */
export function createStore(storage) {
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
    /** Todas las atenciones, normalizadas y ordenadas. */
    loadRecords() {
      const raw = read(K.records, []);
      return Array.isArray(raw) ? sortRecords(raw.map(normalizeRecord).filter((r) => r.id)) : [];
    },
    saveRecords(records) {
      write(K.records, records);
    },
    /** Inserta o reemplaza una atención (por id). Devuelve la lista nueva. */
    upsertRecord(record) {
      const all = this.loadRecords();
      const i = all.findIndex((r) => r.id === record.id);
      if (i >= 0) all[i] = record;
      else all.unshift(record);
      const sorted = sortRecords(all);
      write(K.records, sorted);
      return sorted;
    },
    deleteRecord(id) {
      const all = this.loadRecords().filter((r) => r.id !== id);
      write(K.records, all);
      return all;
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

    /** Atenciones eliminadas (para propagar la eliminación a otros equipos): {id: fecha ms}. */
    loadTombstones() {
      const t = read(K.tombstones, {});
      return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
    },
    saveTombstones(t) {
      write(K.tombstones, t);
    },
    addTombstone(id, at = Date.now()) {
      write(K.tombstones, { ...this.loadTombstones(), [id]: at });
    },

    /** Perfiles de médico (catálogo compartido). */
    loadMedicos() {
      const l = read(K.medicos, []);
      return Array.isArray(l) ? l.map((m) => makeMedico(m)).filter(Boolean) : [];
    },
    saveMedicos(l) {
      write(K.medicos, l);
    },
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
