/**
 * Chequeo antes del operativo: revisa que este equipo esté listo para atender.
 *
 * Como la app se usa de forma ocasional, al abrirla tras 7 días o más sin uso
 * el chequeo aparece solo; también se abre desde Ajustes. Cada punto dice qué
 * revisar y, si hace falta, ofrece la acción para resolverlo.
 */
import { APP } from '../config/catalogs.js';
import { fmtDateTime } from '../core/format.js';
import { onlyDoctors, rolLabel } from '../core/catalog.js';
import { $ } from './dom.js';
import { fetchPublishedVersion } from './version.js';
import { html, setHtml } from './html.js';

const DAY = 24 * 3600 * 1000;
/** Días sin uso a partir de los cuales el chequeo aparece solo al abrir. */
const AUTO_CHECK_DAYS = 7;

/** @typedef {{state: 'ok' | 'warn' | 'bad' | 'info', title: string, text: string, action?: string, actionLabel?: string}} CheckItem */

const ICONS = { ok: '✓', warn: '!', bad: '✗', info: 'i' };

/** Lleva a una tarjeta de Ajustes (abre su sección). @param {import('./context.js').AppContext} ctx @param {string} sel */
const goTo = (ctx, sel) => () => {
  $('#checkDlg').close();
  const el = ctx.showSettings(sel);
  el?.scrollIntoView({ block: 'center' });
  (el?.matches('input, button, select')
    ? el
    : /** @type {HTMLElement | null | undefined} */ (el?.querySelector('input, button, select'))
  )?.focus();
};

/** @param {import('./context.js').AppContext} ctx */
export function initCheckView(ctx) {
  const actions = {
    reload: () => location.reload(),
    sync: goTo(ctx, '#syncCard'),
    device: goTo(ctx, '#setDevice'),
    profiles: goTo(ctx, '#medAdd'),
    ops: goTo(ctx, '#opAdd'),
    pin: goTo(ctx, '#pinCard'),
    backup: () => $('#bkExp').click(),
  };
  $('#checkOpen').addEventListener('click', () => openCheck(ctx));
  $('#checkAgain').addEventListener('click', () => runChecks(ctx));
  $('#checkClose').addEventListener('click', () => $('#checkDlg').close());
  $('#checkList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('button[data-act]'));
    // data-act sale de CheckItem.action; si no es una acción conocida, no hace nada.
    if (b) actions[/** @type {keyof typeof actions} */ (b.dataset.act)]?.();
  });
  if (ctx.practice) $('#practiceEnter').hidden = true;
}

/** Al abrir la app: anota el uso y, tras varios días sin uso, muestra el chequeo. @param {import('./context.js').AppContext} ctx */
export function autoCheck(ctx) {
  const last = ctx.store.loadLastUse();
  ctx.persist(() => ctx.store.saveLastUse(Date.now()));
  if (!ctx.practice && last && Date.now() - last >= AUTO_CHECK_DAYS * DAY) openCheck(ctx, { auto: true });
}

/**
 * Abre el chequeo y lo ejecuta.
 * @param {import('./context.js').AppContext} ctx
 * @param {{auto?: boolean}} [o] `auto`: se abrió solo, tras días sin uso
 * @returns {Promise<CheckItem[]>}
 */
function openCheck(ctx, { auto = false } = {}) {
  $('#checkTitle').textContent = auto ? 'Antes de empezar: chequeo del equipo' : 'Chequeo del equipo';
  if (!$('#checkDlg').open) $('#checkDlg').showModal();
  return runChecks(ctx);
}

/** @param {import('./context.js').AppContext} ctx @returns {Promise<CheckItem[]>} */
async function runChecks(ctx) {
  $('#checkSum').textContent = 'Revisando…';
  setHtml($('#checkList'), html``);
  const items = await collectChecks(ctx);
  const pending = items.filter((i) => i.state === 'warn' || i.state === 'bad').length;
  $('#checkSum').textContent = pending
    ? `${pending} ${pending === 1 ? 'punto por revisar' : 'puntos por revisar'}.`
    : 'Todo listo para el operativo.';
  setHtml(
    $('#checkList'),
    html`${items.map(
      (i) => html`<li class="${i.state}">
        <span class="cmark" aria-hidden="true">${ICONS[i.state]}</span>
        <div class="ctext"><b>${i.title}</b><span>${i.text}</span></div>
        ${i.action ? html`<button type="button" class="btn sm" data-act="${i.action}">${i.actionLabel}</button>` : ''}
      </li>`,
    )}`,
  );
  return items;
}

