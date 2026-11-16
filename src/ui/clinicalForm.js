/** Formularios clínicos: guarda el borrador por atención y cierra la vista al bloquear o salir. */
import { can, PERMISSIONS } from '../core/permissions.js';
import { patientIdentityKey } from '../core/record.js';
import { html, setHtml } from './html.js';
import { download, toast, required } from './dom.js';

/**
 * PDF visible en el navegador. La impresión apunta al PDF, no a la aplicación.
 * @param {Uint8Array} bytes
 * @param {string} filename nombre al descargarlo
 * @returns {{close: () => void, closed: Promise<void>}}
 */
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
  // Elementos de la plantilla de arriba: siempre están.
  const frame = required(dlg.querySelector('iframe'), 'el visor del PDF');
  const printButton = required(
    [...dlg.querySelectorAll('button')].find((b) => b.dataset.action === 'print'),
    'el botón Imprimir',
  );
  const status = required(dlg.querySelector('[role="status"]'), 'el estado de la vista previa');
  // Los bytes de pdf-lib vienen de un ArrayBuffer normal (nunca compartido): son un BlobPart válido.
  const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (bytes)], { type: 'application/pdf' }));
  let active = true;
  /** @type {() => void} */
  let resolveClosed;
  /** @type {Promise<void>} */
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
    const manual = () => {
      status.textContent = 'Este visor no permite imprimir automáticamente. Usa la opción Imprimir del visor o descarga el PDF.';
    };
    // Sin ventana (el visor ya no está en la página) no se puede imprimir desde aquí.
    const win = frame.contentWindow;
    if (!win) return manual();
    try {
      win.focus();
      win.print();
      status.textContent = 'PDF listo. Si cerraste el diálogo del navegador, puedes volver a imprimir.';
    } catch {
      manual();
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
  required(dlg.querySelector('[data-action="download"]'), 'el botón Descargar').addEventListener('click', () =>
    download(bytes, filename, 'application/pdf'),
  );
  required(dlg.querySelector('[data-action="close"]'), 'el botón Volver').addEventListener('click', close);
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
 * @param {{title: string, body: import('./html.js').SafeHtml, initial: T, anchor: HTMLElement, id?: string | null,
 *   validate: (values: T) => string | null, build: (values: T) => Promise<Uint8Array>, filename: (values: T) => string,
 *   downloadLabel: string, className?: string, setup?: (form: HTMLFormElement) => void,
 *   remember: (values: T, previous: T) => boolean}} opts
 * @returns {Promise<void>}
 */
export async function openClinicalForm(ctx, opts) {
  const root = document.documentElement;
  const accountId = ctx.accounts?.user?.id;
  const patient = patientIdentityKey(ctx.rec);
  let active = true;
  let building = false;
  let revision = 0;
  const sameContext = () =>
    ctx.accounts?.user?.id === accountId &&
    ctx.rec.id === opts.id &&
    ctx.records.some((rec) => rec.id === opts.id) &&
    patientIdentityKey(ctx.rec) === patient &&
    can(ctx.accounts?.user, PERMISSIONS.EDITAR_CLINICO) &&
    !ctx.lock?.state.locked &&
    !root.classList.contains('locked');
  const sessionValid = () => active && sameContext();
  if (!sessionValid()) return;
  const dlg = document.createElement('dialog');
  dlg.className = `msgdlg clinical-form ${opts.className || ''}`;
  dlg.setAttribute('aria-label', opts.title);
  setHtml(
    dlg,
    html`<h3>${opts.title}</h3><form novalidate>${opts.body}<p class="hint" role="status" data-save-status>Los cambios se guardan automáticamente en la atención de este paciente.</p><p class="msg err" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-action="cancel">Cerrar</button><button type="submit" class="btn" value="download">${opts.downloadLabel}</button><button type="submit" class="btn p" value="print">Imprimir</button></div></form>`,
  );
  document.body.appendChild(dlg);
  // Elementos de la plantilla de arriba: siempre están.
  const form = required(dlg.querySelector('form'), 'el formulario');
  const submits = [...form.querySelectorAll('button')].filter((b) => b.type === 'submit');
  const err = required(dlg.querySelector('[role="alert"]'), 'el mensaje de error');
  const saveStatus = required(dlg.querySelector('[data-save-status]'), 'el estado del guardado');
  let previous = { ...opts.initial };
  let pendingSave = false;
  const readValues = () => {
    const fields = new FormData(form);
    return Object.assign(
      { ...opts.initial },
      Object.fromEntries(Object.keys(opts.initial).map((key) => [key, String(fields.get(key) || '')])),
    );
  };
  /** @type {ReturnType<typeof previewPdf> | undefined} */
  let preview;
  let dismiss = () => {};
  const closeIfContextChanged = () => {
    if (!sessionValid()) dismiss();
  };
  const observer = new MutationObserver(closeIfContextChanged);
  const unsubscribe = ctx.on('cuenta', closeIfContextChanged);
  const unsubscribeData = ctx.on('datos', closeIfContextChanged);
  const unsubscribeAttention = ctx.on('atencion', () => {
    if (active) toast('La atención cambió. Abre el formulario para revisar los datos actuales.');
    dismiss();
  });
  for (const [key, value] of Object.entries(opts.initial)) {
    const field = form.elements.namedItem(key);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
      field.value = value;
    }
  }
  opts.setup?.(form);
  const remember = (force = false) => {
    if (!sessionValid()) {
      dismiss();
      return false;
    }
    const values = readValues();
    if (!force && Object.keys(values).every((key) => values[key] === previous[key])) return true;
    if (!opts.remember(values, previous)) {
      pendingSave = true;
      err.textContent = 'No se pudieron guardar los cambios. Revisa el almacenamiento y vuelve a intentarlo.';
      saveStatus.textContent = 'Cambios pendientes de guardar.';
      return false;
    }
    if (pendingSave) err.textContent = '';
    pendingSave = false;
    previous = values;
    saveStatus.textContent = 'Cambios guardados en la atención de este paciente.';
    return true;
  };
  const beforeUnload = (/** @type {BeforeUnloadEvent} */ event) => {
    if (pendingSave && sessionValid() && !remember()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
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
    const requestClose = () => {
      if (building || remember()) dismiss();
    };
    required(form.querySelector('[data-action="cancel"]'), 'el botón Cerrar').addEventListener('click', requestClose);
    dlg.addEventListener('cancel', (event) => {
      event.preventDefault();
      requestClose();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    const edited = () => {
      revision++;
      if (!building) remember();
    };
    form.addEventListener('input', edited);
    form.addEventListener('change', edited);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sessionValid()) return dismiss();
      if (submits.some((b) => b.disabled)) return;
      if (!remember(true)) return;
      const values = readValues();
      Object.assign(values, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])));
      err.textContent = opts.validate(values) || '';
      if (err.textContent) return;
      const outputRevision = revision;
      const controls = [...form.elements].filter(
        (el) => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement,
      );
      const disabled = controls.map((el) => el.disabled);
      building = true;
      controls.forEach((el) => {
        el.disabled = true;
      });
      submits.forEach((b) => {
        b.disabled = true;
      });
      try {
        const bytes = await opts.build(values);
        if (!sessionValid()) return dismiss();
        if (revision !== outputRevision) {
          err.textContent = 'Los datos cambiaron. Revísalos y vuelve a generar el PDF.';
          return;
        }
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
        building = false;
        controls.forEach((el, i) => {
          el.disabled = disabled[i];
        });
        submits.forEach((b) => {
          b.disabled = false;
        });
      }
    });
    dlg.showModal();
  });
  observer.disconnect();
  unsubscribe();
  unsubscribeData();
  unsubscribeAttention();
  window.removeEventListener('beforeunload', beforeUnload);
  if (sameContext()) opts.anchor.focus();
}

/**
 * Campo de formulario clínico, siempre con etiqueta asociada.
 * @param {Record<string, string>} initial valores iniciales del formulario
 * @param {string} key nombre del campo
 * @param {string} label
 * @param {string} [type] tipo de input
 */
export const clinicalInput = (initial, key, label, type = 'text') =>
  html`<label><span class="l">${label}</span><input name="${key}" type="${type}" value="${initial[key]}" autocomplete="off"></label>`;
