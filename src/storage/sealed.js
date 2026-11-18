/**
 * Cifrado de lo que se guarda en este PC (ADR 0016).
 *
 * Una llave aleatoria por PC (`D`) cifra con AES-256-GCM los datos de pacientes:
 *  - `sealedBackend` envuelve un motor (IndexedDB): cada documento se guarda como
 *    `{id: idOpaco, iv, ct}`. El id opaco es un HMAC del id (los de las fichas
 *    salen del RUT). Los contenidos de adjuntos conservan su id (aleatorio) y
 *    guardan los bytes cifrados en `bin`.
 *  - `sealedStorage` envuelve localStorage: las claves sensibles guardan
 *    `enc1:<iv>:<cifrado>`; las demás siguen legibles.
 *
 * Cada envoltura tiene tres estados:
 *  - `clear`: este PC aún no tiene llave; todo pasa sin cambios (como antes de 2.29).
 *  - `locked`: hay llave pero no se abrió. Leer falla (LockedError); lo que se
 *    intente escribir se descarta: antes de entrar no hay datos reales en
 *    memoria, y guardarlos pisaría lo cifrado (o quedaría pendiente de reintento).
 *  - `open`: se cifra y descifra. Al abrir, lo que quedó legible se cifra.
 */
import { utf8, toHex, hmacSha256 } from '../lib/sha256.js';
import { COLLECTIONS } from './backends.js';

/** Prefijo de un valor cifrado en localStorage. */
const PREFIX = 'enc1:';
/** Colección cuyos documentos conservan su id (contenidos de adjuntos: ids aleatorios). */
const BINARY = 'adjuntos_datos';

/** El almacenamiento está cerrado: falta entrar. */
export class LockedError extends Error {
  constructor() {
    super('Los datos de este PC están cerrados: entra con tu clave.');
  }
}

/** @typedef {{enc: CryptoKey, mac: Uint8Array}} PcKeys llaves derivadas de `D` */
/** @typedef {import('./backends.js').Backend} Backend */
/** @typedef {import('./backends.js').DocumentoLeido} DocumentoLeido */
/** @typedef {import('./store.js').KeyValueStorage} KeyValueStorage */

const subtle = () => globalThis.crypto.subtle;
/** @param {number} n */
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** @param {Uint8Array} bytes */
export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** @param {string} b64 */
export const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Llave AES-GCM derivada (HKDF) de un secreto, para una etiqueta.
 * @param {Uint8Array} secret @param {string} label
 */
export async function deriveAesKey(secret, label) {
  const base = await subtle().importKey('raw', /** @type {BufferSource} */ (secret), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(`hhr-pc-v1:${label}`) },
    base,
    256,
  );
  return subtle().importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Llaves de trabajo que salen de la llave del PC.
 * @param {Uint8Array} raw 32 bytes
 * @returns {Promise<PcKeys>}
 */
export async function pcKeys(raw) {
  const base = await subtle().importKey('raw', /** @type {BufferSource} */ (raw), 'HKDF', false, ['deriveBits']);
  const mac = new Uint8Array(
    await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8('hhr-pc-v1:ids') }, base, 256),
  );
  return { enc: await deriveAesKey(raw, 'cifrado'), mac };
}

/**
 * Cifra bytes con AES-GCM, atados a `label` (no se pueden mover a otro lugar).
 * @param {CryptoKey} key @param {string} label @param {Uint8Array} bytes
 * @returns {Promise<{iv: Uint8Array, ct: Uint8Array}>}
 */
export async function seal(key, label, bytes) {
  const iv = random(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(label) }, key, /** @type {BufferSource} */ (bytes));
  return { iv, ct: new Uint8Array(ct) };
}

/**
 * Descifra lo que cifró `seal`. Falla (DOMException) si la llave o el lugar no corresponden.
 * @param {CryptoKey} key @param {string} label @param {Uint8Array} iv @param {Uint8Array} ct
 */
export async function unseal(key, label, iv, ct) {
  const out = await subtle().decrypt(
    { name: 'AES-GCM', iv: /** @type {BufferSource} */ (iv), additionalData: utf8(label) },
    key,
    /** @type {BufferSource} */ (ct),
  );
  return new Uint8Array(out);
}

/* --------------------------------------------------------------- motor */

/**
 * Id con que se guarda un documento: opaco, salvo los contenidos de adjuntos.
 * @param {PcKeys} k @param {string} col @param {string} id
 */
const storedId = (k, col, id) => (col === BINARY ? id : 'o' + toHex(hmacSha256(k.mac, utf8(`${col}|${id}`))).slice(0, 32));

/** ¿Está cifrado este documento guardado? @param {DocumentoLeido} d */
const isSealed = (d) => 'ct' in d || 'bin' in d;

