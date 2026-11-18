/**
 * Cuentas (servidor): dónde y cómo se guardan cuentas, sesiones y el registro
 * de accesos. Almacén (el de la sincronización; las claves con `_` no son datos):
 *   _cuentas/config                 {activas, creado}
 *   _cuentas/u/<uid>                cuenta
 *   _cuentas/rut/<huella del RUT>   {uid}
 *   _cuentas/s/<AAAAMMDD>/<sid>     sesión {uid, inicio, ultimo, exp, fin?, motivo?}
 *   _auditoria/<AAAAMMDD>/<t>.<r>   evento (solo se agregan)
 */
import { accountRut, USER_ID_RE, SESSION_MS } from '../../core/accounts.js';

/** @typedef {import('../server.js').BlobStore} BlobStore */
/**
 * @typedef {{
 *   id: string, rutHash: string, rol: string, admin: boolean, estado: import('./validate.js').EstadoCuenta,
 *   debeCambiar: boolean, tempExpira: number | null, sal: string, iter: number, verificador: string,
 *   envuelta: {iv: string, ct: string}, perfil: {iv: string, ct: string},
 *   fallos: number, bloqueadaHasta: number, creado: number, creadoPor: string | null,
 *   actualizado: number, ultimoIngreso: number | null, claveCambiada: number | null,
 * }} Cuenta
 */
/** @typedef {{uid: string, inicio: number, ultimo: number, exp: number, fin?: number, motivo?: string}} Sesion */
/**
 * Evento del registro de accesos (antes de agregarle la hora del servidor).
 * @typedef {{ev: string, u?: string | null, s?: string | null, obj?: string, n?: number, esp?: string, at?: number, off?: boolean, det?: Record<string, unknown>}} EventoAuditoria
 */

/** Día UTC de un momento, como AAAAMMDD (prefijo de sesiones y eventos). @param {number} t */
export const dayOf = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

/** Intentos de `updateUser` antes de rendirse si la cuenta cambia entre su lectura y su escritura. */
const UPDATE_TRIES = 5;

/** Claves del almacén. */
const K = Object.freeze({
  config: '_cuentas/config',
  users: '_cuentas/u/',
  /** @param {string} uid */
  user: (uid) => `_cuentas/u/${uid}`,
  /** @param {string} rh */
  rut: (rh) => `_cuentas/rut/${rh}`,
  /** @param {string} sid */
  session: (sid) => `_cuentas/s/${sid.slice(0, 8)}/${sid}`,
  /** Sesiones abiertas un día. @param {string} day AAAAMMDD */
  sessionsOn: (day) => `_cuentas/s/${day}/`,
  /** Eventos de un día. @param {string} day AAAAMMDD */
  auditOn: (day) => `_auditoria/${day}/`,
});

/**
 * @param {{store: BlobStore, now: () => number, randId: (n?: number) => string, rutHashOf: (rut: unknown) => string}} deps
 */
