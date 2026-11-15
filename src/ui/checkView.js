/**
 * Chequeo antes del operativo: revisa que este equipo esté listo para atender.
 *
 * Como la app se usa de forma ocasional, al abrirla tras 7 días o más sin uso
 * el chequeo aparece solo; también se abre desde Ajustes. Cada punto dice qué
 * revisar y, si hace falta, ofrece la acción para resolverlo.
 */
import { APP } from '../config/catalogs.js';
import { fmtDateTime } from '../core/format.js';
import { onlyDoctors } from '../core/catalog.js';
import { $ } from './dom.js';
import { html, setHtml } from './html.js';

const DAY = 24 * 3600 * 1000;
/** Días sin uso a partir de los cuales el chequeo aparece solo al abrir. */
export const AUTO_CHECK_DAYS = 7;

/** @typedef {{state: 'ok' | 'warn' | 'bad' | 'info', title: string, text: string, action?: string, actionLabel?: string}} CheckItem */

const ICONS = { ok: '✓', warn: '!', bad: '✗', info: 'i' };

/** Lleva a una tarjeta de Ajustes. */
const goTo = (ctx, sel) => () => {
  $('#checkDlg').close();
  ctx.showTab('t-aj');
  const el = $(sel);
  el?.scrollIntoView({ block: 'center' });
  (el?.matches('input, button, select') ? el : el?.querySelector('input, button, select'))?.focus();
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
  $('#checkList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b) actions[b.dataset.act]?.();
  });
  if (ctx.practice) $('#practiceEnter').hidden = true;
}

/** Al abrir la app: anota el uso y, tras varios días sin uso, muestra el chequeo. */
export function autoCheck(ctx) {
  const last = ctx.store.loadLastUse();
  ctx.persist(() => ctx.store.saveLastUse(Date.now()));
  if (!ctx.practice && last && Date.now() - last >= AUTO_CHECK_DAYS * DAY) openCheck(ctx, { auto: true });
}

export function openCheck(ctx, { auto = false } = {}) {
  $('#checkTitle').textContent = auto ? 'Antes de empezar: chequeo del equipo' : 'Chequeo del equipo';
  if (!$('#checkDlg').open) $('#checkDlg').showModal();
  return runChecks(ctx);
}

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

/**
 * Revisa cada punto. Separado de la interfaz para poder leerlo de corrido.
 * @returns {Promise<CheckItem[]>}
 */
