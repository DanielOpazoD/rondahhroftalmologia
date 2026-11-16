/**
 * Cuentas de usuario en el PC (ADR 0014):
 *   - pantalla de ingreso con RUT y clave (encima de todo, como el bloqueo);
 *   - primer ingreso: cambio de clave obligatorio;
 *   - ingreso SIN conexión en un PC donde la persona ya entró;
 *   - cierre de sesión, cambio de clave y bloqueo de la sesión por inactividad;
 *   - activación de las cuentas desde un PC con la contraseña del equipo
 *     (crea el primer administrador);
 *   - cola de eventos del registro de accesos (se envían al haber conexión).
 *
 * Mientras nadie active las cuentas, nada de esto se muestra y la app funciona
 * como siempre (contraseña del equipo). En el modo práctica no hay cuentas.
 */
import { ESPECIALIDAD, ROLES } from '../config/catalogs.js';
import { accountRut, initialPassword, passwordProblem, newUserId, rutBody } from '../core/accounts.js';
import { rolLabel } from '../core/catalog.js';
import { formatRut } from '../core/format.js';
import { sha256, toHex } from '../lib/sha256.js';
import { cryptoAvailable, importEncKey, DecryptError } from '../sync/crypto.js';
import { createAccountsApi } from '../sync/accountsApi.js';
import { deriveAccountSecrets, unwrapTeamKey, decryptProfile, encryptProfile, credentialsFor } from '../sync/accountCrypto.js';
import { blankRecord } from '../core/record.js';
import { makeMedico } from '../core/catalog.js';
import { rutKey } from '../core/format.js';
import { clock } from '../core/clock.js';
import { $, toast, nextFrame } from './dom.js';
import { html, setHtml } from './html.js';
import { addGuard, showGuarded } from './guard.js';
import { openDialog } from './dialog.js';
import { uiAlert, uiConfirm } from './modal.js';
import { practiceUrl } from './practice.js';

const SESSION_KEY = `${ESPECIALIDAD.prefijo}sesion_cuenta_v1`;
const LOCK_MINUTES = [5, 10, 15, 30, 60];

/** sessionStorage puede no estar disponible: sin él, cada recarga pide ingresar. */
const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  },
  /** @param {unknown} v */
  set(v) {
    try {
      if (v) sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* sin sesión guardada */
    }
  },
};

/** Huella del valor `local` (lo que se guarda en el PC para entrar sin conexión). @param {string} local */
const localHashOf = (local) => toHex(sha256(local));

/** Mensaje para un error del servidor de cuentas. @param {any} e */
function messageFor(e) {
  if (e instanceof DecryptError) {
    return 'No se pudo abrir la clave del equipo con esta cuenta. Pide a un administrador que restablezca tu clave.';
  }
  return e?.message || String(e);
}

/**
 * @typedef {{id: string, rut: string, nombre: string, rol: string, admin: boolean, offline: boolean}} CuentaActiva
 */

