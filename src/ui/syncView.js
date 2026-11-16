/**
 * Sincronización en la pantalla (Ajustes → Este equipo y la insignia del
 * encabezado). El motor está en syncController.js; esta vista dibuja su
 * estado y traduce los botones en llamadas al motor.
 */
import { fmtDateTime } from '../core/format.js';
import { generatePassphrase } from '../sync/crypto.js';
import { STATUS_LABELS } from './syncController.js';
import { $, toast, copyText, required } from './dom.js';
import { uiAlert, uiConfirm } from './modal.js';
import { html } from './html.js';

/**
 * El motor de sincronización: main.js lo asigna antes de iniciar esta vista.
 * @param {import('./context.js').AppContext} ctx
 */
const syncOf = (ctx) => required(ctx.sync, 'ctx.sync (main.js lo asigna antes de iniciar la vista)');

/** @param {import('./context.js').AppContext} ctx */
export function initSyncView(ctx) {
  $('#syncGen').addEventListener('click', () => {
    $('#syncPass').value = generatePassphrase();
    $('#syncPass').type = 'text';
  });
  $('#syncShow').addEventListener('click', () => ($('#syncPass').type = $('#syncPass').type === 'password' ? 'text' : 'password'));
  $('#syncOn').addEventListener('click', /** @returns {undefined} */ () => void activate(ctx));
  $('#syncOff').addEventListener('click', async () => {
    const ok = await uiConfirm({
      title: 'Desactivar sincronización',
      message: 'Los datos de este PC se conservan, pero sus cambios dejarán de compartirse con los otros equipos.',
      tone: 'warn',
      okLabel: 'Desactivar',
    });
    if (ok) syncOf(ctx).deactivate();
  });
  $('#syncNowBtn').addEventListener('click', async () => {
    const r = await syncOf(ctx).syncNow();
    if (!r) return;
    if ('error' in r) return toast(r.error, 4000);
    toast(
      r.got ? `Sincronizado: ${r.got} ${r.got === 1 ? 'cambio recibido' : 'cambios recibidos'} de otros equipos` : 'Sincronizado',
      r.got ? 3500 : 1800,
    );
  });
  $('#syncCopyHash').addEventListener('click', async () =>
    toast((await copyText(syncOf(ctx).state.hash)) ? 'Valor copiado' : 'No se pudo copiar'),
  );
  $('#syncBadge').addEventListener('click', () => ctx.showSettings('#syncCard'));
}

/** Activa la sincronización con la contraseña escrita. @param {import('./context.js').AppContext} ctx */
async function activate(ctx) {
  const r = await syncOf(ctx).activate($('#syncPass').value);
  if (!r) return;
  if (r.status === 'invalid' || r.status === 'error') return toast(r.message, 4000);
  if (r.status === 'wrong') {
    $('#syncPass').select();
    return uiAlert({
      title: 'Contraseña incorrecta',
      tone: 'danger',
      html: html`Esta no es la contraseña del equipo. El servidor ya tiene una configurada: escribe <b>la misma que usan los otros PC</b>; no generes una nueva.<br><br>Si nadie la tiene, hay que reemplazarla en el servidor (ver «Cambiar la contraseña» en la documentación).`,
    });
  }
  $('#syncPass').value = '';
  if (!r.serverReady) {
    $('#syncActive details.setup').open = true;
    return uiAlert({
      title: 'Falta configurar el servidor',
      tone: 'warn',
      html: html`La sincronización quedó activa en este PC, pero el servidor aún no tiene contraseña. Copia el valor de <b>Configuración del servidor</b> y créalo en Netlify como <code>SYNC_TOKEN_SHA256</code>; luego vuelve a publicar el sitio.`,
    });
  }
  toast('Sincronización activada en este PC');
}

/** Dibuja el estado de la sincronización. @param {import('./context.js').AppContext} ctx */
export function renderSyncView(ctx) {
  const s = ctx.sync?.state;
  if (!s) return;
  // El controlador solo usa estos estados (ver STATUS_LABELS en syncController.js).
  const label = STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (s.status)];
  const on = s.configured;
  $('#syncUnavailable').hidden = s.available;
  $('#syncUnavailable').textContent = ctx.practice
    ? 'En el modo práctica no hay sincronización: los datos de ejemplo quedan solo en este equipo.'
    : 'La sincronización solo funciona al abrir la app desde su dirección web (https). Con el archivo abierto con doble clic, usa el respaldo.';
  const acc = Boolean(ctx.accounts?.active);
  // Con cuentas de usuario, la sincronización va con la sesión: no hay contraseña del equipo que configurar.
  $('#syncSetup').hidden = on || !s.available || acc;
  $('#syncOff').hidden = acc;
  $('#syncActive details.setup').hidden = acc;
  ctx.accounts?.render(); // «Activar cuentas» depende de que haya contraseña del equipo
  renderPassSetup(s.server === 'unconfigured');
  $('#syncActive').hidden = !on || !s.available;
  $('#syncState').textContent = label;
  renderBadge(s, label);
  if (on) {
    $('#syncInfo').textContent = syncInfoText(s);
    $('#syncHash').textContent = s.hash;
  }
}

/**
 * Textos del formulario de contraseña. «Generar» solo en la primera
 * configuración: si el servidor ya tiene contraseña, generar otra solo
 * produce una que no coincide.
 * @param {boolean} firstSetup si el servidor aún no tiene contraseña
 */
function renderPassSetup(firstSetup) {
  $('#syncGen').hidden = !firstSetup;
  $('#syncPassLabel').textContent = firstSetup ? 'Nueva contraseña del equipo' : 'Contraseña del equipo';
  $('#syncSetupHint').textContent = firstSetup
    ? 'Primera configuración: genera la contraseña del equipo, anótala en un lugar seguro y actívala. Luego se usa la misma en todos los PC.'
    : 'Escribe la contraseña del equipo, la misma de los otros PC (formato XXXXX-XXXXX-XXXXX-XXXXX). Si se pierde, los datos del servidor no se pueden descifrar.';
}

/**
 * Insignia del encabezado con el estado de la sincronización.
 * @param {import('./context.js').SyncState} s
 * @param {string} label texto del estado (STATUS_LABELS)
 */
function renderBadge(s, label) {
  const badge = $('#syncBadge');
  badge.hidden = !s.configured || !s.available;
  badge.className = 'syncBadge ' + s.status;
  badge.textContent = s.status === 'idle' ? 'Sincronizado' : label;
  badge.title = s.message || (s.lastSync ? 'Última sincronización: ' + fmtDateTime(new Date(s.lastSync)) : '');
}

/**
 * Detalle de la sincronización activa: última vez, mensaje y desfase de la hora.
 * @param {import('./context.js').SyncState} s
 */
function syncInfoText(s) {
  return (
    (s.lastSync ? `Última sincronización: ${fmtDateTime(new Date(s.lastSync))}.` : 'Aún no se ha sincronizado.') +
    (s.message ? ' ' + s.message : '') +
    (s.skewMin ? ` Atención: la hora de este equipo difiere ${Math.abs(s.skewMin)} min de la del servidor; ajústala.` : '')
  );
}
