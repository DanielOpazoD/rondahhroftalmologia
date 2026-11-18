/**
 * Llave de este PC (`D`) y sus estuches (ADR 0016).
 *
 * `D` nunca se guarda legible. En localStorage (`llave_pc`) queda envuelta:
 *  - una vez por cuenta que entró aquí, con una llave derivada del valor `local`
 *    de su clave personal (ADR 0014): permite entrar sin conexión;
 *  - una vez con la clave del equipo `K`: tras entrar con conexión, abre `D`
 *    aunque la persona nunca haya entrado en este PC o haya cambiado su clave.
 *
 * Al abrirse, abre el motor y el almacenamiento cifrados (`sealed.js`) y avisa
 * con `onOpen` para cargar los datos.
 */
import { pcKeys, deriveAesKey, seal, unseal, toB64, fromB64 } from './sealed.js';
import { isRecord } from '../core/guards.js';

/**
 * Estuche: `D` cifrada con una llave derivada.
 * @typedef {{iv: string, ct: string}} Estuche
 * @typedef {{v: 1, equipo: Estuche, cuentas: Record<string, Estuche>}} ArchivoLlave
 */

/** @param {string} hex */
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

/** @param {Uint8Array} raw @param {CryptoKey} key @param {string} label @returns {Promise<Estuche>} */
async function wrap(raw, key, label) {
  const { iv, ct } = await seal(key, `pc|${label}`, raw);
  return { iv: toB64(iv), ct: toB64(ct) };
}

/**
 * Abre un estuche; null si la llave no corresponde.
 * @param {Estuche | undefined} e @param {CryptoKey} key @param {string} label
 */
async function unwrap(e, key, label) {
  if (!e) return null;
  try {
    const raw = await unseal(key, `pc|${label}`, fromB64(e.iv), fromB64(e.ct));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

/** @param {string} localHex valor `local` de la clave personal */
const accountKey = (localHex) => deriveAesKey(fromHex(localHex), 'cuenta');
/** @param {string} teamKeyB64 clave del equipo */
const teamKey = (teamKeyB64) => deriveAesKey(fromB64(teamKeyB64), 'equipo');

/** @param {unknown} v @returns {v is ArchivoLlave} */
const isFile = (v) => isRecord(v) && v.v === 1 && isRecord(v.equipo) && isRecord(v.cuentas);

/**
 * @param {{
 *   storage: import('./store.js').KeyValueStorage,
 *   name: string,
 *   targets: {open: (k: import('./sealed.js').PcKeys) => Promise<unknown>}[],
 *   onOpen?: (o: {first: boolean}) => Promise<void> | void,
 * }} o `storage`: el almacenamiento sin cifrar; `name`: clave del archivo; `targets`: lo que se abre con la llave.
 */
export function createPcVault({ storage, name, targets, onOpen = () => {} }) {
  /** @returns {ArchivoLlave | null} */
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(name) || 'null');
      return isFile(v) ? v : null;
    } catch {
      return null;
    }
  };
  /** @param {ArchivoLlave} file */
  const write = (file) => storage.setItem(name, JSON.stringify(file));
  /** Llave abierta, solo en memoria. @type {Uint8Array | null} */
  let raw = null;

  /**
   * Deja al día los estuches de esta cuenta y del equipo (su clave o la del equipo pueden haber cambiado).
   * @param {ArchivoLlave} file @param {Uint8Array} d @param {{kTeam: CryptoKey, kAccount: CryptoKey, uid: string}} o
   */
  async function renew(file, d, { kTeam, kAccount, uid }) {
    write({ ...file, equipo: await wrap(d, kTeam, 'equipo'), cuentas: { ...file.cuentas, [uid]: await wrap(d, kAccount, uid) } });
  }

  /** @param {Uint8Array} d @param {boolean} first */
  async function activate(d, first) {
    raw = d;
    const keys = await pcKeys(d);
    for (const t of targets) await t.open(keys);
    await onOpen({ first });
  }

  return {
    /** clear: sin llave todavía · locked: falta abrirla · open: abierta. @returns {'clear' | 'locked' | 'open'} */
    get state() {
      return raw ? 'open' : read() ? 'locked' : 'clear';
    },

    /**
     * Tras entrar CON conexión: abre la llave (con el estuche de la cuenta o el
     * del equipo) o la crea si este PC aún no tiene, y deja al día los estuches.
     * @param {{teamKeyB64: string, uid: string, local: string}} o
     * @returns {Promise<void>}
     * @throws {Error} si existe una llave que ni la cuenta ni el equipo abren
     */
    async unlockOnline({ teamKeyB64, uid, local }) {
      const file = read();
      const [kAccount, kTeam] = await Promise.all([accountKey(local), teamKey(teamKeyB64)]);
      if (raw) {
        if (file) await renew(file, raw, { kTeam, kAccount, uid });
        return;
      }
      if (!file) {
        // Primera vez: llave nueva. El archivo se guarda ANTES de cifrar nada con ella.
        const d = globalThis.crypto.getRandomValues(new Uint8Array(32));
        write({ v: 1, equipo: await wrap(d, kTeam, 'equipo'), cuentas: { [uid]: await wrap(d, kAccount, uid) } });
        return activate(d, true);
      }
      const d = (await unwrap(file.cuentas[uid], kAccount, uid)) || (await unwrap(file.equipo, kTeam, 'equipo'));
      if (!d) throw new Error('No se pudieron abrir los datos guardados en este PC (cambió la clave del equipo). Avisa al administrador.');
      await renew(file, d, { kTeam, kAccount, uid });
      return activate(d, false);
    },

    /**
     * Sin conexión: abre la llave con el estuche de la cuenta.
     * @param {{uid: string, local: string}} o
     * @returns {Promise<'ok' | 'wrong' | 'missing'>} `wrong`: clave incorrecta;
     *   `missing`: la cuenta aún no entró con conexión en este PC.
     */
    async unlockOffline({ uid, local }) {
      if (raw) return 'ok';
      const file = read();
      if (!file?.cuentas[uid]) return 'missing';
      const d = await unwrap(file.cuentas[uid], await accountKey(local), uid);
      if (!d) return 'wrong';
      await activate(d, false);
      return 'ok';
    },

    /**
     * Quita estuches de cuentas: las que no están en `keep` (o solo `uid`, si se da).
     * Se usa al desactivar una cuenta o quitarla de este PC: deja de poder abrir
     * los datos sin conexión. No necesita la llave abierta.
     * @param {{uid?: string, keep?: string[]}} o
     */
    forget({ uid, keep }) {
      const file = read();
      if (!file) return;
      const cuentas = { ...file.cuentas };
      for (const id of Object.keys(cuentas)) if (id === uid || (keep && !keep.includes(id))) delete cuentas[id];
      if (Object.keys(cuentas).length !== Object.keys(file.cuentas).length) write({ ...file, cuentas });
    },

    /**
     * Tras cambiar la clave: rehace el estuche de la cuenta (el anterior deja de servir).
     * @param {{uid: string, local: string}} o
     */
    async rewrap({ uid, local }) {
      const file = read();
      if (!raw || !file) return;
      write({ ...file, cuentas: { ...file.cuentas, [uid]: await wrap(raw, await accountKey(local), uid) } });
    },
  };
}
