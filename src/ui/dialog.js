/**
 * Diálogo modal simple con campos de texto (usa <dialog> nativo).
 */
import { escapeHtml } from '../core/format.js';
import { $ } from './dom.js';

/**
 * @param {{
 *   title: string,
 *   fields: {id: string, label: string, value?: string, placeholder?: string, type?: string}[],
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
  $('#dlgBody').innerHTML = fields
    .map(
      (f) => `<label class="l" for="dlg_${f.id}">${escapeHtml(f.label)}</label>
      <input id="dlg_${f.id}" type="${f.type || 'text'}" autocomplete="off" value="${escapeHtml(f.value || '')}" placeholder="${escapeHtml(f.placeholder || '')}">`,
    )
    .join('');

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
  dlg.onclose = finish;
  dlg.showModal();
  $(`#dlg_${fields[0].id}`)?.focus();
}
