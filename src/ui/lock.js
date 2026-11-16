/**
 * Bloqueo de pantalla con PIN (por equipo).
 *
 * - Se bloquea al abrir la app, tras N minutos sin uso y con el botón del
 *   candado. Mientras está bloqueada, la pantalla de bloqueo cubre todo (fondo
 *   opaco) y queda por encima de cualquier otro diálogo.
 * - Si se olvida el PIN: el código de recuperación entregado al configurarlo
 *   o, con la sincronización activa, la contraseña del equipo. Desbloquear
 *   así quita el PIN (hay que configurar uno nuevo).
 * - Es una protección de pantalla: no cifra los datos guardados (ver core/pin.js).
 * - Con cuentas de usuario (ADR 0014) el bloqueo es de la SESIÓN: pide la
 *   clave de la persona (verificada en el PC) y no usa el PIN del equipo.
 */
import { createLockConfig, verifyPin, verifyRecovery, isLockConfig, lockoutMs, pinProblem, PIN_MINUTES } from '../core/pin.js';
import { $, toast, nextFrame } from './dom.js';
import { html, setHtml } from './html.js';
import { openDialog } from './dialog.js';
import { uiCopy, uiConfirm } from './modal.js';
import { addGuard, showGuarded } from './guard.js';

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input', 'scroll'];
/** Cada cuánto se revisa la inactividad y se comparte la actividad entre pestañas. */
const TICK_MS = 5_000;

