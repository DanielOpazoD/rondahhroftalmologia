/**
 * Quién registra: el perfil profesional que está usando este equipo.
 *
 * - El chip del encabezado muestra el perfil y permite cambiarlo.
 * - La primera vez que se guarda algo en una sesión (pestaña del navegador)
 *   se pregunta quién registra, proponiendo el último perfil de este equipo.
 *   Si no hay perfiles creados, no se pregunta nada.
 * - La bitácora guarda ese perfil en cada cambio (además del equipo).
 * - Si el perfil es de un médico, las atenciones nuevas lo traen como médico.
 * - Con cuentas de usuario (ADR 0014) no se pregunta: registra quien entró, y
 *   el chip muestra su nombre con un menú (cambiar clave, bloquear, salir).
 */
import { ESPECIALIDAD } from '../config/catalogs.js';
import { blankRecord } from '../core/record.js';
import { rolLabel } from '../core/catalog.js';
import { $, required } from './dom.js';
import { html, setHtml } from './html.js';
import { openDialog } from './dialog.js';
import { editProfile } from './catalogView.js';
import { syncAttentionView } from './attentionView.js';
import { PRACTICE_PREFIX } from './practice.js';
import { openMenu } from './menu.js';
import { nameParts } from '../core/names.js';

const NEW = '__nuevo';
const SKIP = '__ninguno';
const SESSION_KEY = `${ESPECIALIDAD.prefijo}usuario_sesion`;
/** En el modo práctica, el perfil elegido se guarda aparte (no se mezcla con la sesión real). */
let sessionKey = SESSION_KEY;

/** sessionStorage puede no estar disponible (modo privado estricto): se tolera. */
const session = {
  get() {
    try {
      return sessionStorage.getItem(sessionKey);
    } catch {
      return null;
    }
  },
  /** @param {string} v */
  set(v) {
    try {
      sessionStorage.setItem(sessionKey, v);
    } catch {
      /* sin sesión: se volverá a preguntar */
    }
  },
};

/** @param {import('./context.js').AppContext} ctx */
export function initUserView(ctx) {
  sessionKey = (ctx.practice ? PRACTICE_PREFIX : '') + SESSION_KEY;
  const s = session.get();
  ctx.userId = s && s !== SKIP ? s : null;
  ctx.userAsked = Boolean(s);
  ctx.ensureUser = () => ensureUser(ctx);
  /** Al abrir la app: se pregunta una vez por sesión (si hay perfiles), antes de empezar a escribir. */
  ctx.askUserAtStart = () => ensureUser(ctx);
  $('#userChip').addEventListener('click', (/** @type {MouseEvent} */ e) =>
    ctx.accounts?.user ? accountMenu(ctx, /** @type {HTMLElement} */ (e.currentTarget)) : chooseUser(ctx),
  );
  ctx.on('cuenta', () => renderUserChip(ctx));
  renderUserChip(ctx);
}

/** Chip del encabezado (solo si hay perfiles). @param {import('./context.js').AppContext} ctx */
export function renderUserChip(ctx) {
  const chip = $('#userChip');
  const acc = ctx.accounts?.user;
  if (acc) {
    chip.hidden = false;
    setHtml(chip, html`<svg aria-hidden="true"><use href="#i-user"/></svg><span>${acc.nombre}</span>`);
    chip.title = `Sesión de ${acc.nombre} (${rolLabel(acc.rol)}${acc.admin ? ', administrador/a' : ''}). Clic para opciones.`;
    chip.setAttribute('aria-haspopup', 'menu');
    chip.classList.remove('unset');
    return;
  }
  chip.removeAttribute('aria-haspopup');
  chip.hidden = !ctx.medicos.length;
  const u = ctx.currentUser();
  setHtml(chip, html`<svg aria-hidden="true"><use href="#i-user"/></svg><span>${u ? u.nombre : 'Elegir perfil'}</span>`);
  chip.title = u ? `Registrando como ${u.nombre} (${rolLabel(u.rol)}). Clic para cambiar.` : 'Elegir quién registra';
  chip.classList.toggle('unset', !u);
}