export async function collectChecks(ctx) {
  /** @type {CheckItem[]} */
  const out = [];
  /** Agrega un punto (los literales de estado se validan en tiempo de ejecución). */
  const push = (/** @type {any} */ item) => out.push(item);
  push(await checkVersion());

  // Sincronización (y hora del equipo, que se mide al sincronizar).
  const sync = ctx.sync?.state;
  if (ctx.practice) {
    push({
      state: 'info',
      title: 'Sincronización',
      text: 'No aplica en el modo práctica: los datos de ejemplo quedan solo en este equipo.',
    });
  } else if (!sync?.available) {
    push({
      state: 'warn',
      title: 'Sincronización',
      text: 'No disponible: la app está abierta como archivo. Usa la dirección web para compartir datos entre los PC.',
    });
  } else if (!sync.configured) {
    push({
      state: 'warn',
      title: 'Sincronización',
      text: 'No activada: lo que se registre en este PC no llega a los otros.',
      action: 'sync',
      actionLabel: 'Activar',
    });
  } else {
    await ctx.sync.syncNow({ quiet: true });
    const s = ctx.sync.state;
    if (s.status === 'idle') {
      push({ state: 'ok', title: 'Sincronización', text: `Funciona. Última: ${fmtDateTime(new Date(s.lastSync || Date.now()))}.` });
      push(
        s.skewMin
          ? {
              state: 'bad',
              title: 'Hora del equipo',
              text: `Difiere ${Math.abs(s.skewMin)} min de la del servidor. Ajústala en el sistema para que el orden de los cambios sea correcto.`,
            }
          : { state: 'ok', title: 'Hora del equipo', text: 'Correcta.' },
      );
    } else if (s.status === 'offline') {
      push({
        state: 'warn',
        title: 'Sincronización',
        text: 'Sin conexión ahora. Se puede trabajar: se sincroniza al volver internet.',
      });
    } else {
      push({
        state: 'bad',
        title: 'Sincronización',
        text: s.message || 'No se pudo sincronizar.',
        action: 'sync',
        actionLabel: 'Revisar',
      });
    }
  }

  const device = ctx.settings.deviceName?.trim();
  push(
    device
      ? { state: 'ok', title: 'Nombre del equipo', text: device }
      : {
          state: 'warn',
          title: 'Nombre del equipo',
          text: `Sin nombre: en el historial aparece como «${ctx.deviceName()}».`,
          action: 'device',
          actionLabel: 'Ponerle nombre',
        },
  );

  const doctors = onlyDoctors(ctx.medicos).length;
  push(
    !ctx.medicos.length
      ? {
          state: 'warn',
          title: 'Perfiles',
          text: 'No hay perfiles: no quedará registrado quién hizo cada cambio.',
          action: 'profiles',
          actionLabel: 'Crear',
        }
      : !doctors
        ? {
            state: 'warn',
            title: 'Perfiles',
            text: 'No hay perfiles de médico para la atención.',
            action: 'profiles',
            actionLabel: 'Crear',
          }
        : { state: 'ok', title: 'Perfiles', text: `${ctx.medicos.length} (${doctors} ${doctors === 1 ? 'médico' : 'médicos'}).` },
  );
  push(
    ctx.operativos.length
      ? { state: 'ok', title: 'Operativo', text: ctx.operativos.map((o) => o.nombre).join(' · ') }
      : { state: 'warn', title: 'Operativo', text: 'No hay operativo creado para esta ronda.', action: 'ops', actionLabel: 'Crear' },
  );

  push(await checkStorage(ctx));

  if (!ctx.practice && !sync?.configured) {
    const last = ctx.store.loadLastBackup();
    push(
      last && Date.now() - last < 7 * DAY
        ? { state: 'ok', title: 'Respaldo', text: `Último: ${fmtDateTime(new Date(last))}.` }
        : {
            state: 'warn',
            title: 'Respaldo',
            text: last
              ? `El último fue el ${fmtDateTime(new Date(last))}. Sin sincronización, el respaldo es la única copia.`
              : 'Nunca se ha descargado un respaldo en este PC. Sin sincronización, es la única copia.',
            action: 'backup',
            actionLabel: 'Descargar',
          },
    );
  }

  if (!ctx.practice) {
    const lock = ctx.lock?.state;
    push(
      lock?.enabled
        ? { state: 'ok', title: 'Bloqueo con PIN', text: `Activo: se bloquea tras ${lock.minutes} min sin uso.` }
        : {
            state: 'warn',
            title: 'Bloqueo con PIN',
            text: 'Sin bloqueo: cualquiera que use este PC puede ver los pacientes.',
            action: 'pin',
            actionLabel: 'Configurar',
          },
    );
  }
  return out;
}

/** ¿Este equipo tiene la versión publicada? */
async function checkVersion() {
  const title = 'Versión de la app';
  if (location.protocol === 'file:') {
    return { state: 'info', title, text: `${APP.version}. Abierta como archivo: no se puede comparar con la publicada.` };
  }
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return { state: 'warn', title, text: `${APP.version}. No se pudo leer la versión publicada (error ${res.status}).` };
    const pub = await res.json();
    if (APP.build.startsWith('__') || !pub.build || pub.build === APP.build) {
      return { state: 'ok', title, text: `Al día (${APP.version}).` };
    }
    return {
      state: 'bad',
      title,
      text: `Hay una versión más nueva (${pub.version}). Actualiza para que todos los PC trabajen con la misma.`,
      action: 'reload',
      actionLabel: 'Actualizar',
    };
  } catch {
    return { state: 'warn', title, text: `${APP.version}. Sin conexión: no se pudo comparar con la publicada.` };
  }
}

/** Almacenamiento: IndexedDB y protección contra el borrado automático del navegador. */
async function checkStorage(ctx) {
  const title = 'Almacenamiento';
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