/** @param {any} ctx contexto de la aplicación (ver ui/context.js) */
export function createAccountsController(ctx) {
  const { store } = ctx;
  const api = createAccountsApi();
  const st = {
    /** Las cuentas están activadas (según lo último que supo este PC). */
    on: store.loadAccountsOn(),
    /** @type {CuentaActiva | null} */
    user: null,
    /** Token de sesión (solo con conexión; vive en sessionStorage). @type {string | null} */
    token: null,
    exp: 0,
    /** Solo en memoria: para renovar la sesión al volver la conexión. @type {string | null} */
    acceso: null,
    /** Solo en memoria: para cambiar la clave. */
    complemento: /** @type {string | null} */ (null),
    showing: false,
    step: /** @type {'login' | 'change'} */ ('login'),
    /** @type {(() => void)[]} */
    waiters: [],
    flushTimer: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined),
  };
  const dlg = $('#loginDlg');
  const root = document.documentElement;
  /** ¿Pueden usarse cuentas aquí? (no en el modo práctica ni con el archivo abierto con doble clic) */
  const usable = () => !ctx.practice && /^https?:$/.test(location.protocol) && cryptoAvailable();

  /* ------------------------------------------------------ cuentas locales */

  /** @param {string} rut */
  const localByRut = (rut) => Object.values(store.loadLocalAccounts()).find((a) => a.rut === accountRut(rut)) || null;
  /** @param {string} uid @param {Record<string, unknown>} data */
  function saveLocal(uid, data) {
    const all = store.loadLocalAccounts();
    all[uid] = { ...(all[uid] || {}), ...data, uid };
    ctx.persist(() => store.saveLocalAccounts(all));
  }
  /** @param {string} uid */
  function removeLocal(uid) {
    const all = store.loadLocalAccounts();
    delete all[uid];
    ctx.persist(() => store.saveLocalAccounts(all));
  }

  /* ---------------------------------------------------- pantalla de ingreso */

  addGuard(
    dlg,
    () => st.showing,
    () => focusStep(),
  );

  function focusStep() {
    if (st.step === 'change') $('#pwNew').focus();
    else if ($('#loginRut').value) $('#loginPass').focus();
    else $('#loginRut').focus();
  }

  /** @param {string} [message] */
  function show(message = '') {
    if (!usable()) return;
    st.showing = true;
    root.classList.add('locked');
    setStep(st.step === 'change' && st.token ? 'change' : 'login');
    $('#loginErr').textContent = message;
    if (!$('#loginRut').value) {
      const locals = Object.values(store.loadLocalAccounts());
      if (locals.length === 1) $('#loginRut').value = formatRut(locals[0].rut);
    }
    if (!dlg.open) showGuarded(dlg);
    focusStep();
  }

  function hide() {
    st.showing = false;
    root.classList.remove('locked');
    if (dlg.open) dlg.close();
  }

  /** @param {'login' | 'change'} step */
  function setStep(step) {
    st.step = step;
    $('#loginForm').hidden = step !== 'login';
    $('#pwForm').hidden = step !== 'change';
    $('#loginFirst').hidden = step !== 'login';
    $('#loginTitle').textContent = step === 'change' ? 'Crea tu clave' : 'Ingresar';
    $('#loginErr').textContent = '';
  }

  /** @param {boolean} on @param {string} [label] */
  async function busy(on, label) {
    for (const id of ['#loginGo', '#pwGo']) {
      const b = $(id);
      b.disabled = on;
      if (on && label) b.dataset.label ||= b.textContent;
      b.textContent = on && label ? label : b.dataset.label || b.textContent;
      if (!on) delete b.dataset.label;
    }
    if (on) await nextFrame(); // la derivación de la clave tarda ~0,3 s
  }

  /** @param {SubmitEvent} e */
  async function submitLogin(e) {
    e.preventDefault();
    const rut = $('#loginRut').value;
    const pass = $('#loginPass').value;
    if (!accountRut(rut)) return void ($('#loginErr').textContent = 'Revisa el RUT (con su dígito verificador).');
    if (!pass) return void ($('#loginErr').textContent = 'Escribe tu clave.');
    $('#loginErr').textContent = '';
    await busy(true, 'Verificando…');
    try {
      let s;
      try {
        s = await api.sal(rut);
      } catch (x) {
        if (/** @type {any} */ (x).status === 0) return await offlineLogin(rut, pass);
        throw x;
      }
      const sec = await deriveAccountSecrets(pass, s.sal, s.iter);
      const r = await api.entrar(rut, sec.acceso);
      await completeLogin(rut, sec, s, r);
    } catch (x) {
      $('#loginErr').textContent = messageFor(x);
      $('#loginPass').select();
    } finally {
      await busy(false);
    }
  }

  /**
   * Sesión iniciada en el servidor: abre la clave del equipo y el perfil.
   * @param {string} rut
   * @param {{acceso: string, envoltura: Uint8Array, local: string}} sec
   * @param {{sal: string, iter: number}} s
   * @param {any} r respuesta de `entrar`
   */
  async function completeLogin(rut, sec, s, r) {
    const u = r.usuario;
    const teamKey = await unwrapTeamKey(u.envuelta, { envoltura: sec.envoltura, complemento: u.complemento, uid: u.id });
    const perfil = await decryptProfile(await importEncKey(teamKey), u.id, u.perfil);
    // La clave del equipo queda en este PC para sincronizar (como con la contraseña del equipo).
    const cfg = store.loadSyncConfig();
    if (!cfg || cfg.encKey !== teamKey || cfg.mode !== 'cuenta') {
      ctx.persist(() =>
        store.saveSyncConfig({
          encKey: teamKey,
          token: '',
          mode: 'cuenta',
          activatedAt: cfg?.activatedAt || Date.now(),
          lastSync: cfg?.encKey === teamKey ? cfg.lastSync : null,
        }),
      );
    }
    st.token = r.token;
    st.exp = r.exp;
    st.acceso = sec.acceso;
    st.complemento = u.complemento;
    st.user = { id: u.id, rut: accountRut(rut), nombre: perfil.nombre, rol: u.rol, admin: u.admin === true, offline: false };
    saveLocal(u.id, {
      rut: accountRut(rut),
      sal: s.sal,
      iter: s.iter,
      localHash: localHashOf(sec.local),
      nombre: perfil.nombre,
      rol: u.rol,
      admin: u.admin === true,
    });
    if (u.debeCambiar) {
      $('#pwHint').textContent = `Hola, ${perfil.nombre}. Es tu primer ingreso: crea tu clave personal.`;
      setStep('change');
      focusStep();
      return;
    }
    finish();
  }

  /** Sin conexión: verifica la clave con lo guardado en este PC. @param {string} rut @param {string} pass */
  async function offlineLogin(rut, pass) {
    const local = localByRut(rut);
    if (!local) {
      $('#loginErr').textContent = 'Sin conexión. Para entrar por primera vez en este PC se necesita internet.';
      return;
    }
    const sec = await deriveAccountSecrets(pass, local.sal, local.iter);
    if (localHashOf(sec.local) !== local.localHash) {
      $('#loginErr').textContent = 'RUT o clave incorrectos.';
      return;
    }
    st.user = { id: local.uid, rut: local.rut, nombre: local.nombre, rol: local.rol, admin: local.admin === true, offline: true };
    st.acceso = sec.acceso;
    st.token = null;
    event('sesion.inicio_local');
    finish();
    toast('Sin conexión: entraste con los datos de este PC. Se sincronizará al volver la conexión.', 5000);
  }

  /** @param {SubmitEvent} e */
  async function submitChange(e) {
    e.preventDefault();
    const p1 = $('#pwNew').value;
    const p2 = $('#pwNew2').value;
    const problem = passwordProblem(p1, { rut: st.user?.rut });
    if (problem) return void ($('#loginErr').textContent = problem);
    if (p1 !== p2) return void ($('#loginErr').textContent = 'Las claves no coinciden.');
    $('#loginErr').textContent = '';
    await busy(true, 'Guardando…');
    try {
      await changePasswordOnServer(p1);
      $('#pwNew').value = '';
      $('#pwNew2').value = '';
      finish();
      toast('Clave guardada. Desde ahora entras con tu clave nueva.', 4000);
    } catch (x) {
      $('#loginErr').textContent = messageFor(x);
    } finally {
      await busy(false);
    }
  }

  /**
   * Cambia la clave en el servidor (y lo guardado para entrar sin conexión).
   * @param {string} password nueva
   * @param {string} [accesoActual] fuera del primer ingreso
   */
  async function changePasswordOnServer(password, accesoActual) {
    const cfg = store.loadSyncConfig();
    if (!st.user || !st.token || !st.complemento || !cfg?.encKey) throw new Error('Necesitas conexión para cambiar la clave.');
    const c = await credentialsFor({ password, teamKeyB64: cfg.encKey, uid: st.user.id, complemento: st.complemento });
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
  }

  /** Sesión lista: se cierra la pantalla y la app sigue con esta cuenta. */
  function finish() {
    hide();
    st.on = true;
    ctx.persist(() => store.saveAccountsOn(true));
    if (st.token) session.set({ uid: st.user?.id, token: st.token, exp: st.exp });
    applyUser();
    const w = st.waiters.splice(0);
    for (const fn of w) fn();
    ctx.sync?.start();
    scheduleFlush();
  }

  /** La persona que entró pasa a ser la que registra (bitácora y médico de las atenciones nuevas). */
  function applyUser() {
    const u = st.user;
    if (!u) return;
    ctx.userAsked = true;
    if (u.rol === 'medico') {
      ctx.store.saveMedico({ ...ctx.store.loadMedico(), n: u.nombre, r: u.rut });
      if (!ctx.rec.id && !ctx.dirty) {
        ctx.rec = blankRecord(ctx.store.loadMedico());
        ctx.snap = structuredClone(ctx.rec);
      }
    }
    ctx.emit('cuenta');
    render();
    ctx.lock?.render();
    // Una sola identidad: la persona de la cuenta queda (o se actualiza) en la lista de
    // profesionales del formulario (campo Médico), que se comparte con los demás PC.
    setTimeout(() => syncProfile(u), 0);
  }

  /** @param {CuentaActiva} u */
  function syncProfile(u) {
    const existing = ctx.medicos.find((/** @type {any} */ m) => rutKey(m.rut) === rutKey(u.rut));
    if (existing && existing.nombre === u.nombre && (existing.rol || 'medico') === u.rol) return;
    const m = makeMedico({ ...(existing || {}), nombre: u.nombre, rut: u.rut, rol: u.rol, updated: clock.tick() });
    if (m) ctx.saveCatalog?.('medico', m);
  }

  /** Recupera la sesión de esta pestaña (al recargar la página). */
  function restore() {
    const s = session.get();
    const local = s?.uid ? store.loadLocalAccounts()[s.uid] : null;
    if (!s || !local || !(s.exp > Date.now()) || typeof s.token !== 'string') return false;
    st.token = s.token;
    st.exp = s.exp;
    st.user = { id: local.uid, rut: local.rut, nombre: local.nombre, rol: local.rol, admin: local.admin === true, offline: false };
    return true;
  }

  /* ----------------------------------------------------------- sesión */

  /**
   * Cierra la sesión y vuelve a la pantalla de ingreso (recarga la página
   * para no dejar datos de la sesión en memoria).
   * @param {'salir' | 'inactividad' | 'cierre'} [motivo]
   */
  async function logout(motivo = 'salir') {
    ctx.flushAutosave?.();
    if (st.token) await api.salir(st.token, motivo).catch(() => {});
    else if (st.user) event('sesion.fin_local');
    session.set(null);
    st.user = null;
    st.token = null;
    st.acceso = null;
    setTimeout(() => location.reload(), 150); // deja terminar de escribir lo pendiente
  }

  /** Token vigente (null sin conexión o vencido). */
  const token = () => (st.token && st.exp - 30_000 > Date.now() ? st.token : null);

  /**
   * Renueva la sesión en el servidor sin pedir la clave (al volver la
   * conexión tras entrar sin ella, o al vencer las 12 h), con el valor
   * `acceso` que quedó en memoria al entrar.
   */
  async function ensureToken() {
    if (token()) return token();
    if (!st.user || !st.acceso) return null;
    try {
      const r = await api.entrar(st.user.rut, st.acceso);
      if (r.usuario?.debeCambiar) {
        show('Tu clave fue restablecida: vuelve a entrar.');
        return null;
      }
      st.token = r.token;
      st.exp = r.exp;
      st.complemento = r.usuario.complemento;
      st.user = { ...st.user, offline: false, admin: r.usuario.admin === true, rol: r.usuario.rol };
      saveLocal(st.user.id, { admin: st.user.admin, rol: st.user.rol });
      session.set({ uid: st.user.id, token: st.token, exp: st.exp });
      render();
      scheduleFlush();
      return st.token;
    } catch (e) {
      const x = /** @type {any} */ (e);
      if (x.status === 0) return null;
      onAuthError(x.code);
      return null;
    }
  }

  /**
   * El servidor rechazó la sesión (o, en un PC con la contraseña del equipo,
   * avisa que las cuentas ya están activadas).
   * @param {string} code
   */
  function onAuthError(code) {
    if (!usable()) return;
    if (code === 'cuenta_desactivada') {
      if (st.user) removeLocal(st.user.id);
      session.set(null);
      st.user = null;
      st.token = null;
      st.acceso = null;
      show('Tu cuenta está desactivada. Habla con un administrador.');
      return;
    }
    if (code === 'debe_cambiar_clave') return show('Primero crea tu clave personal.');
    if (code === 'sesion_invalida' || code === 'credenciales' || code === 'cuentas_inactivas') {
      if (!st.on) {
        st.on = true;
        ctx.persist(() => store.saveAccountsOn(true));
      }
      st.token = null;
      session.set(null);
      if (!st.user) return show('Las cuentas de usuario están activadas: entra con tu RUT y clave.');
      // Sesión vencida: se intenta renovar sin molestar; si no se puede, se pide la clave.
      if (code === 'sesion_invalida' && st.acceso) {
        const acceso = st.acceso;
        st.acceso = null; // un solo intento
        void api
          .entrar(st.user.rut, acceso)
          .then((r) => {
            st.token = r.token;
            st.exp = r.exp;
            st.acceso = acceso;
            st.complemento = r.usuario.complemento;
            session.set({ uid: st.user?.id, token: st.token, exp: st.exp });
            ctx.sync?.schedule();
          })
          .catch(() => {
            st.user = null;
            show('Tu sesión terminó. Vuelve a entrar.');
          });
        return;
      }
      st.user = null;
      show('Tu sesión terminó. Vuelve a entrar.');
    }
  }

  /** ¿Es la clave de la persona que está en la sesión? (desbloquear) @param {string} pass */
  async function verifyPassword(pass) {
    const local = st.user ? store.loadLocalAccounts()[st.user.id] : null;
    if (!local || !pass) return false;
    const sec = await deriveAccountSecrets(pass, local.sal, local.iter);
    if (localHashOf(sec.local) !== local.localHash) return false;
    st.acceso = sec.acceso;
    return true;
  }

  /* ------------------------------------------------ registro de accesos */

  /**
   * Agrega un evento al registro de accesos (se envía al haber conexión).
   * @param {string} ev
   * @param {string} [obj] id del objeto (atención, ficha)
   * @param {{n?: number}} [extra]
   */
  function event(ev, obj, extra = {}) {
    if (!st.on || !st.user) return;
    const list = store.loadAccountEvents();
    list.push({ ev, ...(obj ? { obj } : {}), ...extra, at: Date.now(), ...(token() ? {} : { off: true }) });
    ctx.persist(() => store.saveAccountEvents(list));
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(st.flushTimer);
    st.flushTimer = setTimeout(() => void flushEvents(), 3000);
  }

  async function flushEvents() {
    const t = token() || (navigator.onLine ? await ensureToken() : null);
    const list = store.loadAccountEvents();
    if (!t || !list.length) return;
    const batch = list.slice(0, 100);
    try {
      await api.eventos(t, batch);
      ctx.persist(() => store.saveAccountEvents(store.loadAccountEvents().slice(batch.length)));
      if (list.length > batch.length) scheduleFlush();
    } catch {
      /* se reintenta en la próxima sincronización */
    }
  }

  /* --------------------------------------------- activar (primer administrador) */

  async function activate() {
    const cfg = store.loadSyncConfig();
    if (!cfg?.token || cfg.mode === 'cuenta') return toast('Primero activa la sincronización con la contraseña del equipo.', 4000);
    openDialog({
      title: 'Activar cuentas de usuario',
      okLabel: 'Continuar',
      fields: [
        { id: 'rut', label: 'Tu RUT (serás el primer administrador)', placeholder: '12.345.678-9' },
        { id: 'nombre', label: 'Tu nombre completo' },
        { id: 'rol', label: 'Tu profesión', value: 'medico', options: ROLES.map((r) => ({ value: r.key, label: r.label })) },
      ],
      onSave: ({ rut, nombre, rol }) => {
        if (!accountRut(rut)) return 'RUT inválido (revisa el dígito verificador).';
        if (nombre.length < 3) return 'Escribe tu nombre completo.';
        setTimeout(() => void confirmActivate(cfg, { rut: accountRut(rut), nombre, rol }), 0);
        return null;
      },
    });
  }

  /** @param {{encKey: string, token: string}} cfg @param {{rut: string, nombre: string, rol: string}} p */
  async function confirmActivate(cfg, p) {
    const ok = await uiConfirm({
      title: 'Activar cuentas de usuario',
      message: `Desde ahora, en todos los PC se entrará con RUT y clave, y la contraseña del equipo dejará de servir para sincronizar.\n\nTu cuenta de administrador: ${formatRut(p.rut)}. Tu clave inicial es tu RUT sin dígito verificador (${rutBody(p.rut)}); al entrar te pedirá crear una propia.\n\nGuarda la contraseña del equipo: sigue siendo la llave de respaldo de los datos.`,
      tone: 'warn',
      okLabel: 'Activar',
    });
    if (!ok) return;
    try {
      const uid = newUserId();
      const { complemento } = await api.preparar(cfg.token, uid);
      const c = await credentialsFor({ password: initialPassword(p.rut), teamKeyB64: cfg.encKey, uid, complemento });
      const perfil = await encryptProfile(await importEncKey(cfg.encKey), uid, p);
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
      st.on = true;
      ctx.persist(() => store.saveAccountsOn(true));
      await uiAlert({ title: 'Cuentas activadas', message: 'Entra ahora con tu RUT y tu clave inicial.', tone: 'ok' });
      location.reload();
    } catch (e) {
      uiAlert({ title: 'No se pudieron activar las cuentas', message: messageFor(e), tone: 'danger' });
    }
  }

  /* ---------------------------------------------------- cambiar mi clave */

  function changeMyPassword() {
    if (!token()) return toast('Necesitas conexión para cambiar la clave.', 4000);
    openDialog({
      title: 'Cambiar mi clave',
      okLabel: 'Cambiar',
      fields: [
        { id: 'actual', label: 'Clave actual', type: 'password' },
        { id: 'nueva', label: 'Clave nueva (6 o más, con una mayúscula y un número)', type: 'password' },
        { id: 'nueva2', label: 'Repite la clave nueva', type: 'password' },
      ],
      onSave: ({ actual, nueva, nueva2 }) => {
        const problem = passwordProblem(nueva, { rut: st.user?.rut });
        if (problem) return problem;
        if (nueva !== nueva2) return 'Las claves nuevas no coinciden.';
        setTimeout(async () => {
          try {
            const s = await api.sal(/** @type {CuentaActiva} */ (st.user).rut);
            const cur = await deriveAccountSecrets(actual, s.sal, s.iter);
            await changePasswordOnServer(nueva, cur.acceso);
            toast('Clave cambiada');
          } catch (e) {
            uiAlert({ title: 'No se cambió la clave', message: messageFor(e), tone: 'danger' });
          }
        }, 0);
        return null;
      },
    });
  }

  /* ------------------------------------------------------------ Ajustes */

  /** Estado de las cuentas en el servidor (para mostrar «Activar»). @type {boolean | null} */
  let serverOn = null;

  function render() {
    const card = $('#acctCard');
    const cfg = store.loadSyncConfig();
    const canActivate = usable() && !st.on && serverOn === false && Boolean(cfg?.token) && cfg?.mode !== 'cuenta';
    card.hidden = !(st.user || canActivate);
    $('#acctActivate').hidden = !canActivate;
    $('#acctSession').hidden = !st.user;
    $('#acctState').textContent = st.on ? 'Activas' : 'Sin activar';
    $('#medHint').textContent = st.user
      ? 'Profesionales que aparecen en el campo Médico. Con cuentas de usuario, cada persona se agrega sola al entrar; aquí puedes sumar a quien no tiene cuenta.'
      : 'Médicos y otros profesionales. Cada uno elige su perfil al registrar: el historial de cambios guarda quién hizo cada cambio.';
    if (st.user) {
      const u = st.user;
      setHtml(
        $('#acctWho'),
        html`Sesión de <b>${u.nombre}</b> (${formatRut(u.rut)}) · ${rolLabel(u.rol)}${u.admin ? ' · Administrador/a' : ''}${u.offline ? html` · <span class="state pend">sin conexión</span>` : ''}`,
      );
      $('#acctLockMin').value = String(store.loadSessionLockMinutes());
    }
  }

  function init() {
    setHtml($('#acctLockMin'), html`${LOCK_MINUTES.map((m) => html`<option value="${m}">${m} min sin uso</option>`)}`);
    $('#acctLockMin').addEventListener('change', (e) => ctx.persist(() => store.saveSessionLockMinutes(Number(e.target.value))));
    $('#acctActivateBtn').addEventListener('click', () => void activate());
    $('#acctPass').addEventListener('click', changeMyPassword);
    $('#acctLogout').addEventListener('click', () => void logout('salir'));
    $('#loginForm').addEventListener('submit', submitLogin);
    $('#pwForm').addEventListener('submit', submitChange);
    $('#loginPractice').addEventListener('click', () => location.assign(practiceUrl(true)));
    window.addEventListener('online', () => void ensureToken().then(() => ctx.sync?.schedule()));
    setInterval(() => void flushEvents(), 60_000);
  }

  /** Al abrir la app: recupera la sesión de la pestaña o muestra el ingreso. */
  function start() {
    init();
    if (!usable()) return render();
    if (restore()) applyUser();
    else if (st.on) show();
    render();
    // Pregunta al servidor si las cuentas están activadas (un PC nuevo o con la contraseña del equipo).
    void api
      .estado()
      .then(({ activas }) => {
        serverOn = activas;
        if (activas && !st.on) {
          st.on = true;
          ctx.persist(() => store.saveAccountsOn(true));
        }
        if (activas && !st.user && !st.showing) show();
        render();
      })
      .catch(() => {});
  }

  return {
    start,
    show,
    logout,
    ensureToken,
    onAuthError,
    verifyPassword,
    event,
    flushEvents,
    changeMyPassword,
    render,
    token,
    /** ¿Este PC trabaja con cuentas de usuario? */
    get active() {
      return usable() && st.on;
    },
    /** Persona en la sesión (null si no hay cuentas o aún no entra). */
    get user() {
      return st.user;
    },
    /** Ejecuta `fn` cuando haya sesión (de inmediato si no se usan cuentas o ya hay). */
    whenReady(fn) {
      if (!usable() || !st.on || st.user) fn();
      else st.waiters.push(fn);
    },
  };
}