/**
 * @param {PcKeys} k @param {string} col @param {{id: string, [k: string]: unknown}} doc
 * @returns {Promise<{id: string, iv: string, ct?: string, bin?: Uint8Array}>}
 */
async function sealDoc(k, col, doc) {
  const id = storedId(k, col, doc.id);
  if (col === BINARY) {
    if (!(doc.bytes instanceof Uint8Array)) throw new TypeError(`${col}: el contenido de ${doc.id} no son bytes`);
    const { iv, ct } = await seal(k.enc, `${col}|${id}`, doc.bytes);
    return { id, iv: toB64(iv), bin: ct };
  }
  const { iv, ct } = await seal(k.enc, `${col}|${id}`, utf8(JSON.stringify(doc)));
  return { id, iv: toB64(iv), ct: toB64(ct) };
}

/**
 * @param {PcKeys} k @param {string} col @param {DocumentoLeido} stored
 * @returns {Promise<DocumentoLeido>}
 */
async function openDoc(k, col, stored) {
  if (!isSealed(stored)) return stored; // quedó legible (se cifra al abrir)
  const label = `${col}|${stored.id}`;
  const iv = fromB64(/** @type {string} */ (stored.iv));
  if ('bin' in stored) return { id: stored.id, bytes: await unseal(k.enc, label, iv, /** @type {Uint8Array} */ (stored.bin)) };
  return JSON.parse(new TextDecoder().decode(await unseal(k.enc, label, iv, fromB64(/** @type {string} */ (stored.ct)))));
}

/**
 * Envuelve un motor para que guarde cifrado (ver arriba los estados).
 * `keys()` solo tiene sentido para los contenidos de adjuntos (los demás ids son opacos).
 * @param {Backend} inner
 * @param {{locked?: boolean}} [o] `locked`: el PC ya tiene llave
 */
export function sealedBackend(inner, { locked = false } = {}) {
  /** @type {PcKeys | null} */
  let keys = null;
  let isLocked = locked;
  /** Llaves si está abierto, null si está sin llave; falla si está cerrado. */
  const current = () => {
    if (isLocked) throw new LockedError();
    return keys;
  };

  /** @param {string} col @param {{id: string}} doc */
  const toStore = async (col, doc) => (keys ? sealDoc(keys, col, doc) : doc);

  /** Documentos escritos o borrados desde que se abrió: la conversión no los pisa. @type {Set<string>} */
  const touched = new Set();
  /** @param {string} col @param {string} id */
  const touch = (col, id) => keys && touched.add(`${col}|${storedId(keys, col, id)}`);

  /**
   * Cifra lo que quedó legible en una colección, en un solo lote. No pisa una
   * versión ya cifrada ni lo que se guardó o borró mientras tanto (es más nuevo).
   * @param {PcKeys} k @param {string} col
   */
  async function sealLeftovers(k, col) {
    if (col === BINARY) return sealBinaryLeftovers(k);
    const docs = await inner.getAll(col);
    const clear = docs.filter((d) => !isSealed(d));
    if (!clear.length) return 0;
    const sealedIds = new Set(docs.filter(isSealed).map((d) => d.id));
    const fresh = await Promise.all(clear.map((d) => sealDoc(k, col, d)));
    // Sin esperas entre el filtro y la escritura: lo que se guarde después va en una transacción posterior.
    const toWrite = fresh.filter((d) => !sealedIds.has(d.id) && !touched.has(`${col}|${d.id}`));
    if (toWrite.length) await inner.putMany(col, toWrite);
    for (const d of clear) await inner.delete(col, d.id);
    return clear.length;
  }

  /** Contenidos de adjuntos: de a uno (pueden pesar), con el mismo id. @param {PcKeys} k */
  async function sealBinaryLeftovers(k) {
    let n = 0;
    for (const id of await inner.keys(BINARY)) {
      const doc = await inner.get(BINARY, id);
      if (!doc || isSealed(doc) || touched.has(`${BINARY}|${id}`)) continue;
      await inner.put(BINARY, await sealDoc(k, BINARY, doc));
      n++;
    }
    return n;
  }

  /** @type {Backend} */
  const backend = {
    name: inner.name,
    binary: inner.binary,
    close: () => inner.close(),
    async getAll(col) {
      const k = current();
      const docs = await inner.getAll(col);
      return k ? Promise.all(docs.map((d) => openDoc(k, col, d))) : docs;
    },
    async get(col, id) {
      const k = current();
      if (!k) return inner.get(col, id);
      const sid = storedId(k, col, id);
      const doc = (await inner.get(col, sid)) || (sid !== id ? await inner.get(col, id) : undefined);
      return doc && openDoc(k, col, doc);
    },
    keys: (col) => {
      current();
      return inner.keys(col);
    },
    async put(col, doc) {
      if (isLocked) return undefined;
      touch(col, doc.id);
      return inner.put(col, await toStore(col, doc));
    },
    async putMany(col, docs) {
      if (isLocked) return undefined;
      for (const d of docs) touch(col, d.id);
      return inner.putMany(col, await Promise.all(docs.map((d) => toStore(col, d))));
    },
    async delete(col, id) {
      if (isLocked) return undefined;
      touch(col, id);
      const k = keys;
      if (!k) return inner.delete(col, id);
      const sid = storedId(k, col, id);
      await inner.delete(col, sid);
      if (sid !== id) await inner.delete(col, id); // por si quedó legible
      return undefined;
    },
    clear: async (col) => (isLocked ? undefined : inner.clear(col)),
  };

  return {
    backend,
    /** @returns {'clear' | 'locked' | 'open'} */
    get state() {
      return keys ? 'open' : isLocked ? 'locked' : 'clear';
    },
    /**
     * Abre con las llaves del PC (o empieza a cifrar, si no tenía) y cifra lo que quedó legible.
     * @param {PcKeys} k
     * @returns {Promise<number>} cuántos documentos se cifraron ahora
     */
    async open(k) {
      keys = k;
      isLocked = false;
      let n = 0;
      for (const col of COLLECTIONS) n += await sealLeftovers(k, col).catch(() => 0);
      return n;
    },
  };
}

