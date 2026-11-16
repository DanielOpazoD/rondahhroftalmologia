/**
 * Aviso de versión nueva: la app puede quedar abierta días en un PC. Cada
 * 30 minutos, y al volver a la pestaña (como mucho cada 5 minutos), revisa si
 * hay una versión publicada más nueva y ofrece recargar, sin interrumpir.
 * El borrador se conserva al recargar (y se pregunta si hay cambios sin guardar).
 */
import { $ } from './dom.js';
import { fetchPublishedVersion } from './version.js';

const EVERY_MS = 30 * 60_000;
const MIN_GAP_MS = 5 * 60_000;

/** @param {import('./context.js').AppContext} ctx */
export function startUpdateWatcher(ctx) {
  let last = Date.now(); // recién abierta: ya es la versión publicada
  const bar = $('#updateBar');
  const show = (/** @type {string | undefined} */ version) => {
    $('#updateText').textContent = version ? `Hay una versión nueva de la app (${version}).` : 'Hay una versión nueva de la app.';
    bar.hidden = false;
  };
  ctx.showUpdate = show;
  $('#updateReload').addEventListener('click', () => location.reload());
  $('#updateLater').addEventListener('click', () => {
    bar.hidden = true;
  });
  const check = async () => {
    last = Date.now();
    const r = await fetchPublishedVersion();
    if (r.state === 'newer') show(r.version);
  };
  setInterval(check, EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - last >= MIN_GAP_MS) void check();
  });
  return { check };
}