/** @param {import('./context.js').AppContext} ctx */
export function createLock(ctx) {
  const { store } = ctx;
  const st = {
    // isLockConfig ya validó la forma de lo guardado.
    config: /** @type {import('../core/pin.js').LockConfig | null} */ (isLockConfig(store.loadLock()) ? store.loadLock() : null),
    locked: false,
    last: Date.now(),
    waiters: /** @type {(() => void)[]} */ ([]),
  };
  const dlg = $('#lockDlg');
  const root = document.documentElement;
  // Mientras está bloqueado, queda SIEMPRE por encima de cualquier otro diálogo.
  addGuard(
    dlg,
    () => st.locked,
    () => $('#lockPin').focus(),
  );
  /** Cuentas, si hay una sesión iniciada (el bloqueo es de la sesión); si no, null (PIN del equipo). */
  const session = () => (ctx.accounts?.user ? ctx.accounts : null);
  /** ¿Bloqueo de la sesión de una cuenta (en vez del PIN del equipo)? */
  const accountMode = () => Boolean(session());
  /** Configuración vigente: la de la cuenta (solo minutos) o la del PIN. */
  const cfg = () => (accountMode() ? { minutes: store.loadSessionLockMinutes() } : st.config);

  // ----------------------------------------------------------- bloquear
  /** @param {{broadcast?: boolean}} [o] broadcast: avisar a las otras pestañas (lo hace quien bloquea). */
  function lock({ broadcast = true } = {}) {
    if (!cfg() || ctx.practice || st.locked) return;
    st.locked = true;
    const user = ctx.accounts?.user;
    const acc = Boolean(user);
    $('#lockTitle').textContent = acc ? 'Sesión bloqueada' : 'Equipo bloqueado';
    $('#lockHint').textContent = user
      ? `Ingresa tu clave, ${user.nombre}, para continuar.`
      : 'Ingresa el PIN de este equipo para continuar.';
    const input = $('#lockPin');
    input.inputMode = acc ? 'text' : 'numeric';
    input.maxLength = acc ? 128 : 8;
    input.placeholder = acc ? 'Clave' : 'PIN';
    if (acc) input.removeAttribute('pattern');
    else input.setAttribute('pattern', '[0-9]*');
    $('#lockPinLabel').textContent = acc ? 'Clave' : 'PIN';
    $('#lockForgot').textContent = acc ? 'Cerrar sesión (entrar con otra cuenta)' : 'Olvidé el PIN';
    session()?.event('sesion.bloqueo');
    // Oculta TODO lo demás, también al imprimir (Ctrl+P) y aunque el diálogo se cierre un instante.
    root.classList.add('locked');
    if (broadcast) ctx.persist(() => store.saveLockSignal(Date.now()));
    $('#lockPin').value = '';
    $('#lockErr').textContent = '';
    $('#lockRecover').hidden = true;
    $('#lockForgot').hidden = false;
    if (!dlg.open) showGuarded(dlg);
    $('#lockPin').focus();
    render();
  }

  function unlock() {
    if (st.locked) session()?.event('sesion.desbloqueo');
    st.locked = false;
    st.last = Date.now();
    root.classList.remove('locked');
    if (dlg.open) dlg.close();
    persistFails({ fails: 0, until: 0 });
    render();
    const w = st.waiters.splice(0);
    for (const fn of w) fn();
  }

  /** @param {{fails: number, until: number}} f intentos fallidos y hasta cuándo esperar */
  const persistFails = (f) => ctx.persist(() => store.saveLockFails(f));

  /** Si hay que esperar por intentos fallidos, el mensaje; si no, null. */
  function waitMessage() {
    const { until } = store.loadLockFails();
    const s = Math.ceil((until - Date.now()) / 1000);
    return s > 0 ? `Demasiados intentos. Espera ${s >= 60 ? Math.ceil(s / 60) + ' min' : s + ' s'} e intenta de nuevo.` : null;
  }

  function failed() {
    const f = store.loadLockFails();
    const fails = f.fails + 1;
    persistFails({ fails, until: Date.now() + lockoutMs(fails) });
  }

  /** @param {Event} e envío del formulario */
  async function tryUnlock(e) {
    e.preventDefault();
    const wait = waitMessage();
    if (wait) return ($('#lockErr').textContent = wait);
    $('#lockGo').disabled = true;
    await nextFrame(); // deja dibujar el botón deshabilitado (la verificación tarda ~0,3 s)
    const accounts = session();
    const ok = accounts ? await accounts.verifyPassword($('#lockPin').value) : verifyPin(st.config, $('#lockPin').value);
    $('#lockGo').disabled = false;
    if (ok) return unlock();
    failed();
    $('#lockPin').value = '';
    $('#lockErr').textContent = waitMessage() || (accountMode() ? 'Clave incorrecta.' : 'PIN incorrecto.');
    $('#lockPin').focus();
  }

  /** @param {Event} e envío del formulario */
  async function tryRecover(e) {
    e.preventDefault();
    const wait = waitMessage();
    if (wait) return ($('#lockErr').textContent = wait);
    const code = $('#lockCode').value.trim();
    $('#lockRecoverGo').disabled = true;
    await nextFrame();
    const ok = verifyRecovery(st.config, code) || (await ctx.sync?.verifyTeamPassword?.(code));
    $('#lockRecoverGo').disabled = false;
    if (!ok) {
      failed();
      $('#lockErr').textContent = waitMessage() || 'Código incorrecto.';
      return;
    }
    removeConfig();
    unlock();
    toast('PIN quitado. Configura uno nuevo en Ajustes → Bloqueo con PIN.', 6000);
  }

  // ----------------------------------------------------------- configurar
  /** @param {import('../core/pin.js').LockConfig} config @returns {boolean} true si se guardó */
  function saveConfig(config) {
    if (!ctx.persist(() => store.saveLock(config))) return false;
    st.config = config;
    render();
    return true;
  }
  function removeConfig() {
    ctx.persist(() => {
      store.saveLock(null);
      store.saveLockFails({ fails: 0, until: 0 });
    });
    st.config = null;
    render();
  }

  /** Pide el PIN actual (para cambiarlo o quitarlo). @param {string} title @param {() => void} done si es correcto */
  function askCurrent(title, done) {
    openDialog({
      title,
      okLabel: 'Continuar',
      fields: [{ id: 'pin', label: 'PIN actual', type: 'password' }],
      onSave: ({ pin }) => (verifyPin(st.config, pin) ? null : 'PIN incorrecto'),
      onClose: (saved) => saved && setTimeout(done, 0),
    });
  }

  function setPin() {
    const minutes = st.config?.minutes;
    let recovery = '';
    openDialog({
      title: st.config ? 'Nuevo PIN' : 'Configurar PIN',
      fields: [
        { id: 'pin', label: 'PIN (4 a 8 números)', type: 'password' },
        { id: 'pin2', label: 'Repite el PIN', type: 'password' },
      ],
      onSave: ({ pin, pin2 }) => {
        const problem = pinProblem(pin);
        if (problem) return problem;
        if (pin !== pin2) return 'Los PIN no coinciden';
        const r = createLockConfig(pin, minutes);
        if (!saveConfig(r.lock)) return 'No se pudo guardar';
        recovery = r.recoveryCode;
        return null;
      },
      onClose: (saved) => {
        if (!saved) return;
        st.last = Date.now();
        setTimeout(
          () =>
            uiCopy({
              title: 'Código de recuperación',
              message:
                'Anótalo y guárdalo junto a la contraseña del equipo. Sirve para desbloquear este PC si se olvida el PIN. No se vuelve a mostrar.',
              copyText: recovery,
            }),
          0,
        );
      },
    });
  }

  // ----------------------------------------------------------- inactividad
  // La actividad se comparte entre pestañas: trabajar en una no deja que otra
  // (inactiva) bloquee a todas, y el bloqueo de una bloquea las demás.
  let shared = 0;
  const touch = () => {
    if (st.locked) return;
    st.last = Date.now();
    if (cfg() && st.last - shared > TICK_MS) {
      shared = st.last;
      ctx.persist(() => store.saveLockActivity(shared));
    }
  };
  for (const ev of ACTIVITY) document.addEventListener(ev, touch, { capture: true, passive: true });
  const idleCheck = () => {
    const c = cfg();
    if (!c || st.locked) return;
    const last = Math.max(st.last, store.loadLockActivity());
    if (Date.now() - last >= c.minutes * 60_000) lock();
  };
  setInterval(idleCheck, TICK_MS);
  for (const ev of ['visibilitychange', 'focus', 'pageshow']) window.addEventListener(ev, idleCheck);
  window.addEventListener('storage', (e) => {
    if (e.key === store.lockSignalKey && cfg()) lock({ broadcast: false });
  });

  // ----------------------------------------------------------- interfaz
  setHtml($('#pinMinutes'), html`${PIN_MINUTES.map((m) => html`<option value="${m}">${m} min sin uso</option>`)}`);
  $('#pinMinutes').addEventListener('change', (/** @type {Event} */ e) => {
    if (st.config) saveConfig({ ...st.config, minutes: Number(/** @type {HTMLSelectElement} */ (e.target).value) });
  });
  $('#pinSet').addEventListener('click', () => (st.config ? askCurrent('Cambiar PIN', setPin) : setPin()));
  $('#pinOff').addEventListener('click', () =>
    askCurrent('Quitar PIN', async () => {
      const ok = await uiConfirm({
        title: 'Quitar el bloqueo',
        message: 'Este equipo dejará de bloquearse: cualquiera que lo use podrá ver los pacientes.',
        tone: 'warn',
        okLabel: 'Quitar',
      });
      if (ok) removeConfig();
    }),
  );
  $('#lockNow').addEventListener('click', () => lock());
  $('#lockForm').addEventListener('submit', tryUnlock);
  $('#lockRecover').addEventListener('submit', tryRecover);
  $('#lockForgot').addEventListener(
    'click',
    /** @returns {void} */ () => {
      const accounts = session();
      if (accounts) return void accounts.logout('salir');
      $('#lockRecover').hidden = false;
      $('#lockForgot').hidden = true;
      $('#lockCodeLabel').textContent = ctx.sync?.enabled ? 'Código de recuperación o contraseña del equipo' : 'Código de recuperación';
      $('#lockCode').focus();
    },
  );

  function render() {
    const { config } = st;
    const on = Boolean(config);
    $('#pinState').textContent = on ? 'Activo' : 'Desactivado';
    $('#pinSet').textContent = on ? 'Cambiar PIN' : 'Configurar PIN';
    $('#pinOff').hidden = !on;
    $('#pinMinutes').hidden = !on;
    $('#pinMinutesLabel').hidden = !on;
    if (config) $('#pinMinutes').value = String(config.minutes);
    $('#lockNow').hidden = !(on || accountMode()) || ctx.practice;
    // Con cuentas, el bloqueo es de la sesión (Ajustes → Cuentas); el PIN del equipo no se usa.
    $('#pinCard').hidden = ctx.practice || accountMode();
  }
  render();

  return {
    lock,
    render,
    /** Ejecuta `fn` cuando la pantalla esté desbloqueada (de inmediato si ya lo está). @param {() => void} fn */
    whenUnlocked(fn) {
      if (st.locked) st.waiters.push(fn);
      else fn();
    },
    get state() {
      return { enabled: Boolean(st.config), minutes: st.config?.minutes || 0, locked: st.locked };
    },
  };
}
