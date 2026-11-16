/**
 * Ajustes en secciones: Este equipo · Listas · Datos · Administración (esta
 * última solo para administradores). Patrón de pestañas WAI-ARIA: flechas,
 * Inicio y Fin. La sección elegida se recuerda en la pestaña del navegador.
 */
import { $ } from './dom.js';

const STORE_KEY = 'hhr_ajustes_seccion';
const SECTIONS = ['equipo', 'listas', 'datos', 'admin'];

/** @param {import('./context.js').AppContext} ctx */
export function initSettingsSections(ctx) {
  const tabs = () => /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.ajnav [role="tab"]')]).filter((b) => !b.hidden);
  const isAdmin = () => Boolean(ctx.accounts?.user?.admin);

  /** @param {string} key */
  function show(key) {
    const k = SECTIONS.includes(key) && (key !== 'admin' || isAdmin()) ? key : 'equipo';
    for (const s of SECTIONS) {
      const tab = /** @type {HTMLElement} */ (document.getElementById('ajt-' + s));
      const on = s === k;
      tab.setAttribute('aria-selected', String(on));
      tab.classList.toggle('on', on);
      tab.tabIndex = on ? 0 : -1;
      /** @type {HTMLElement} */ (document.getElementById('aj-' + s)).hidden = !on;
    }
    try {
      sessionStorage.setItem(STORE_KEY, k);
    } catch {
      /* sin sessionStorage: se abre en «Este equipo» */
    }
  }

  function renderAdminTab() {
    $('#ajt-admin').hidden = !isAdmin();
    if (!isAdmin() && !$('#aj-admin').hidden) show('equipo');
  }

  const nav = /** @type {HTMLElement} */ (document.querySelector('.ajnav'));
  nav.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('[data-sec]');
    if (b) show(/** @type {HTMLElement} */ (b).dataset.sec || '');
  });
  nav.addEventListener('keydown', (e) => {
    const list = tabs();
    const i = list.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    if (i < 0) return;
    const next = /** @type {Record<string, number>} */ ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 })[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = list[(next + list.length) % list.length];
    show(t.dataset.sec || '');
    t.focus();
  });

  /**
   * Lleva a un elemento de Ajustes (abre su sección).
   * @param {string} selector
   * @returns {HTMLElement | null}
   */
  ctx.showSettings = (selector) => {
    ctx.showTab('t-aj');
    const el = /** @type {HTMLElement | null} */ (document.querySelector(selector));
    const sec = el?.closest('.ajsec');
    if (sec) show(sec.id.slice(3));
    return el;
  };

  ctx.on('cuenta', renderAdminTab);
  renderAdminTab();
  let saved = '';
  try {
    saved = sessionStorage.getItem(STORE_KEY) || '';
  } catch {
    /* sin sessionStorage */
  }
  show(saved);
}
