/**
 * Permisos por rol en la interfaz (ADR 0014; reglas en core/permissions.js).
 *
 * - Sin permiso de edición clínica (administrativos): la atención se VE pero
 *   no se edita (formulario de solo lectura), no se crean ni eliminan
 *   atenciones con datos clínicos ni adjuntos. El ingreso y los datos del
 *   paciente sí.
 * - Sin permiso de ajustes (quien no es administrador): no se cambian
 *   procedimientos, perfiles, operativos, ni se importan respaldos o se borran datos.
 *
 * Se ocultan los controles (atributo `data-perm`) y, además, se protegen las
 * acciones: aunque un botón quedara visible, la acción no se ejecuta.
 * Sin cuentas (o en el modo práctica) todo está permitido, como antes.
 */
import { can, PERMISSIONS } from '../core/permissions.js';
import { isAttended } from '../core/patient.js';
import { $, toast } from './dom.js';

/** Zonas de la atención que siguen activas en solo lectura (abrir adjuntos, historial, atenciones anteriores). */
const READ_ONLY_KEEP = ['#attCard', '#histCard', '#patPrev', '.toolbar'];

/** @param {any} ctx */
const user = (ctx) => ctx.accounts?.user || null;

/** Aplica los permisos de la persona en la sesión a la interfaz. @param {any} ctx */
export function applyPermissions(ctx) {
  const u = user(ctx);
  const edit = can(u, PERMISSIONS.EDITAR_CLINICO);
  const settings = can(u, PERMISSIONS.AJUSTES);
  document.body.classList.toggle('perm-solo-lectura', !edit);
  document.body.classList.toggle('perm-sin-ajustes', !settings);
  const form = document.getElementById('t-at');
  const controls = form ? [...form.querySelectorAll('input, textarea, select, button')] : [];
  for (const el of /** @type {(HTMLInputElement | HTMLButtonElement)[]} */ (controls)) {
    if (READ_ONLY_KEEP.some((s) => el.closest(s))) continue;
    if (!edit) {
      if (!el.disabled) el.dataset.roDisabled = '1';
      el.disabled = true;
    } else if (el.dataset.roDisabled) {
      el.disabled = false;
      delete el.dataset.roDisabled;
    }
  }
  $('#roBanner').hidden = edit;
}

/**
 * Protege las acciones del contexto según los permisos (además de ocultar los controles).
 * @param {any} ctx
 */
export function guardActions(ctx) {
  const deny = () => {
    toast('Tu perfil puede ver las atenciones, no editarlas.', 4000);
    return undefined;
  };
  const allowed = (perm) => can(user(ctx), perm);
  /** @param {string} name @param {string} perm @param {(...a: any[]) => boolean} [when] permitido también si… */
  const wrap = (name, perm, when) => {
    const fn = ctx[name];
    if (typeof fn !== 'function') return;
    ctx[name] = (/** @type {any[]} */ ...args) => (allowed(perm) || when?.(...args) ? fn(...args) : deny());
  };
  // Guardar sin permiso: no hace nada (el formulario está en solo lectura; el autoguardado no debe avisar).
  const save = ctx.save;
  ctx.save = (/** @type {any[]} */ ...args) => (allowed(PERMISSIONS.EDITAR_CLINICO) ? save(...args) : Promise.resolve(false));
  wrap('newAttention', PERMISSIONS.EDITAR_CLINICO);
  wrap('newAttentionFor', PERMISSIONS.EDITAR_CLINICO);
  wrap('addAttachments', PERMISSIONS.EDITAR_CLINICO);
  wrap('deleteAttachment', PERMISSIONS.EDITAR_CLINICO);
  // Quitar de la lista a alguien aún no atendido (un ingreso por error) es parte del ingreso.
  wrap('deleteRecord', PERMISSIONS.EDITAR_CLINICO, (id) => {
    const r = ctx.records.find((/** @type {any} */ x) => x.id === id);
    return Boolean(r) && !isAttended(r);
  });
  wrap('setProcs', PERMISSIONS.AJUSTES);
}
