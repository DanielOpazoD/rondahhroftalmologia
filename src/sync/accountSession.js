/**
 * Sesión de una cuenta de usuario en el PC (ADR 0014), SIN interfaz: entrar
 * (con y sin conexión), primer ingreso con cambio de clave, renovar la sesión,
 * salir, verificar la clave (desbloqueo), activar las cuentas (primer
 * administrador) y la cola del registro de accesos.
 *
 * Es el «cliente» de las cuentas (capa sync/). La pantalla (ui/accounts.js) solo pide datos, muestra mensajes y reacciona
 * a los avisos (`hooks`). Así esta lógica se prueba en Node contra el
 * servidor real en memoria (tests/accountSession.test.js).
 */
import { nameParts } from '../core/names.js';
import { accountRut, initialPassword, newUserId, passwordProblem } from '../core/accounts.js';
import { sha256, toHex } from '../lib/sha256.js';
import { importEncKey, DecryptError } from './crypto.js';
import {
  deriveAccountSecrets,
  unwrapTeamKey,
  decryptProfile,
  encryptProfile,
  credentialsFor,
  ACCOUNT_ITERATIONS,
} from './accountCrypto.js';

/**
 * @typedef {import('./accountCrypto.js').PerfilCuenta & {id: string, rol: string, admin: boolean, offline: boolean}} CuentaActiva
 * @typedef {import('./accountCrypto.js').PerfilCuenta & {uid: string, sal: string, iter: number, localHash: string, rol: string, admin: boolean}} CuentaLocal
 * @typedef {{get: () => any, set: (v: any) => void}} SesionGuardada  sesión de la pestaña (sessionStorage)
 * @typedef {{
 *   state: 'clear' | 'locked' | 'open',
 *   unlockOnline: (o: {teamKeyB64: string, uid: string, local: string}) => Promise<void>,
 *   unlockOffline: (o: {uid: string, local: string}) => Promise<'ok' | 'wrong' | 'missing'>,
 *   rewrap: (o: {uid: string, local: string}) => Promise<void>,
 * }} LlavePc  llave que cifra los datos de este PC (storage/pcVault.js, ADR 0016)
 */

/** Huella del valor `local` (lo que se guarda en el PC para entrar sin conexión). @param {string} local */
const localHashOf = (local) => toHex(sha256(local));

/** Mensaje para un error de cuentas. @param {any} e */
export function errorMessage(e) {
  if (e instanceof DecryptError) {
    return 'No se pudo abrir la clave del equipo con esta cuenta. Pide a un administrador que restablezca tu clave.';
  }
  return e?.message || String(e);
}

/**
 * @param {{
 *   api: ReturnType<typeof import('./accountsApi.js').createAccountsApi>,
 *   store: any,
 *   session: SesionGuardada,
 *   persist?: (fn: () => void) => boolean,
 *   now?: () => number,
 *   online?: () => boolean,
 *   iterations?: number,
 *   hooks?: {needLogin?: (message: string) => void, changed?: () => void, renewed?: () => void},
 *   vault?: LlavePc,
 * }} deps
 */