export function createAccountStore({ store, now, randId, rutHashOf }) {
  /** @param {string} key @returns {Promise<unknown>} */
  const read = (key) => store.get(key, { type: 'json' });

  /** @returns {Promise<Cuenta | null>} @param {string} uid */
  const getUser = async (uid) => /** @type {Cuenta | null} */ (USER_ID_RE.test(uid) ? await read(K.user(uid)) : null);
  /**
   * Cambia una cuenta sin pisar otra escritura simultánea (un administrador
   * que la edita, un ingreso, un bloqueo): lee la versión vigente con su etag,
   * aplica `change` y escribe solo si nadie la cambió entretanto; si alguien
   * lo hizo, vuelve a leer y a aplicar `change` sobre la versión nueva.
   * `change` decide sobre la cuenta ACTUAL: devuelve la cuenta nueva, o null
   * para no escribir.
   * @param {string} uid
   * @param {(u: Cuenta) => Cuenta | null} change
   * @returns {Promise<{antes: Cuenta, despues: Cuenta | null} | null>} null si la cuenta no
   *   existe; si no, la versión sobre la que se decidió y la escrita (null si `change` no escribió)
   */
  async function updateUser(uid, change) {
    if (!USER_ID_RE.test(uid)) return null;
    const key = K.user(uid);
    for (let i = 0; i < UPDATE_TRIES; i++) {
      const cur = await store.getWithMetadata(key, { type: 'json' });
      if (!cur) return null;
      const antes = /** @type {Cuenta} */ (cur.data);
      const despues = change(antes);
      if (!despues) return { antes, despues: null };
      if (!cur.etag) {
        // Un almacén que no entrega versión (p. ej. el servidor local de la
        // biblioteca) no permite escribir condicionado: se escribe como antes
        // de 2.39, sin protección ante escrituras simultáneas, en vez de dejar
        // a todos sin poder entrar.
        console.warn(`cuentas: el almacén no entregó la versión de ${uid}; escritura sin condición`);
        await store.setJSON(key, despues);
        return { antes, despues };
      }
      if ((await store.setJSON(key, despues, { onlyIfMatch: cur.etag })).modified) return { antes, despues };
    }
    throw new Error(`La cuenta ${uid} cambió ${UPDATE_TRIES} veces mientras se guardaba; no se guardó. Reintenta.`);
  }
  /** @param {string} sid @returns {Promise<Sesion | null>} */
  const getSession = async (sid) => /** @type {Sesion | null} */ (await read(K.session(sid)));

  /**
   * Agrega un evento al registro de accesos (hora del servidor).
   * @param {EventoAuditoria} e
   */
  async function audit(e) {
    const t = now();
    const entry = Object.fromEntries(Object.entries({ t, ...e }).filter(([, v]) => v !== undefined && v !== null));
    await store.setJSON(`${K.auditOn(dayOf(t))}${t}.${randId(6)}`, entry);
  }

  return {
    getUser,
    updateUser,
    getSession,
    audit,
    /** @param {string} sid @param {Sesion} ses */
    putSession: (sid, ses) => store.setJSON(K.session(sid), ses),

    /** @param {unknown} rut */
    async userByRut(rut) {
      if (!accountRut(rut)) return null;
      const idx = /** @type {{uid?: string} | null} */ (await read(K.rut(rutHashOf(rut))));
      return idx?.uid ? getUser(idx.uid) : null;
    },

    async allUsers() {
      const { blobs } = await store.list({ prefix: K.users });
      const out = await Promise.all(blobs.map((b) => /** @type {Promise<Cuenta | null>} */ (read(b.key))));
      return out.filter((u) => u !== null);
    },

    /** ¿Están activadas las cuentas? */
    async isActive() {
      const c = /** @type {{activas?: boolean} | null} */ (await read(K.config));
      return c?.activas === true;
    },

    /** Activa las cuentas (lo último al crear el primer administrador). @param {number} t */
    markActive: (t) => store.setJSON(K.config, { activas: true, creado: t }),

    /** Cierra todas las sesiones abiertas de una cuenta. @param {string} uid @param {string} motivo */
    async closeSessionsOf(uid, motivo) {
      const t = now();
      // Una sesión dura a lo más SESSION_MS: solo las creadas hoy o ayer pueden seguir abiertas.
      // (Antes se leían todas las del historial, que crece con cada ingreso.)
      const days = [...new Set([dayOf(t), dayOf(t - SESSION_MS)])];
      const lists = await Promise.all(days.map((day) => store.list({ prefix: K.sessionsOn(day) })));
      for (const b of lists.flatMap((l) => l.blobs)) {
        const s = /** @type {Sesion | null} */ (await read(b.key));
        if (s && s.uid === uid && !s.fin && s.exp > t) await store.setJSON(b.key, { ...s, fin: t, motivo });
      }
    },

    /**
     * Crea la cuenta y su índice por RUT (falla si el id o el RUT ya tienen
     * cuenta). Ambas escrituras son solo-si-no-existe: dos altas simultáneas
     * no se pisan; si otra ganó el RUT, la cuenta recién escrita se retira.
     * @param {Cuenta} u
     */
    async insertAccount(u) {
      const idx = K.rut(u.rutHash);
      if (await read(idx)) return false;
      if (!(await store.setJSON(K.user(u.id), u, { onlyIfNew: true })).modified) return false;
      if ((await store.setJSON(idx, { uid: u.id }, { onlyIfNew: true })).modified) return true;
      await store.delete(K.user(u.id));
      return false;
    },

    /**
     * Antes de activar no hay cuentas, salvo la de una activación que quedó a
     * medias (se guardó la cuenta y no la configuración). Si es de este RUT, se
     * descarta para que el reintento pueda crearla de nuevo.
     * @param {string} rutHash
     */
    async discardUnactivated(rutHash) {
      const idx = /** @type {{uid?: string} | null} */ (await read(K.rut(rutHash)));
      if (!idx) return;
      if (idx.uid) await store.delete(K.user(idx.uid));
      await store.delete(K.rut(rutHash));
    },

    /**
     * Eventos y sesiones de un día UTC (AAAAMMDD), tal como están guardados.
     * @param {string} day
     * @returns {Promise<{events: {t: number}[], sessions: (Sesion & {id: string | undefined})[]}>}
     */
    async auditDay(day) {
      const [ev, ses] = await Promise.all([store.list({ prefix: K.auditOn(day) }), store.list({ prefix: K.sessionsOn(day) })]);
      /** @type {{t: number}[]} */
      const events = [];
      for (const x of ev.blobs) {
        const e = /** @type {{t: number} | null} */ (await read(x.key));
        if (e) events.push(e);
      }
      /** @type {(Sesion & {id: string | undefined})[]} */
      const sessions = [];
      for (const x of ses.blobs) {
        const s = /** @type {Sesion | null} */ (await read(x.key));
        if (s) sessions.push({ id: x.key.split('/').pop(), ...s });
      }
      return { events, sessions };
    },
  };
}
