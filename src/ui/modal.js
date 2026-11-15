/**
 * Avisos y confirmaciones con la interfaz de la app (reemplazan alert/confirm/prompt).
 * Todas devuelven promesas: `if (await uiConfirm({...})) { ... }`.
 */
import { $ } from './dom.js';
import { html, setHtml, SafeHtml } from './html.js';

const ICONS = {
  info: html`<svg><use href="#i-info"/></svg>`,
  ok: html`<svg><use href="#i-check"/></svg>`,
  warn: html`<svg><use href="#i-alert"/></svg>`,
  danger: html`<svg><use href="#i-alert"/></svg>`,
};

/** Texto plano con saltos de línea como <br> (el texto se escapa). */
const textWithBreaks = (s) =>
  html`${String(s || '')
    .split('\n')
    .map((line, i) => html`${i ? html`<br>` : ''}${line}`)}`;

let pending = null;

/**
 * Muestra el diálogo de mensajes.
 * `html`: plantilla html`…` (los datos interpolados se escapan solos). Si no
 * es una plantilla segura, se muestra como texto.
 * @param {{title: string, message?: string, html?: SafeHtml, tone?: 'info'|'ok'|'warn'|'danger', altLabel?: string,
 *   okLabel?: string, cancelLabel?: string|null, copyText?: string}} o
 * @returns {Promise<any>} true/false (o 'ok'|'alt'|false si hay `altLabel`)
 */
function show(o) {
  const dlg = $('#msgDlg');
  if (pending) pending(false); // cierra un mensaje anterior que siguiera abierto
  const tone = o.tone || 'info';
  dlg.className = 'msgdlg ' + tone;
  setHtml($('#msgIcon'), ICONS[tone] || ICONS.info);
  $('#msgTitle').textContent = o.title;
  setHtml($('#msgText'), o.html instanceof SafeHtml ? o.html : textWithBreaks(o.html ?? o.message));
  const area = $('#msgCopy');
  area.hidden = o.copyText === undefined;
  area.value = o.copyText ?? '';
  const ok = $('#msgOk');
  const cancel = $('#msgCancel');
  const alt = $('#msgAlt');
  alt.hidden = !o.altLabel;
  alt.textContent = o.altLabel || '';
  ok.textContent = o.okLabel || 'Aceptar';
  // Rojo solo para confirmar acciones destructivas; un aviso se cierra con el botón normal.
  ok.className = 'btn ' + (tone === 'danger' && o.cancelLabel ? 'dangerfill' : 'p');
  cancel.hidden = !o.cancelLabel;
  cancel.textContent = o.cancelLabel || '';

  return new Promise((resolve) => {
    const finish = (v) => {
      if (pending !== finish) return;
      pending = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    pending = finish;
    ok.onclick = () => finish(o.altLabel ? 'ok' : true);
    alt.onclick = () => finish('alt');
    cancel.onclick = () => finish(false);
    dlg.oncancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    dlg.showModal();
    if (o.copyText !== undefined) {
      area.focus();
      area.select();
    } else (o.cancelLabel ? cancel : ok).focus();
  });
}

/** Aviso con un solo botón. */
export const uiAlert = (o) => show({ ...o, cancelLabel: null }).then(() => undefined);

/** Confirmación: resuelve true si se acepta. */
export const uiConfirm = (o) => show({ cancelLabel: 'Cancelar', okLabel: 'Continuar', ...o });

/** Muestra un texto seleccionado para copiarlo a mano (si el portapapeles falla). */
export const uiCopy = (o) => show({ tone: 'info', okLabel: 'Listo', ...o, cancelLabel: null }).then(() => undefined);

/**
 * Tres opciones: resuelve 'ok' (botón principal), 'alt' (alternativa) o false (cancelar).
 * @returns {Promise<'ok'|'alt'|false>}
 */
export const uiChoose = (o) => show({ cancelLabel: 'Cancelar', ...o });
