/**
 * Cabecera adaptable: nada se superpone, con cualquier ancho de pantalla y
 * cualquier largo de nombre de perfil. Si el contenido no cabe, se compacta
 * por pasos (ver styles.css):
 *   1. `hdr-compact`: la marca muestra solo el logo;
 *   2. `hdr-icons`: las pestañas muestran solo su ícono (con nombre accesible).
 * Se recalcula al cambiar el tamaño y cuando cambia el chip de perfil o el
 * estado de sincronización.
 */
const LEVELS = ['hdr-compact', 'hdr-icons'];

export function initHeaderFit() {
  const bar = /** @type {HTMLElement | null} */ (document.querySelector('.topin'));
  if (!bar) return;
  const root = document.documentElement;
  // Cada pestaña muestra su nombre al pasar el mouse cuando solo se ve el ícono.
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('title', b.textContent?.trim() || '');
  const overflowing = () => bar.scrollWidth > bar.clientWidth + 1;
  let queued = false;
  const fit = () => {
    queued = false;
    root.classList.remove(...LEVELS);
    for (const level of LEVELS) {
      if (!overflowing()) break;
      root.classList.add(level);
    }
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(fit);
    }
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(bar);
  window.addEventListener('resize', schedule);
  const right = document.querySelector('.topr');
  if (right) new MutationObserver(schedule).observe(right, { subtree: true, childList: true, characterData: true, attributes: true });
  fit();
}
