/**
 * Motores de almacenamiento persistente para colecciones de documentos con `id`.
 *
 * - IndexedDB (preferido): un documento por clave, sin el límite de ~5 MB de
 *   localStorage, y cada guardado escribe solo el documento que cambió.
 * - localStorage (respaldo): para navegadores o contextos sin IndexedDB.
 *
 * Interfaz común (todas asíncronas):
 *   getAll(col) -> doc[]   put(col, doc)   putMany(col, docs)   delete(col, id)   clear(col)
 *   get(col, id) -> doc|undefined   keys(col) -> id[]   (para leer de a uno lo que pesa)
 */

/** Colecciones persistentes. `adjuntos_datos` (bytes de los adjuntos) no se carga entera al abrir. */
export const COLLECTIONS = ['atenciones', 'eliminadas', 'bitacora', 'pacientes', 'adjuntos', 'adjuntos_datos'];

/** Versión de la base IndexedDB: subirla al agregar colecciones (se crean en onupgradeneeded). */
const DB_VERSION = 3;

/**
 * Documento que se guarda: cualquier objeto con `id` (la clave en cada colección).
 * @typedef {{id: string}} Documento
 */
/**
 * Documento tal como se lee: del resto de sus campos no se sabe nada; quien lo
 * usa los valida o los trata como propios (lector tolerante, ADR 0012).
 * @typedef {{id: string, [campo: string]: unknown}} DocumentoLeido
 */
/**
 * Interfaz común de los motores.
 * @typedef {object} Backend
 * @property {string} name
 * @property {boolean} [binary] si puede guardar archivos (si falta, se asume que sí)
 * @property {(col: string) => Promise<DocumentoLeido[]>} getAll
 * @property {(col: string, id: string) => Promise<DocumentoLeido | undefined>} get
 * @property {(col: string) => Promise<string[]>} keys
 * @property {<D extends Documento>(col: string, doc: D) => Promise<unknown>} put
 * @property {(col: string, docs: Documento[]) => Promise<unknown>} putMany
 * @property {(col: string, id: string) => Promise<unknown>} delete
 * @property {(col: string) => Promise<unknown>} clear
 * @property {() => void} close
 */

/**
 * Motor IndexedDB.
 * @param {string} dbName nombre de la base (incluye la especialidad)
 * @param {IDBFactory} [idb] por defecto `globalThis.indexedDB` (en pruebas: fake-indexeddb)
 * @returns {Promise<Backend>}
 */
export async function idbBackend(dbName, idb = globalThis.indexedDB) {
  if (!idb) throw new Error('IndexedDB no disponible');
  /** @type {IDBDatabase} */
  const db = await new Promise((resolve, reject) => {
    const req = idb.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const col of COLLECTIONS) if (!req.result.objectStoreNames.contains(col)) req.result.createObjectStore(col, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('La base de datos está bloqueada por otra pestaña'));
  });
  /**
   * Ejecuta una operación en una transacción y espera a que se confirme.
   * Resuelve con el resultado de la petición que devuelve `fn` (si devuelve una).
   * @template T
   * @param {string} col
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest<T> | undefined} fn
   * @returns {Promise<T>}
   */
  const tx = (col, mode, fn) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(col, mode);
      const store = t.objectStore(col);
      const result = fn(store);
      // Sin petición (putMany), T es `unknown` y se resuelve con undefined.
      t.oncomplete = () => resolve(/** @type {T} */ (result?.result));
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transacción abortada'));
    });
  return {
    name: 'indexeddb',
    getAll: (col) => tx(col, 'readonly', (s) => s.getAll()),
    get: (col, id) => tx(col, 'readonly', (s) => s.get(id)),
    // Las claves son los `id` de los documentos (texto).
    keys: (col) => /** @type {Promise<string[]>} */ (tx(col, 'readonly', (s) => s.getAllKeys())),
    binary: true,
    put: (col, doc) => tx(col, 'readwrite', (s) => s.put(doc)),
    putMany: (col, docs) =>
      tx(col, 'readwrite', (s) => {
        docs.forEach((d) => s.put(d));
        return undefined;
      }),
    delete: (col, id) => tx(col, 'readwrite', (s) => s.delete(id)),
    clear: (col) => tx(col, 'readwrite', (s) => s.clear()),
    close: () => db.close(),
  };
}

/**
 * Motor localStorage: cada colección es un arreglo JSON bajo una clave.
 * @param {Pick<Storage, 'getItem'|'setItem'|'removeItem'>} storage
 * @param {Record<string, string>} keys colección -> clave de localStorage
 * @returns {Backend}
 */
export function localStorageBackend(storage, keys) {
  /**
   * @param {string} col
   * @returns {DocumentoLeido[]}
   */
  const read = (col) => {
    try {
      const v = JSON.parse(storage.getItem(keys[col]) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  /**
   * @param {string} col
   * @param {Documento[]} docs
   */
  const write = (col, docs) => storage.setItem(keys[col], JSON.stringify(docs));
  /**
   * @param {string} col
   * @param {Documento[]} docs
   */
  const upsert = (col, docs) => {
    const map = new Map(read(col).map((d) => [d.id, d]));
    for (const d of docs) map.set(d.id, d);
    write(col, [...map.values()]);
  };
  return {
    name: 'localstorage',
    getAll: async (col) => read(col),
    get: async (col, id) => read(col).find((d) => d.id === id),
    keys: async (col) => read(col).map((d) => d.id),
    /** Sin espacio para archivos: los adjuntos requieren IndexedDB. */
    binary: false,
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