/* ---------------------------------------------------------- localStorage */

/** @param {CryptoKey} key @param {string} name @param {string} value */
async function sealString(key, name, value) {
  const { iv, ct } = await seal(key, `ls|${name}`, utf8(value));
  return `${PREFIX}${toB64(iv)}:${toB64(ct)}`;
}

/** @param {CryptoKey} key @param {string} name @param {string} stored */
async function openString(key, name, stored) {
  const [iv, ct] = stored.slice(PREFIX.length).split(':');
  return new TextDecoder().decode(await unseal(key, `ls|${name}`, fromB64(iv), fromB64(ct)));
}

/**
 * Envuelve un almacenamiento clave → texto (localStorage): las claves `sensitive`
 * se guardan cifradas. La interfaz sigue siendo síncrona: al abrir se descifran
 * a memoria, y cada escritura se cifra y guarda enseguida (en orden por clave).
 * @param {KeyValueStorage} base
 * @param {Iterable<string>} sensitive
 * @param {{locked?: boolean, onError?: (e: unknown) => void}} [o]
 */
export function sealedStorage(base, sensitive, { locked = false, onError = () => {} } = {}) {
  const secret = new Set(sensitive);
  /** @type {CryptoKey | null} */
  let key = null;
  let isLocked = locked;
  /** @type {Map<string, string>} */
  const cache = new Map();
  /** Versión de cada clave: una escritura más vieja no pisa a una más nueva. @type {Map<string, number>} */
  const version = new Map();
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  const bump = (/** @type {string} */ name) => {
    const n = (version.get(name) || 0) + 1;
    version.set(name, n);
    return n;
  };

  /** @param {CryptoKey} k @param {string} name @param {string} value */
  function persist(k, name, value) {
    const n = bump(name);
    const p = sealString(k, name, value)
      .then((s) => {
        if (version.get(name) === n) base.setItem(name, s);
      })
      .catch(onError)
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  /** @type {KeyValueStorage} */
  const storage = {
    getItem(name) {
      if (!secret.has(name) || (!key && !isLocked)) return base.getItem(name);
      return key ? (cache.get(name) ?? null) : null;
    },
    setItem(name, value) {
      if (!secret.has(name) || (!key && !isLocked)) return base.setItem(name, value);
      if (!key) return; // cerrado: no hay datos reales que guardar (no se pisa lo cifrado)
      cache.set(name, String(value));
      persist(key, name, String(value));
    },
    removeItem(name) {
      if (secret.has(name)) {
        cache.delete(name);
        bump(name);
      }
      base.removeItem(name);
    },
  };

  return {
    storage,
    /** @returns {'clear' | 'locked' | 'open'} */
    get state() {
      return key ? 'open' : isLocked ? 'locked' : 'clear';
    },
    /**
     * Abre con la llave del PC: descifra a memoria y cifra lo que quedó legible.
     * Un valor que no se puede descifrar se informa y se trata como ausente.
     * @param {PcKeys} k
     */
    async open(k) {
      for (const name of secret) {
        const raw = base.getItem(name);
        if (raw == null) continue;
        if (!raw.startsWith(PREFIX)) {
          cache.set(name, raw);
          persist(k.enc, name, raw);
          continue;
        }
        try {
          cache.set(name, await openString(k.enc, name, raw));
        } catch (e) {
          onError(e);
        }
      }
      key = k.enc;
      isLocked = false;
      await this.flush();
    },
    /** Espera a que se guarden las escrituras en curso. */
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