/** @typedef {import('./context.js').AppContext} Ctx */

/**
 * Revisa cada punto. Separado de la interfaz para poder leerlo de corrido:
 * cada revisión es una función que devuelve sus puntos.
 * @param {Ctx} ctx
 * @returns {Promise<CheckItem[]>}
 */
async function collectChecks(ctx) {
  return [
    await checkVersion(),
    ...(await checkSync(ctx)),
    checkDevice(ctx),
    ...checkPeople(ctx),
    checkOperativo(ctx),
    await checkStorage(ctx),
    ...checkBackup(ctx),
    ...checkLock(ctx),
  ];
}

/**
 * Sincronización (y hora del equipo, que se mide al sincronizar).
 * @param {Ctx} ctx
 * @returns {Promise<CheckItem[]>}
 */
async function checkSync(ctx) {
  const title = 'Sincronización';
  const sync = ctx.sync;
  if (ctx.practice) {
    return [{ state: 'info', title, text: 'No aplica en el modo práctica: los datos de ejemplo quedan solo en este equipo.' }];
  }
  if (!sync?.state.available) {
    return [
      {
        state: 'warn',
        title,
        text: 'No disponible: la app está abierta como archivo. Usa la dirección web para compartir datos entre los PC.',
      },
    ];
  }
  if (!sync.state.configured) {
    return [
      {
        state: 'warn',
        title,
        text: 'No activada: lo que se registre en este PC no llega a los otros.',
        action: 'sync',
        actionLabel: 'Activar',
      },
    ];
  }
  await sync.syncNow();
  const s = sync.state;
  if (s.status === 'offline') {
    return [{ state: 'warn', title, text: 'Sin conexión ahora. Se puede trabajar: se sincroniza al volver internet.' }];
  }
  if (s.status !== 'idle') {
    return [{ state: 'bad', title, text: s.message || 'No se pudo sincronizar.', action: 'sync', actionLabel: 'Revisar' }];
  }
  const clock = s.skewMin
    ? {
        state: /** @type {const} */ ('bad'),
        text: `Difiere ${Math.abs(s.skewMin)} min de la del servidor. Ajústala en el sistema para que el orden de los cambios sea correcto.`,
      }
    : { state: /** @type {const} */ ('ok'), text: 'Correcta.' };
  return [
    { state: 'ok', title, text: `Funciona. Última: ${fmtDateTime(new Date(s.lastSync || Date.now()))}.` },
    { ...clock, title: 'Hora del equipo' },
  ];
}

/** Nombre del equipo (aparece en el historial). @param {Ctx} ctx @returns {CheckItem} */
function checkDevice(ctx) {
  const title = 'Nombre del equipo';
  const device = ctx.settings.deviceName?.trim();
  if (device) return { state: 'ok', title, text: device };
  return {
    state: 'warn',
    title,
    text: `Sin nombre: en el historial aparece como «${ctx.deviceName()}».`,
    action: 'device',
    actionLabel: 'Ponerle nombre',
  };
}

/** @param {number} n */
const medicos = (n) => `${n} ${n === 1 ? 'médico' : 'médicos'}`;

/**
 * Quién registra: con cuentas, la sesión; sin cuentas, los perfiles. Y médicos para el formulario.
 * @param {Ctx} ctx
 * @returns {CheckItem[]}
 */
function checkPeople(ctx) {
  const doctors = onlyDoctors(ctx.medicos).length;
  const acc = ctx.accounts?.user;
  if (acc) {
    // Con cuentas de usuario, quien registra es la persona que entró: no hacen falta perfiles.
    const title = 'Médicos en el formulario';
    return [
      { state: 'ok', title: 'Sesión', text: `${acc.nombre} · ${rolLabel(acc.rol)}${acc.admin ? ' · administrador/a' : ''}.` },
      doctors
        ? { state: 'ok', title, text: medicos(doctors) + '.' }
        : { state: 'info', title, text: 'Aún no hay: cada médico aparece al entrar con su cuenta (o agrégalo en Ajustes → Listas).' },
    ];
  }
  const create = { action: 'profiles', actionLabel: 'Crear' };
  if (!ctx.medicos.length) {
    return [{ state: 'warn', title: 'Perfiles', text: 'No hay perfiles: no quedará registrado quién hizo cada cambio.', ...create }];
  }
  if (!doctors) return [{ state: 'warn', title: 'Perfiles', text: 'No hay perfiles de médico para la atención.', ...create }];
  return [{ state: 'ok', title: 'Perfiles', text: `${ctx.medicos.length} (${medicos(doctors)}).` }];
}

