/**
 * Diálogo modal simple con campos de texto (usa <dialog> nativo).
 */
import { $ } from './dom.js';
import { html, setHtml } from './html.js';

/**
 * @param {{
 *   title: string,
 *   fields: {id: string, label: string, value?: string, placeholder?: string, type?: string,
 *     options?: {value: string, label: string}[]}[],   // con `options`: lista desplegable
 *   okLabel?: string,
 *   onSave: (values: Record<string, string>) => string | null | void,  // devuelve un mensaje de error para no cerrar
 *   onClose?: (saved: boolean) => void,
 * }} opts
 */
export function openDialog({ title, fields, okLabel = 'Guardar', onSave, onClose }) {
  const dlg = $('#dlg');
  let saved = false;
  $('#dlgTitle').textContent = title;
  $('#dlgErr').textContent = '';
  $('#dlgOk').textContent = okLabel;
  setHtml(
    $('#dlgBody'),
    html`${fields.map((f) =>
      f.options
        ? html`<label class="l" for="dlg_${f.id}">${f.label}</label>
      <select id="dlg_${f.id}">${f.options.map((o) => html`<option value="${o.value}"${o.value === (f.value || '') ? html` selected` : ''}>${o.label}</option>`)}</select>`
        : html`<label class="l" for="dlg_${f.id}">${f.label}</label>
      <input id="dlg_${f.id}" type="${f.type || 'text'}" autocomplete="off" value="${f.value || ''}" placeholder="${f.placeholder || ''}">`,
    )}`,
  );

  const values = () => Object.fromEntries(fields.map((f) => [f.id, $(`#dlg_${f.id}`).value.trim()]));
  // Se notifica el cierre de inmediato (el evento "close" del navegador llega
  // de forma asíncrona y puede retrasarse); `done` evita avisar dos veces.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (dlg.open) dlg.close();
    onClose?.(saved);
  };
  const submit = () => {
    const err = onSave(values());
    if (err) {
      $('#dlgErr').textContent = err;
      return;
    }
    saved = true;
    finish();
  };
  $('#dlgOk').onclick = submit;
  $('#dlgCancel').onclick = finish;
  $('#dlgBody').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };
  dlg.oncancel = finish; // tecla Escape
  // El evento "close" llega después del cierre (asíncrono). Si onClose ya abrió
  // otro diálogo en el mismo <dialog>, ese evento atrasado no debe cerrarlo:
  // un cierre real siempre llega con el diálogo ya cerrado.
  dlg.onclose = () => {
    if (!dlg.open) finish();
  };
  dlg.showModal();
  $(`#dlg_${fields[0].id}`)?.focus();
}