export function createAccountSession({
  api,
  store,
  session,
  persist = (fn) => (fn(), true),
  now = Date.now,
  online = () => true,
  iterations = ACCOUNT_ITERATIONS,
  hooks = {},
  vault,
}) {
  const st = {
    on: store.loadAccountsOn(),
    /** @type {CuentaActiva | null} */
    user: null,
    /** @type {string | null} */
    token: null,
    exp: 0,
    /** Solo en memoria: para renovar la sesión sin pedir la clave. @type {string | null} */
    acceso: null,
    /** Solo en memoria: para cambiar la clave. @type {string | null} */
    complemento: null,
  };

  /* ------------------------------------------------------ cuentas locales */

  /** @returns {Record<string, CuentaLocal>} */
  const locals = () => store.loadLocalAccounts();
  /** @param {string} rut */
  const localByRut = (rut) => Object.values(locals()).find((a) => a.rut === accountRut(rut)) || null;
  /** @param {string} uid @param {Partial<CuentaLocal>} data */
  function saveLocal(uid, data) {
    const all = locals();
    all[uid] = /** @type {CuentaLocal} */ ({ ...(all[uid] || {}), ...data, uid });
    persist(() => store.saveLocalAccounts(all));
  }
  /** @param {string} uid */
  function removeLocal(uid) {
    const all = locals();
    delete all[uid];
    persist(() => store.saveLocalAccounts(all));
  }
  const saveSession = () => st.token && session.set({ uid: st.user?.id, token: st.token, exp: st.exp });
  function clear() {
    session.set(null);
    st.user = null;
    st.token = null;
    st.acceso = null;
  }
  function markOn() {
    if (st.on) return;
    st.on = true;
    persist(() => store.saveAccountsOn(true));
  }

  /* ---------------------------------------------------------- entrar */

  /**
   * Entra con RUT y clave. Sin conexión, verifica con lo guardado en este PC.
   * @param {string} rut
   * @param {string} password
   * @returns {Promise<{status: 'ok' | 'change' | 'offline', nombre: string}>}
   *   `change`: primer ingreso (o clave restablecida): hay que crear una clave nueva con `changePassword`.
   * @throws {Error} con un mensaje para la persona
   */
  async function login(rut, password) {
    if (!accountRut(rut)) throw new Error('Revisa el RUT (con su dígito verificador).');
    if (!password) throw new Error('Escribe tu clave.');
    let s;
    try {
      s = await api.sal(rut);
    } catch (e) {
      if (/** @type {any} */ (e).status === 0) return offlineLogin(rut, password);
      throw e;
    }
    const sec = await deriveAccountSecrets(password, s.sal, s.iter);
    const r = await api.entrar(rut, sec.acceso);
    const u = r.usuario;
    const teamKey = await unwrapTeamKey(u.envuelta, { envoltura: sec.envoltura, complemento: u.complemento, uid: u.id });
    const perfil = await decryptProfile(await importEncKey(teamKey), u.id, u.perfil);
    // Datos de este PC (ADR 0016): se abren (o se empiezan a cifrar) antes de guardar nada.
    await vault?.unlockOnline({ teamKeyB64: teamKey, uid: u.id, local: sec.local });
    // La clave del equipo queda en este PC para sincronizar (como con la contraseña del equipo).
    const cfg = store.loadSyncConfig();
    if (!cfg || cfg.encKey !== teamKey || cfg.mode !== 'cuenta') {
      persist(() =>
        store.saveSyncConfig({
          encKey: teamKey,
          token: '',
          mode: 'cuenta',
          activatedAt: cfg?.activatedAt || now(),
          lastSync: cfg?.encKey === teamKey ? cfg.lastSync : null,
        }),
      );
    }
    st.token = r.token;
    st.exp = r.exp;
    st.acceso = sec.acceso;
    st.complemento = u.complemento;
    st.user = {
      id: u.id,
      rut: accountRut(rut),
      nombre: perfil.nombre,
      ...nameParts(perfil),
      rol: u.rol,
      admin: u.admin === true,
      offline: false,
    };
    saveLocal(u.id, {
      rut: accountRut(rut),
      sal: s.sal,
      iter: s.iter,
      localHash: localHashOf(sec.local),
      nombre: perfil.nombre,
      ...nameParts(perfil),
      rol: u.rol,
      admin: u.admin === true,
    });
    if (u.debeCambiar) return { status: 'change', nombre: perfil.nombre };
    complete();
    return { status: 'ok', nombre: perfil.nombre };
  }

  /** @param {string} rut @param {string} password */
  async function offlineLogin(rut, password) {
    const local = localByRut(rut);
    if (!local) throw new Error('Sin conexión. Para entrar por primera vez en este PC se necesita internet.');
    const sec = await deriveAccountSecrets(password, local.sal, local.iter);
    if (vault?.state === 'locked') {
      // Con datos cifrados, la clave se comprueba abriendo su estuche.
      const r = await vault.unlockOffline({ uid: local.uid, local: sec.local });
      if (r === 'missing') throw new Error('Sin conexión. Este PC aún no tiene tu llave: entra una vez con conexión.');
      if (r === 'wrong') throw new Error('RUT o clave incorrectos.');
    } else if (localHashOf(sec.local) !== local.localHash) throw new Error('RUT o clave incorrectos.');
    st.user = {
      id: local.uid,
      rut: local.rut,
      nombre: local.nombre,
      ...nameParts(local),
      rol: local.rol,
      admin: local.admin === true,
      offline: true,
    };
    st.acceso = sec.acceso;
    st.token = null;
    complete();
    event('sesion.inicio_local');
    return /** @type {const} */ ({ status: 'offline', nombre: local.nombre });
  }

  /** La sesión quedó lista (tras entrar o crear la clave). */
  function complete() {
    markOn();
    saveSession();
  }

  /**
   * Cambia la clave (primer ingreso, o con la actual) en el servidor y en lo
   * guardado para entrar sin conexión.
   * @param {string} password nueva
   * @param {string} [accesoActual] fuera del primer ingreso
   */
  async function changePassword(password, accesoActual) {
    const cfg = store.loadSyncConfig();
    if (!st.user || !st.token || !st.complemento || !cfg?.encKey) throw new Error('Necesitas conexión para cambiar la clave.');
    const c = await credentialsFor({ password, teamKeyB64: cfg.encKey, uid: st.user.id, complemento: st.complemento, iterations });
    const r = await api.clave(st.token, {
      sal: c.sal,
      iter: c.iter,
      acceso: c.acceso,
      envuelta: c.envuelta,
      ...(accesoActual ? { accesoActual } : {}),
    });
    st.token = r.token;
    st.exp = r.exp;
    st.acceso = c.acceso;
    saveLocal(st.user.id, { sal: c.sal, iter: c.iter, localHash: localHashOf(c.local) });
    await vault?.rewrap({ uid: st.user.id, local: c.local });
    complete();
  }

  /** Cambio de clave voluntario: verifica la actual. @param {string} actual @param {string} nueva */
  async function changeMyPassword(actual, nueva) {
    if (!st.user) throw new Error('No hay sesión.');
    const problem = passwordProblem(nueva, { rut: st.user.rut, current: actual });
    if (problem) throw new Error(problem);
    const s = await api.sal(st.user.rut);
    const cur = await deriveAccountSecrets(actual, s.sal, s.iter);
    await changePassword(nueva, cur.acceso);
  }

  /** Recupera la sesión de esta pestaña (al recargar la página). Con datos cifrados, no: hay que entrar con la clave. */
  function restore() {
    if (vault?.state === 'locked') return false;
    const s = session.get();
    const local = s?.uid ? locals()[s.uid] : null;
    if (!s || !local || !(s.exp > now()) || typeof s.token !== 'string') return false;
    st.token = s.token;
    st.exp = s.exp;
    st.user = {
      id: local.uid,
      rut: local.rut,
      nombre: local.nombre,
      ...nameParts(local),
      rol: local.rol,
      admin: local.admin === true,
      offline: false,
    };
    return true;
  }

  /** Sale: cierra la sesión en el servidor (o la registra si fue sin conexión). @param {'salir' | 'inactividad' | 'cierre'} [motivo] */
  async function logout(motivo = 'salir') {
    if (st.token) await api.salir(st.token, motivo).catch(() => {});
    else if (st.user) event('sesion.fin_local');
    clear();
  }

  /* ------------------------------------------------- token y errores */

  /** Token vigente (null sin conexión o vencido). */
  const token = () => (st.token && st.exp - 30_000 > now() ? st.token : null);

  /**
   * Renueva la sesión sin pedir la clave (al volver la conexión tras entrar
   * sin ella, o al vencer las 12 h), con el `acceso` que quedó en memoria.
   * @returns {Promise<string | null>}
   */
  async function ensureToken() {
    if (token()) return token();
    if (!st.user || !st.acceso) return null;
    try {
      const r = await api.entrar(st.user.rut, st.acceso);
      if (r.usuario?.debeCambiar) {
        hooks.needLogin?.('Tu clave fue restablecida: vuelve a entrar.');
        return null;
      }
      st.token = r.token;
      st.exp = r.exp;
      st.complemento = r.usuario.complemento;
      st.user = { ...st.user, offline: false, admin: r.usuario.admin === true, rol: r.usuario.rol };
      saveLocal(st.user.id, { admin: st.user.admin, rol: st.user.rol });
      saveSession();
      hooks.changed?.();
      return st.token;
    } catch (e) {
      const x = /** @type {any} */ (e);
      if (x.status !== 0) handleAuthError(x.code);
      return null;
    }
  }

  /** Token o error con un mensaje claro (para acciones que necesitan el servidor). */
  async function requireToken() {
    const t = token() || (await ensureToken());
    if (!t) throw new Error('Necesitas conexión a internet para esto.');
    return t;
  }

  /**
   * El servidor rechazó la sesión (o, en un PC con la contraseña del equipo,
   * avisa que las cuentas ya están activadas). Pide entrar cuando hace falta.
   * @param {string} code
   */
  function handleAuthError(code) {
    if (code === 'cuenta_desactivada') {
      if (st.user) removeLocal(st.user.id);
      clear();
      hooks.needLogin?.('Tu cuenta está desactivada. Habla con un administrador.');
      return;
    }
    if (code === 'debe_cambiar_clave') return hooks.needLogin?.('Primero crea tu clave personal.');
    if (!['sesion_invalida', 'credenciales', 'cuentas_inactivas'].includes(code)) return;
    markOn();
    st.token = null;
    session.set(null);
    if (!st.user) return hooks.needLogin?.('Las cuentas de usuario están activadas: entra con tu RUT y clave.');
    // Sesión vencida: se intenta renovar sin molestar (un intento); si no se puede, se pide la clave.
    const acceso = code === 'sesion_invalida' ? st.acceso : null;
    st.acceso = null;
    if (!acceso) {
      st.user = null;
      return hooks.needLogin?.('Tu sesión terminó. Vuelve a entrar.');
    }
    const user = st.user;
    void api
      .entrar(user.rut, acceso)
      .then((r) => {
        st.token = r.token;
        st.exp = r.exp;
        st.acceso = acceso;
        st.complemento = r.usuario.complemento;
        saveSession();
        hooks.renewed?.();
      })
      .catch(() => {
        st.user = null;
        hooks.needLogin?.('Tu sesión terminó. Vuelve a entrar.');
      });
  }

  /** ¿Es la clave de la persona en la sesión? (desbloquear) @param {string} password */
  async function verifyPassword(password) {
    const local = st.user ? locals()[st.user.id] : null;
    if (!local || !password) return false;
    const sec = await deriveAccountSecrets(password, local.sal, local.iter);
    if (localHashOf(sec.local) !== local.localHash) return false;
    st.acceso = sec.acceso;
    return true;
  }

  /* ------------------------------------------------ registro de accesos */

  /**
   * Agrega un evento al registro de accesos (se envía con `flushEvents`).
   * @param {string} ev
   * @param {string} [obj]
   * @param {{n?: number}} [extra]
   */
  function event(ev, obj, extra = {}) {
    if (!st.on || !st.user) return;
    const list = store.loadAccountEvents();
    list.push({ ev, ...(obj ? { obj } : {}), ...extra, at: now(), ...(token() ? {} : { off: true }) });
    persist(() => store.saveAccountEvents(list));
  }

  /** Envía los eventos pendientes (de a 100). @returns {Promise<number>} cuántos se enviaron */
  async function flushEvents() {
    const t = token() || (online() ? await ensureToken() : null);
    const list = store.loadAccountEvents();
    if (!t || !list.length) return 0;
    const batch = list.slice(0, 100);
    try {
      await api.eventos(t, batch);
      persist(() => store.saveAccountEvents(store.loadAccountEvents().slice(batch.length)));
      return batch.length;
    } catch {
      return 0; // se reintenta en la próxima sincronización
    }
  }

  /* --------------------------------------------- activar las cuentas */

  /**
   * Activa las cuentas creando el primer administrador (desde un PC con la
   * contraseña del equipo). Su clave inicial es su RUT sin dígito verificador.
   * @param {import('./accountCrypto.js').PerfilCuenta & {rol: string}} p
   */
  async function activate(p) {
    const cfg = store.loadSyncConfig();
    if (!cfg?.token || cfg.mode === 'cuenta') throw new Error('Primero activa la sincronización con la contraseña del equipo.');
    const uid = newUserId();
    const { complemento } = await api.preparar(cfg.token, uid);
    const c = await credentialsFor({ password: initialPassword(p.rut), teamKeyB64: cfg.encKey, uid, complemento, iterations });
    const perfil = await encryptProfile(await importEncKey(cfg.encKey), uid, {
      nombre: p.nombre,
      ...nameParts(p),
      rut: accountRut(p.rut),
      rol: p.rol,
    });
    await api.activar(cfg.token, {
      id: uid,
      rut: p.rut,
      rol: p.rol,
      perfil,
      sal: c.sal,
      iter: c.iter,
      acceso: c.acceso,
      envuelta: c.envuelta,
    });
    markOn();
  }

  return {
    login,
    changePassword,
    changeMyPassword,
    restore,
    logout,
    token,
    ensureToken,
    requireToken,
    handleAuthError,
    verifyPassword,
    event,
    flushEvents,
    activate,
    /** Las cuentas están activadas (según lo último que supo este PC). */
    get on() {
      return st.on;
    },
    /** El servidor confirmó que hay cuentas. */
    markOn,
    /** @returns {CuentaActiva | null} */
    get user() {
      return st.user;
    },
    /** ¿Hay una sesión esperando crear la clave (primer ingreso)? */
    get pendingChange() {
      return Boolean(st.token && st.user && !session.get());
    },
  };
}
