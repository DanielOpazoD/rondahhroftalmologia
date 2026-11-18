/**
 * Cuentas de usuario: la INTERFAZ (ADR 0014). La lógica de la sesión (entrar,
 * crear la clave, renovar, salir, activar, registro de accesos) está en
 * sync/accountSession.js, sin pantalla; aquí solo:
 *   - la pantalla de ingreso (encima de todo, como el bloqueo) y la de crear la clave;
 *   - la tarjeta «Cuentas de usuario» de Ajustes (sesión, activar);
 *   - lo que cambia en la app al entrar (quién registra, médico por omisión).
 *
 * Mientras nadie active las cuentas, nada de esto se muestra y la app funciona
 * como siempre (contraseña del equipo). En el modo práctica no hay cuentas.
 */
import { nameParts, personName } from '../core/names.js';
import { profileNameFields, profileNameValues } from './patientFields.js';
import { ESPECIALIDAD, ROLES } from '../config/catalogs.js';
import { accountRut, passwordProblem, rutBody, PASSWORD_RULES } from '../core/accounts.js';
import { rolLabel, makeMedico } from '../core/catalog.js';
import { formatRut, rutKey } from '../core/format.js';
import { blankRecord } from '../core/record.js';
import { clock } from '../core/clock.js';
import { cryptoAvailable } from '../sync/crypto.js';
import { createAccountsApi } from '../sync/accountsApi.js';
import { createAccountSession, errorMessage } from '../sync/accountSession.js';
import { $, toast, nextFrame } from './dom.js';
import { html, setHtml } from './html.js';
import { addGuard, showGuarded } from './guard.js';
import { openDialog } from './dialog.js';
import { uiAlert, uiConfirm } from './modal.js';
import { practiceUrl } from './practice.js';
import { TOPICS } from './events.js';

const SESSION_KEY = `${ESPECIALIDAD.prefijo}sesion_cuenta_v1`;
const LOCK_MINUTES = [5, 10, 15, 30, 60];

