/** Revisión y salida de formularios clínicos; descarta los datos al bloquear o salir. */
import { can, PERMISSIONS } from '../core/permissions.js';
import { html, setHtml } from './html.js';
import { download, toast } from './dom.js';

/** PDF visible en el navegador. La impresión apunta al PDF, no a la aplicación. */
function previewPdf(bytes, filename) {
  const dlg = document.createElement('dialog');
  dlg.className = 'msgdlg pdf-preview';
  dlg.setAttribute('aria-label', 'Vista previa del PDF');
  setHtml(
    dlg,
    html`<div class="pdf-preview-head"><h3>Vista previa del PDF</h3><button type="button" class="btn" data-action="close">Volver al formulario</button></div>
    <p class="hint" role="status">Preparando el PDF para imprimir…</p><iframe title="PDF rellenado para imprimir"></iframe>
    <div class="dlg-actions"><button type="button" class="btn" data-action="download">Descargar PDF</button><button type="button" class="btn p" data-action="print" disabled>Imprimir</button></div>`,
  );
  const frame = dlg.querySelector('iframe');
  const printButton = [...dlg.querySelectorAll('button')].find((b) => b.dataset.action === 'print');
  const status = dlg.querySelector('[role="status"]');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  let active = true;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const close = () => {
    if (!active) return;
    active = false;
    if (dlg.open) dlg.close();
    frame.removeAttribute('src');
    dlg.remove();
    URL.revokeObjectURL(url);
    resolveClosed();
  };
  const print = () => {
    if (!active) return;
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      status.textContent = 'PDF listo. Si cerraste el diálogo del navegador, puedes volver a imprimir.';
    } catch {
      status.textContent = 'Este visor no permite imprimir automáticamente. Usa la opción Imprimir del visor o descarga el PDF.';
    }
  };
  frame.addEventListener(
    'load',
    () => {
      if (!active) return;
      printButton.disabled = false;
      print();
    },
    { once: true },
  );
  printButton.addEventListener('click', print);
  dlg.querySelector('[data-action="download"]').addEventListener('click', () => download(bytes, filename, 'application/pdf'));
  dlg.querySelector('[data-action="close"]').addEventListener('click', close);
  dlg.addEventListener('close', close, { once: true });
  dlg.addEventListener('cancel', close, { once: true });
  // Asigna el PDF antes de conectar el iframe: el load de about:blank no debe imprimir una página vacía.
  frame.src = url;
  document.body.appendChild(dlg);
  dlg.showModal();
  return { close, closed };
}

/**
 * @template {Record<string, string>} T
 * @param {import('./context.js').AppContext} ctx
 * @param {{title: string, body: import('./html.js').SafeHtml, initial: T, anchor: HTMLElement, id?: string,
 *   validate: (values: T) => string | null, build: (values: T) => Promise<Uint8Array>, filename: (values: T) => string,
 *   downloadLabel: string, className?: string, setup?: (form: HTMLFormElement) => void}} opts
 */
export async function openClinicalForm(ctx, opts) {
  const root = document.documentElement;
  const accountId = ctx.accounts?.user?.id;
  const sessionValid = () =>
    ctx.accounts?.user?.id === accountId &&
    can(ctx.accounts?.user, PERMISSIONS.EDITAR_CLINICO) &&
    !ctx.lock?.state.locked &&
    !root.classList.contains('locked');
  if (!sessionValid()) return;
  const dlg = document.createElement('dialog');
  dlg.className = `msgdlg clinical-form ${opts.className || ''}`;
  dlg.setAttribute('aria-label', opts.title);
  setHtml(
    dlg,
    html`<h3>${opts.title}</h3><form novalidate>${opts.body}<p class="msg err" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-action="cancel">Cancelar</button><button type="submit" class="btn" value="download">${opts.downloadLabel}</button><button type="submit" class="btn p" value="print">Imprimir</button></div></form>`,
  );
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const submits = [...form.querySelectorAll('button')].filter((b) => b.type === 'submit');
  const err = dlg.querySelector('[role="alert"]');
  let active = true;
  let preview;
  let dismiss = () => {};
  const invalidate = () => {
    if (!sessionValid()) dismiss();
  };
  const observer = new MutationObserver(invalidate);
  const unsubscribe = ctx.on('cuenta', invalidate);
  opts.setup?.(form);
  await new Promise((resolve) => {
    dismiss = () => {
      if (!active) return;
      active = false;
      preview?.close();
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(undefined);
    };
    dlg.addEventListener('close', dismiss, { once: true });
    form.querySelector('[data-action="cancel"]').addEventListener('click', dismiss);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sessionValid()) return dismiss();
      if (submits.some((b) => b.disabled)) return;
      const values = { ...opts.initial };
      const fields = new FormData(form);
      Object.assign(values, Object.fromEntries(Object.keys(values).map((key) => [key, String(fields.get(key) || '').trim()])));
      err.textContent = opts.validate(values) || '';
      if (err.textContent) return;
      submits.forEach((b) => {
        b.disabled = true;
      });
      try {
        const bytes = await opts.build(values);
        if (!active || !sessionValid()) return dismiss();
        if (opts.id) ctx.accounts?.event('atencion.pdf', opts.id);
        if (e.submitter instanceof HTMLButtonElement && e.submitter.value === 'print') {
          preview = previewPdf(bytes, opts.filename(values));
          await preview.closed;
        } else {
          download(bytes, opts.filename(values), 'application/pdf');
          toast(`${opts.title}: PDF descargado`);
          dismiss();
        }
      } catch (error) {
        if (active) err.textContent = error instanceof Error ? error.message : 'No se pudo generar el PDF.';
      } finally {
        submits.forEach((b) => {
          b.disabled = false;
        });
      }
    });
    dlg.showModal();
  });
  observer.disconnect();
  unsubscribe();
  if (sessionValid()) opts.anchor.focus();
}

/** Campo de formulario clínico, siempre con etiqueta asociada. */
export const clinicalInput = (initial, key, label, type = 'text') =>
  html`<label><span class="l">${label}</span><input name="${key}" type="${type}" value="${initial[key]}" autocomplete="off"></label>`;
