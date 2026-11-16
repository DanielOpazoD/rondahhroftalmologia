/**
 * Íconos de la interfaz: referencias al sprite SVG de index.html (`#i-<nombre>`).
 * Un solo lugar para dibujarlos (decorativos: aria-hidden; el nombre lo da el botón).
 */
import { html } from './html.js';

/** @param {string} name p. ej. 'trash', 'edit', 'pdf' */
export const icon = (name) => html`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
