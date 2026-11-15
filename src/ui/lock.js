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
 */
import { createLockConfig, verifyPin, verifyRecovery, isLockConfig, lockoutMs, pinProblem, PIN_MINUTES } from '../core/pin.js';
import { $, toast, nextFrame } from './dom.js';
import { html, setHtml } from './html.js';
import { openDialog } from './dialog.js';
import { uiCopy, uiConfirm } from './modal.js';

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input', 'scroll'];
/** Cada cuánto se revisa la inactividad y se comparte la actividad entre pestañas. */
const TICK_MS = 5_000;

/**
 * Mientras está bloqueado, el bloqueo debe quedar SIEMPRE por encima de
 * cualquier otro diálogo modal (avisos de sincronización, «¿Quién registra?»,
 * el chequeo…). Se intercepta showModal: si se abre otro diálogo, el bloqueo
 * se vuelve a abrir encima en el mismo instante (sin intervalos ni saltos de foco).
 */
/** @type {(d: HTMLDialogElement) => void} */
let onAnyModal = () => {};
const nativeShowModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function showModal() {
  nativeShowModal.call(this);
  onAnyModal(this);
};

/** @param {any} ctx contexto de la aplicación (ver ui/context.js) */
export function createLock(ctx) {
  const { store } = ctx;
  const st = {
    config: isLockConfig(store.loadLock()) ? store.loadLock() : null,
    locked: false,
    last: Date.now(),
    waiters: /** @type {(() => void)[]} */ ([]),
  };
  const dlg = $('#lockDlg');
  const root = document.documentElement;
  onAnyModal = (d) => {
    if (st.locked && d !== dlg) {
      dlg.close();
      nativeShowModal.call(dlg);
      $('#lockPin').focus();
    }
  };

  // ----------------------------------------------------------- bloquear
  /** @param {{broadcast?: boolean}} [o] broadcast: avisar a las otras pestañas (lo hace quien bloquea). */
  function lock({ broadcast = true } = {}) {
    if (!st.config || ctx.practice) return;
    st.locked = true;
    // Oculta TODO lo demás, también al imprimir (Ctrl+P) y aunque el diálogo se cierre un instante.
    root.classList.add('locked');
    if (broadcast) ctx.persist(() => store.saveLockSignal(Date.now()));
    $('#lockPin').value = '';
    $('#lockErr').textContent = '';
    $('#lockRecover').hidden = true;
    $('#lockForgot').hidden = false;
    if (!dlg.open) nativeShowModal.call(dlg);
    $('#lockPin').focus();
    render();
  }

  function unlock() {
    st.locked = false;
    st.last = Date.now();
    root.classList.remove('locked');
    if (dlg.open) dlg.close();
    persistFails({ fails: 0, until: 0 });
    render();
    const w = st.waiters.splice(0);
    for (const fn of w) fn();
  }

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

  async function tryUnlock(e) {
    e.preventDefault();
    const wait = waitMessage();
    if (wait) return ($('#lockErr').textContent = wait);
    $('#lockGo').disabled = true;
    await nextFrame(); // deja dibujar el botón deshabilitado (la verificación tarda ~0,3 s)
    const ok = verifyPin(st.config, $('#lockPin').value);
    $('#lockGo').disabled = false;
    if (ok) return unlock();
    failed();
    $('#lockPin').value = '';
    $('#lockErr').textContent = waitMessage() || 'PIN incorrecto.';
    $('#lockPin').focus();
  }

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

  /** Pide el PIN actual (para cambiarlo o quitarlo). */
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
    if (st.config && st.last - shared > TICK_MS) {
      shared = st.last;
      ctx.persist(() => store.saveLockActivity(shared));
    }
  };
  for (const ev of ACTIVITY) document.addEventListener(ev, touch, { capture: true, passive: true });
  const idleCheck = () => {
    if (!st.config || st.locked) return;
    const last = Math.max(st.last, store.loadLockActivity());
    if (Date.now() - last >= st.config.minutes * 60_000) lock();
  };
  setInterval(idleCheck, TICK_MS);
  for (const ev of ['visibilitychange', 'focus', 'pageshow']) window.addEventListener(ev, idleCheck);
  window.addEventListener('storage', (e) => {
    if (e.key === store.lockSignalKey && st.config) lock({ broadcast: false });
  });

  // ----------------------------------------------------------- interfaz
  setHtml($('#pinMinutes'), html`${PIN_MINUTES.map((m) => html`<option value="${m}">${m} min sin uso</option>`)}`);
  $('#pinMinutes').addEventListener('change', (e) => {
    if (st.config) saveConfig({ ...st.config, minutes: Number(e.target.value) });
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
  $('#lockForgot').addEventListener('click', () => {
    $('#lockRecover').hidden = false;
    $('#lockForgot').hidden = true;
    $('#lockCodeLabel').textContent = ctx.sync?.enabled ? 'Código de recuperación o contraseña del equipo' : 'Código de recuperación';
    $('#lockCode').focus();
  });
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // Escape no desbloquea
  // Algunos navegadores cierran el diálogo con un segundo Escape: se reabre en el acto.
  dlg.addEventListener('close', () => {
    if (st.locked && !dlg.open) {
      nativeShowModal.call(dlg);
      $('#lockPin').focus();
    }
  });

  function render() {
    const on = Boolean(st.config);
    $('#pinState').textContent = on ? 'Activo' : 'Desactivado';
    $('#pinSet').textContent = on ? 'Cambiar PIN' : 'Configurar PIN';
    $('#pinOff').hidden = !on;
    $('#pinMinutes').hidden = !on;
    $('#pinMinutesLabel').hidden = !on;
    if (on) $('#pinMinutes').value = String(st.config.minutes);
    $('#lockNow').hidden = !on || ctx.practice;
    $('#pinCard').hidden = ctx.practice;
  }
  render();

  return {
    lock,
    /** Ejecuta `fn` cuando la pantalla esté desbloqueada (de inmediato si ya lo está). */
    whenUnlocked(fn) {
      if (st.locked) st.waiters.push(fn);
      else fn();
    },
    get state() {
      return { enabled: Boolean(st.config), minutes: st.config?.minutes || 0, locked: st.locked };
    },
  };
}