/** @param {Ctx} ctx @returns {CheckItem} */
function checkOperativo(ctx) {
  if (ctx.operativos.length) return { state: 'ok', title: 'Operativo', text: ctx.operativos.map((o) => o.nombre).join(' · ') };
  return { state: 'warn', title: 'Operativo', text: 'No hay operativo creado para esta ronda.', action: 'ops', actionLabel: 'Crear' };
}

/** Respaldo reciente: solo importa sin sincronización (es la única copia). @param {Ctx} ctx @returns {CheckItem[]} */
function checkBackup(ctx) {
  if (ctx.practice || ctx.sync?.state.configured) return [];
  const last = ctx.store.loadLastBackup();
  if (last && Date.now() - last < 7 * DAY) return [{ state: 'ok', title: 'Respaldo', text: `Último: ${fmtDateTime(new Date(last))}.` }];
  const text = last
    ? `El último fue el ${fmtDateTime(new Date(last))}. Sin sincronización, el respaldo es la única copia.`
    : 'Nunca se ha descargado un respaldo en este PC. Sin sincronización, es la única copia.';
  return [{ state: 'warn', title: 'Respaldo', text, action: 'backup', actionLabel: 'Descargar' }];
}

/** Bloqueo por inactividad: el de la sesión (con cuentas) o el PIN. @param {Ctx} ctx @returns {CheckItem[]} */
function checkLock(ctx) {
  if (ctx.practice) return [];
  if (ctx.accounts?.user) {
    return [
      {
        state: 'ok',
        title: 'Bloqueo de la sesión',
        text: `Tras ${ctx.store.loadSessionLockMinutes()} min sin uso se bloquea y pide tu clave.`,
      },
    ];
  }
  const lock = ctx.lock?.state;
  if (lock?.enabled) return [{ state: 'ok', title: 'Bloqueo con PIN', text: `Activo: se bloquea tras ${lock.minutes} min sin uso.` }];
  return [
    {
      state: 'warn',
      title: 'Bloqueo con PIN',
      text: 'Sin bloqueo: cualquiera que use este PC puede ver los pacientes.',
      action: 'pin',
      actionLabel: 'Configurar',
    },
  ];
}

/** ¿Este equipo tiene la versión publicada? @returns {Promise<CheckItem>} */
async function checkVersion() {
  const title = 'Versión de la app';
  const r = await fetchPublishedVersion();
  if (r.state === 'file') {
    return { state: 'info', title, text: `${APP.version}. Abierta como archivo: no se puede comparar con la publicada.` };
  }
  if (r.state === 'offline') return { state: 'warn', title, text: `${APP.version}. Sin conexión: no se pudo comparar con la publicada.` };
  if (r.state === 'error') {
    return { state: 'warn', title, text: `${APP.version}. No se pudo leer la versión publicada (error ${r.status}).` };
  }
  if (r.state === 'newer') {
    return {
      state: 'bad',
      title,
      text: `Hay una versión más nueva (${r.version}). Actualiza para que todos los PC trabajen con la misma.`,
      action: 'reload',
      actionLabel: 'Actualizar',
    };
  }
  return { state: 'ok', title, text: `Al día (${APP.version}).` };
}

/**
 * Almacenamiento: IndexedDB y protección contra el borrado automático del navegador.
 * @param {import('./context.js').AppContext} ctx
 * @returns {Promise<CheckItem>}
 */
async function checkStorage(ctx) {
  const title = 'Almacenamiento';
  const { pending } = ctx.storageHealth();
  if (pending) {
    return {
      state: 'bad',
      title,
      text: `${pending} ${pending === 1 ? 'cambio no se pudo' : 'cambios no se pudieron'} guardar en este equipo. Libera espacio o descarga un respaldo; se reintenta solo.`,
      action: 'backup',
      actionLabel: 'Descargar respaldo',
    };
  }
  if (ctx.storageKind !== 'indexeddb') {
    return { state: 'warn', title, text: 'Limitado (este navegador no permite IndexedDB). Descarga respaldos con frecuencia.' };
  }
  try {
    const persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.());
    if (persisted) return { state: 'ok', title, text: 'Los datos están protegidos contra el borrado automático del navegador.' };
  } catch {
    /* sin la API: se informa abajo */
  }
  return {
    state: 'info',
    title,
    text: 'El navegador podría borrar los datos si le falta espacio. La sincronización o los respaldos los protegen.',
  };
}
