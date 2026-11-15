/**
 * Motores de almacenamiento persistente para colecciones de documentos con `id`.
 *
 * - IndexedDB (preferido): un documento por clave, sin el límite de ~5 MB de
 *   localStorage, y cada guardado escribe solo el documento que cambió.
 * - localStorage (respaldo): para navegadores o contextos sin IndexedDB.
 *
 * Interfaz común (todas asíncronas):
 *   getAll(col) -> doc[]   put(col, doc)   putMany(col, docs)   delete(col, id)   clear(col)
 */

/** Colecciones persistentes. */
export const COLLECTIONS = ['atenciones', 'eliminadas', 'bitacora'];

/**
 * Motor IndexedDB.
 * @param {string} dbName nombre de la base (incluye la especialidad)
 * @param {IDBFactory} [idb] por defecto `globalThis.indexedDB` (en pruebas: fake-indexeddb)
 */
export async function idbBackend(dbName, idb = globalThis.indexedDB) {
  if (!idb) throw new Error('IndexedDB no disponible');
  const db = await new Promise((resolve, reject) => {
    const req = idb.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const col of COLLECTIONS) if (!req.result.objectStoreNames.contains(col)) req.result.createObjectStore(col, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('La base de datos está bloqueada por otra pestaña'));
  });
  /** Ejecuta una operación en una transacción y espera a que se confirme. */
  const tx = (col, mode, fn) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(col, mode);
      const store = t.objectStore(col);
      const result = fn(store);
      t.oncomplete = () => resolve(result?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transacción abortada'));
    });
  return {
    name: 'indexeddb',
    getAll: (col) => tx(col, 'readonly', (s) => s.getAll()),
    put: (col, doc) => tx(col, 'readwrite', (s) => s.put(doc)),
    putMany: (col, docs) => tx(col, 'readwrite', (s) => docs.forEach((d) => s.put(d))),
    delete: (col, id) => tx(col, 'readwrite', (s) => s.delete(id)),
    clear: (col) => tx(col, 'readwrite', (s) => s.clear()),
    close: () => db.close(),
  };
}

/**
 * Motor localStorage: cada colección es un arreglo JSON bajo una clave.
 * @param {Pick<Storage, 'getItem'|'setItem'|'removeItem'>} storage
 * @param {Record<string, string>} keys colección -> clave de localStorage
 */
export function localStorageBackend(storage, keys) {
  const read = (col) => {
    try {
      const v = JSON.parse(storage.getItem(keys[col]) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (col, docs) => storage.setItem(keys[col], JSON.stringify(docs));
  const upsert = (col, docs) => {
    const map = new Map(read(col).map((d) => [d.id, d]));
    for (const d of docs) map.set(d.id, d);
    write(col, [...map.values()]);
  };
  return {
    name: 'localstorage',
    getAll: async (col) => read(col),
    put: async (col, doc) => upsert(col, [doc]),
    putMany: async (col, docs) => upsert(col, docs),
    delete: async (col, id) =>
      write(
        col,
        read(col).filter((d) => d.id !== id),
      ),
    clear: async (col) => write(col, []),
    close: () => {},
  };
}