/** Pregunta en curso por contexto: quien llega mientras está abierta espera la misma respuesta. */
const asking = new WeakMap();

/**
 * Pregunta quién registra si aún no se eligió en esta sesión (y hay perfiles).
 * Una sola pregunta a la vez: un segundo diálogo reemplazaría al primero.
 * @param {import('./context.js').AppContext} ctx
 */
async function ensureUser(ctx) {
  if (ctx.accounts?.active || ctx.userAsked || !ctx.medicos.length) return;
  if (!asking.has(ctx)) {
    asking.set(
      ctx,
      chooseUser(ctx).finally(() => asking.delete(ctx)),
    );
  }
  await asking.get(ctx);
}

/**
 * Diálogo para elegir el perfil. Resuelve cuando se cierra.
 * @param {import('./context.js').AppContext} ctx
 * @returns {Promise<void>}
 */
function chooseUser(ctx) {
  return new Promise((resolve) => {
    const suggested = ctx.userId || ctx.store.loadUser() || '';
    /** @type {string | null} */
    let choice = null;
    openDialog({
      title: '¿Quién registra?',
      okLabel: 'Continuar',
      fields: [
        {
          id: 'perfil',
          label: 'Perfil (queda en el historial de cambios)',
          value: ctx.medicos.some((m) => m.id === suggested) ? suggested : ctx.medicos[0]?.id,
          options: [
            ...ctx.medicos.map((m) => ({ value: m.id, label: `${m.nombre} · ${rolLabel(m.rol)}` })),
            { value: NEW, label: '＋ Nuevo perfil…' },
            { value: SKIP, label: 'Prefiero no indicarlo' },
          ],
        },
      ],
      onSave: ({ perfil }) => {
        choice = perfil;
        return null;
      },
      onClose: (saved) => {
        if (!saved) {
          // Cerrar sin elegir: no se vuelve a preguntar en esta sesión.
          if (!ctx.userAsked) setUser(ctx, null);
          return resolve();
        }
        if (choice === NEW) {
          return editProfile(ctx, null, (m) => {
            setUser(ctx, m?.id || null);
            resolve();
          });
        }
        setUser(ctx, choice === SKIP ? null : choice);
        resolve();
      },
    });
  });
}

/**
 * @param {import('./context.js').AppContext} ctx
 * @param {string | null} id perfil elegido (null: sin indicar)
 */
function setUser(ctx, id) {
  ctx.userId = id;
  ctx.userAsked = true;
  session.set(id || SKIP);
  if (id) ctx.store.saveUser(id);
  const u = ctx.currentUser();
  if (u?.rol === 'medico') {
    // Las atenciones nuevas de este equipo traen a este médico.
    ctx.store.saveMedico({ op: ctx.store.loadMedico().op, n: u.nombre, r: u.rut, ...nameParts(u) });
    if (!ctx.rec.id && !ctx.dirty) {
      ctx.rec = blankRecord(ctx.store.loadMedico());
      ctx.snap = structuredClone(ctx.rec);
      syncAttentionView(ctx);
    }
  }
  renderUserChip(ctx);
}

/** Menú de la sesión (con cuentas de usuario). @param {import('./context.js').AppContext} ctx @param {HTMLElement} anchor */
async function accountMenu(ctx, anchor) {
  const choice = await openMenu(
    anchor,
    [
      { value: 'clave', label: 'Cambiar mi clave' },
      { value: 'bloquear', label: 'Bloquear', hint: 'Pide tu clave para volver' },
      { value: 'salir', label: 'Cerrar sesión' },
    ],
    { label: 'Sesión' },
  );
  // Este menú solo existe con cuentas (main.js las crea antes de iniciar las vistas).
  const accounts = required(ctx.accounts, 'ctx.accounts');
  if (choice === 'clave') accounts.changeMyPassword();
  if (choice === 'bloquear') ctx.lock?.lock();
  if (choice === 'salir') void accounts.logout('salir');
}