/** Sesión de la pestaña: sessionStorage (puede no estar disponible: entonces cada recarga pide ingresar). */
const tabSession = {
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

/**
 * @param {import('./context.js').AppContext} ctx contexto de la aplicación (ver ui/context.js)
 * @param {{vault?: import('../sync/accountSession.js').LlavePc}} [o] llave que cifra los datos de este PC (ADR 0016)
 * @returns {import('./contract').AccountsService}
 */
export function createAccountsController(ctx, { vault } = {}) {
  const { store } = ctx;
  const api = createAccountsApi();
  const ui = {
    showing: false,
    step: /** @type {'login' | 'change'} */ ('login'),
    /** @type {(() => void)[]} */
    waiters: [],
    flushTimer: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined),
    /** Estado de las cuentas en el servidor (para mostrar «Activar»). @type {boolean | null} */
    serverOn: /** @type {boolean | null} */ (null),
  };
  const session = createAccountSession({
    api,
    store,
    vault,
    session: tabSession,
    persist: (fn) => ctx.persist(fn),
    online: () => navigator.onLine,
    hooks: {
      needLogin: (message) => show(message),
      changed: () => render(),
      renewed: () => ctx.sync?.schedule(),
    },
  });
  const dlg = $('#loginDlg');
  const root = document.documentElement;
  /** ¿Pueden usarse cuentas aquí? (no en el modo práctica ni con el archivo abierto con doble clic) */
  const usable = () => !ctx.practice && /^https?:$/.test(location.protocol) && cryptoAvailable();

  /* ---------------------------------------------------- pantalla de ingreso */

  addGuard(
    dlg,
    () => ui.showing,
    () => focusStep(),
  );

  function focusStep() {
    if (ui.step === 'change') $('#pwNew').focus();
    else if ($('#loginRut').value) $('#loginPass').focus();
    else $('#loginRut').focus();
  }

  /** @param {string} [message] */
  function show(message = '') {
    if (!usable()) return;
    ui.showing = true;
    root.classList.add('locked');
    setStep(ui.step === 'change' && session.pendingChange ? 'change' : 'login');
    $('#loginErr').textContent = message;
    if (!$('#loginRut').value) {
      const locals = Object.values(store.loadLocalAccounts());
      if (locals.length === 1) $('#loginRut').value = formatRut(locals[0].rut);
    }
    if (!dlg.open) showGuarded(dlg);
    focusStep();
  }

  function hide() {
    ui.showing = false;
    root.classList.remove('locked');
    if (dlg.open) dlg.close();
  }

  /** @param {'login' | 'change'} step */
  function setStep(step) {
    ui.step = step;
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
    $('#loginErr').textContent = '';
    await busy(true, 'Verificando…');
    try {
      const r = await session.login($('#loginRut').value, $('#loginPass').value);
      if (r.status === 'change') {
        $('#pwHint').textContent = r.weak
          ? `Hola, ${r.nombre}. Tu clave no cumple las nuevas reglas de seguridad: crea una nueva.`
          : `Hola, ${r.nombre}. Es tu primer ingreso: crea tu clave personal.`;
        setStep('change');
        focusStep();
        return;
      }
      finish();
      if (r.status === 'offline') toast('Sin conexión: entraste con los datos de este PC. Se sincronizará al volver la conexión.', 5000);
    } catch (x) {
      $('#loginErr').textContent = errorMessage(x);
      $('#loginPass').select();
    } finally {
      await busy(false);
    }
  }

  /** @param {SubmitEvent} e @returns {Promise<void>} */
  async function submitChange(e) {
    e.preventDefault();
    const p1 = $('#pwNew').value;
    const problem = passwordProblem(p1, { rut: session.user?.rut });
    if (problem) return void ($('#loginErr').textContent = problem);
    if (p1 !== $('#pwNew2').value) return void ($('#loginErr').textContent = 'Las claves no coinciden.');
    $('#loginErr').textContent = '';
    await busy(true, 'Guardando…');
    try {
      await session.changePassword(p1);
      $('#pwNew').value = '';
      $('#pwNew2').value = '';
      finish();
      toast('Clave guardada. Desde ahora entras con tu clave nueva.', 4000);
    } catch (x) {
      $('#loginErr').textContent = errorMessage(x);
    } finally {
      await busy(false);
    }
  }

  /** Sesión lista: se cierra la pantalla y la app sigue con esta cuenta. */
  function finish() {
    hide();
    applyUser();
    const w = ui.waiters.splice(0);
    for (const fn of w) fn();
    ctx.sync?.start();
    scheduleFlush();
  }

  /** La persona que entró pasa a ser la que registra (bitácora y médico de las atenciones nuevas). */
  function applyUser() {
    const u = session.user;
    if (!u) return;
    ctx.userAsked = true;
    if (u.rol === 'medico') {
      store.saveMedico({ op: store.loadMedico().op, n: u.nombre, r: u.rut, ...nameParts(u) });
      if (!ctx.rec.id && !ctx.dirty) {
        ctx.rec = blankRecord(store.loadMedico());
        ctx.snap = structuredClone(ctx.rec);
      }
    }
    ctx.emit(TOPICS.CUENTA);
    render();
    ctx.lock?.render();
    // Una sola identidad: la persona de la cuenta queda (o se actualiza) en la lista de
    // profesionales del formulario (campo Médico), que se comparte con los demás PC.
    setTimeout(() => syncProfile(u), 0);
  }

  /** @param {import('../sync/accountSession.js').CuentaActiva} u */
  function syncProfile(u) {
    const existing = ctx.medicos.find((m) => rutKey(m.rut) === rutKey(u.rut));
    if (
      existing &&
      existing.nombre === u.nombre &&
      JSON.stringify(nameParts(existing)) === JSON.stringify(nameParts(u)) &&
      (existing.rol || 'medico') === u.rol
    ) {
      return;
    }
    const m = makeMedico({ ...(existing || {}), nombre: u.nombre, ...nameParts(u), rut: u.rut, rol: u.rol, updated: clock.tick() });
    if (m) ctx.saveCatalog?.('medico', m);
  }

  /**
   * Cierra la sesión y vuelve a la pantalla de ingreso (recarga la página
   * para no dejar datos de la sesión en memoria).
   * @param {'salir' | 'inactividad' | 'cierre'} [motivo]
   */
  async function logout(motivo = 'salir') {
    ctx.flushAutosave?.();
    await session.logout(motivo);
    setTimeout(() => location.reload(), 150); // deja terminar de escribir lo pendiente
  }

  /* ------------------------------------------------ registro de accesos */

  /** @param {string} ev @param {string} [obj] @param {{n?: number}} [extra] */
  function event(ev, obj, extra) {
    session.event(ev, obj, extra);
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(ui.flushTimer);
    ui.flushTimer = setTimeout(/** @returns {undefined} */ () => void session.flushEvents().then((n) => n && scheduleFlush()), 3000);
  }

  /* --------------------------------------------- activar (primer administrador) */

  function activate() {
    const cfg = store.loadSyncConfig();
    if (!cfg?.token || cfg.mode === 'cuenta') return toast('Primero activa la sincronización con la contraseña del equipo.', 4000);
    openDialog({
      title: 'Activar cuentas de usuario',
      okLabel: 'Continuar',
      fields: [
        { id: 'rut', label: 'Tu RUT (serás el primer administrador)', placeholder: '12.345.678-9' },
        ...profileNameFields(),
        { id: 'rol', label: 'Tu profesión', value: 'medico', options: ROLES.map((r) => ({ value: r.key, label: r.label })) },
      ],
      onSave: (values) => {
        const { rut, rol } = values;
        const parts = profileNameValues(values);
        const nombre = personName(parts);
        if (!accountRut(rut)) return 'RUT inválido (revisa el dígito verificador).';
        if (nombre.length < 3) return 'Escribe tu nombre completo.';
        setTimeout(/** @returns {undefined} */ () => void confirmActivate({ rut: accountRut(rut), nombre, ...parts, rol }), 0);
        return null;
      },
    });
  }

  /** @param {import('../sync/accountCrypto.js').PerfilCuenta & {rol: string}} p */
  async function confirmActivate(p) {
    const ok = await uiConfirm({
      title: 'Activar cuentas de usuario',
      message: `Desde ahora, en todos los PC se entrará con RUT y clave, y la contraseña del equipo dejará de servir para sincronizar.\n\nTu cuenta de administrador: ${formatRut(p.rut)}. Tu clave inicial es tu RUT sin dígito verificador (${rutBody(p.rut)}); al entrar te pedirá crear una propia.\n\nGuarda la contraseña del equipo: sigue siendo la llave de respaldo de los datos.`,
      tone: 'warn',
      okLabel: 'Activar',
    });
    if (!ok) return;
    try {
      await session.activate(p);
      await uiAlert({ title: 'Cuentas activadas', message: 'Entra ahora con tu RUT y tu clave inicial.', tone: 'ok' });
      location.reload();
    } catch (e) {
      uiAlert({ title: 'No se pudieron activar las cuentas', message: errorMessage(e), tone: 'danger' });
    }
  }

  /* ---------------------------------------------------- cambiar mi clave */

  function changeMyPassword() {
    if (!session.token()) return toast('Necesitas conexión para cambiar la clave.', 4000);
    openDialog({
      title: 'Cambiar mi clave',
      okLabel: 'Cambiar',
      fields: [
        { id: 'actual', label: 'Clave actual', type: 'password' },
        { id: 'nueva', label: 'Clave nueva (8 o más, con una mayúscula, un número y un símbolo)', type: 'password' },
        { id: 'nueva2', label: 'Repite la clave nueva', type: 'password' },
      ],
      onSave: ({ actual, nueva, nueva2 }) => {
        const problem = passwordProblem(nueva, { rut: session.user?.rut, current: actual });
        if (problem) return problem;
        if (nueva !== nueva2) return 'Las claves nuevas no coinciden.';
        setTimeout(async () => {
          try {
            await session.changeMyPassword(actual, nueva);
            toast('Clave cambiada');
          } catch (e) {
            uiAlert({ title: 'No se cambió la clave', message: errorMessage(e), tone: 'danger' });
          }
        }, 0);
        return null;
      },
    });
  }

  /* ------------------------------------------------------------ Ajustes */

  /** ¿Se ofrece activar las cuentas? (servidor sin activar y PC con la contraseña del equipo) */
  function canActivate() {
    const cfg = store.loadSyncConfig();
    return usable() && !session.on && ui.serverOn === false && Boolean(cfg?.token) && cfg?.mode !== 'cuenta';
  }

  /** Quién está en la sesión: nombre, RUT, profesión y estado. @param {NonNullable<typeof session.user>} u */
  function renderWho(u) {
    setHtml(
      $('#acctWho'),
      html`Sesión de <b>${u.nombre}</b> (${formatRut(u.rut)}) · ${rolLabel(u.rol)}${u.admin ? ' · Administrador/a' : ''}${u.offline ? html` · <span class="state pend">sin conexión</span>` : ''}`,
    );
  }

  function render() {
    const u = session.user;
    const canActivateHere = canActivate();
    $('#acctCard').hidden = !(u || canActivateHere);
    $('#acctActivate').hidden = !canActivateHere;
    $('#acctSession').hidden = !u;
    $('#acctState').textContent = session.on ? 'Activas' : 'Sin activar';
    $('#medHint').textContent = u
      ? 'Profesionales que aparecen en el campo Médico. Con cuentas de usuario, cada persona se agrega sola al entrar; aquí puedes sumar a quien no tiene cuenta.'
      : 'Médicos y otros profesionales. Cada uno elige su perfil al registrar: el historial de cambios guarda quién hizo cada cambio.';
    if (u) {
      renderWho(u);
      $('#acctLockMin').value = String(store.loadSessionLockMinutes());
    }
  }

  function init() {
    $('#pwRules').textContent = PASSWORD_RULES; // una sola fuente para la regla
    setHtml($('#acctLockMin'), html`${LOCK_MINUTES.map((m) => html`<option value="${m}">${m} min sin uso</option>`)}`);
    $('#acctLockMin').addEventListener('change', (/** @type {Event} */ e) =>
      ctx.persist(() => store.saveSessionLockMinutes(Number(/** @type {HTMLSelectElement} */ (e.target).value))),
    );
    $('#acctActivateBtn').addEventListener('click', activate);
    $('#acctPass').addEventListener('click', changeMyPassword);
    $('#acctLogout').addEventListener('click', /** @returns {undefined} */ () => void logout('salir'));
    $('#loginForm').addEventListener('submit', submitLogin);
    $('#pwForm').addEventListener('submit', submitChange);
    $('#loginPractice').addEventListener('click', () => location.assign(practiceUrl(true)));
    window.addEventListener('online', /** @returns {undefined} */ () => void session.ensureToken().then(() => ctx.sync?.schedule()));
    setInterval(/** @returns {undefined} */ () => void session.flushEvents(), 60_000);
  }

  /** Al abrir la app: recupera la sesión de la pestaña o muestra el ingreso. */
  function start() {
    init();
    if (!usable()) return render();
    if (session.restore()) applyUser();
    else if (session.on) show();
    render();
    // Pregunta al servidor si las cuentas están activadas (un PC nuevo o con la contraseña del equipo).
    void api
      .estado()
      .then(({ activas }) => {
        ui.serverOn = activas;
        if (activas) session.markOn();
        if (activas && !session.user && !ui.showing) show();
        render();
      })
      .catch(() => {});
  }

  return {
    start,
    show,
    logout,
    render,
    event,
    changeMyPassword,
    token: session.token,
    ensureToken: session.ensureToken,
    requireToken: session.requireToken,
    verifyPassword: session.verifyPassword,
    flushEvents: session.flushEvents,
    /** El servidor rechazó la sesión: se pide entrar si hace falta. @param {string} code */
    onAuthError: (code) => usable() && session.handleAuthError(code),
    /** ¿Este PC trabaja con cuentas de usuario? */
    get active() {
      return usable() && session.on;
    },
    /** Persona en la sesión (null si no hay cuentas o aún no entra). */
    get user() {
      return session.user;
    },
    /** Ejecuta `fn` cuando haya sesión (de inmediato si no se usan cuentas o ya hay). @param {() => void} fn */
    whenReady(fn) {
      if (!usable() || !session.on || session.user) fn();
      else ui.waiters.push(fn);
    },
  };
}
