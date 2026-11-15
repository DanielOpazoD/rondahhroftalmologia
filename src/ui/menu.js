/**
 * Menú desplegable junto a un botón (p. ej. «PDF» / «PDF + adjuntos»).
 * Accesible: rol menu, flechas para moverse, Escape o clic fuera para cerrar,
 * y el foco vuelve al botón.
 */
import { html, setHtml } from './html.js';

/** @typedef {{value: string, label: string, hint?: string, disabled?: boolean}} MenuItem */

/** Menú abierto (solo uno a la vez). @type {(() => void) | null} */
let closeOpen = null;

/**
 * Abre el menú bajo `anchor` y resuelve con el valor elegido (o null).
 * @param {HTMLElement} anchor
 * @param {MenuItem[]} items
 * @param {{label?: string}} [o] nombre del menú para lectores de pantalla
 * @returns {Promise<string | null>}
 */
export function openMenu(anchor, items, { label = 'Opciones' } = {}) {
  closeOpen?.();
  return new Promise((resolve) => {
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    setHtml(
      menu,
      html`${items.map(
        (it) =>
          html`<button type="button" role="menuitem" data-v="${it.value}"${it.disabled ? html` disabled aria-disabled="true"` : ''}>
            <span class="ml">${it.label}</span>${it.hint ? html`<span class="mh">${it.hint}</span>` : ''}
          </button>`,
      )}`,
    );
    document.body.appendChild(menu);
    // Posición: bajo el botón, alineado a su derecha si no cabe (CSSOM, compatible con la CSP).
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const below = r.bottom + 6 + menu.offsetHeight <= innerHeight;
    menu.style.left = `${left}px`;
    menu.style.top = below ? `${r.bottom + 6}px` : `${Math.max(8, r.top - 6 - menu.offsetHeight)}px`;
    anchor.setAttribute('aria-expanded', 'true');

    const buttons = /** @type {HTMLButtonElement[]} */ ([...menu.querySelectorAll('button:not([disabled])')]);
    /** @param {string | null} v */
    const done = (v) => {
      closeOpen = null;
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', cancel);
      menu.remove();
      anchor.setAttribute('aria-expanded', 'false');
      anchor.focus();
      resolve(v);
    };
    const cancel = () => done(null);
    /** @param {PointerEvent} e */
    const outside = (e) => {
      if (!menu.contains(/** @type {Node} */ (e.target))) {
        // Un clic en el mismo botón solo cierra (no vuelve a abrir).
        if (anchor.contains(/** @type {Node} */ (e.target))) e.stopPropagation();
        cancel();
      }
    };
    menu.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button[data-v]');
      if (b && !(/** @type {HTMLButtonElement} */ (b).disabled)) done(/** @type {HTMLElement} */ (b).dataset.v || null);
    });
    menu.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = buttons.length;
        buttons[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus();
      }
    });
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    window.addEventListener('resize', cancel);
    closeOpen = cancel;
    buttons[0]?.focus();
  });
}
