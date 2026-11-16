/**
 * Modo práctica: la misma app con datos de EJEMPLO, para capacitar sin tocar
 * los datos reales.
 *
 * - Se abre con `?practica` en la dirección (Ajustes → Modo práctica).
 * - Usa un almacenamiento propio: otra base IndexedDB y claves de
 *   localStorage con prefijo. Los datos reales no se leen ni se modifican.
 * - Nunca se sincroniza (no hay forma de activar la sincronización).
 * - Los archivos descargados llevan el prefijo PRACTICA_.
 */
import { ESPECIALIDAD } from '../config/catalogs.js';
import { todayIso } from '../core/format.js';
import { buildPracticeData } from '../core/demo.js';
import { casosDeEjemplo } from '../specialties/activa/index.js';

export const PRACTICE_PREFIX = 'practica:';

/** ¿La app está en modo práctica? */
export const isPractice = () => {
  try {
    return new URLSearchParams(location.search).has('practica');
  } catch {
    return false;
  }
};

/** Nombre de la base IndexedDB según el modo. @param {boolean} practice */
export const dbName = (practice) => `hhr-rondas-${ESPECIALIDAD.id}${practice ? '-practica' : ''}`;

/**
 * localStorage con prefijo: el modo práctica guarda sus ajustes, catálogos y
 * borrador aparte, con las mismas claves que la app normal.
 * @param {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} base
 * @returns {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>}
 */
export function prefixedStorage(base, prefix = PRACTICE_PREFIX) {
  return {
    getItem: (k) => base.getItem(prefix + k),
    setItem: (k, v) => base.setItem(prefix + k, v),
    removeItem: (k) => base.removeItem(prefix + k),
  };
}

/**
 * Carga los datos de ejemplo si el modo práctica está vacío.
 * @param {ReturnType<typeof import('../storage/store.js').createStore>} store
 * @returns {boolean} true si los cargó
 */
export function seedPractice(store) {
  if (store.loadRecords().length || store.loadMedicos().length) return false;
  const data = buildPracticeData({ today: todayIso(), now: Date.now(), casos: casosDeEjemplo() });
  store.saveMedicos(data.medicos);
  store.saveOperativos(data.operativos);
  store.saveRecords(data.records);
  store.saveSettings({ ...store.loadSettings(), deviceName: 'PC de práctica' });
  store.saveMedico({ n: '', r: '', op: data.operativos[0].nombre });
  return true;
}

/** Borra todo lo del modo práctica (vuelve a los datos de ejemplo al recargar). */
export async function resetPractice() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PRACTICE_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* sin localStorage: nada que borrar */
  }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(dbName(true));
    req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
  });
}

/** Dirección para entrar o salir del modo práctica (misma página). @param {boolean} on */
export function practiceUrl(on) {
  const u = new URL(location.href);
  if (on) u.searchParams.set('practica', '');
  else u.searchParams.delete('practica');
  return u.pathname + (u.search.replace(/=(&|$)/, '$1') || '') + u.hash;
}
