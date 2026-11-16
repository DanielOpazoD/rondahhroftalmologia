/** Revisión de la constancia GES antes de descargar; no cambia la atención. */
import templateB64 from '../specialties/activa/gesPlantilla.js';
import { GES_PATOLOGIAS } from '../specialties/activa/config.js';
import { GES_HOSPITAL, gesDefaults, validateGes, buildGesPdf, gesFileName } from '../core/ges.js';
import { can, PERMISSIONS } from '../core/permissions.js';
import { html, setHtml } from './html.js';
import { base64ToBytes, download, toast } from './dom.js';

/** @param {import('./context.js').AppContext} ctx
 * @param {import('../domain').Atencion} rec
 * @param {HTMLElement} anchor
 */
export async function downloadGes(ctx, rec, anchor) {
  const root = document.documentElement;
  const accountId = ctx.accounts?.user?.id;
  const sessionValid = () =>
    ctx.accounts?.user?.id === accountId &&
    can(ctx.accounts?.user, PERMISSIONS.EDITAR_CLINICO) &&
    !ctx.lock?.state.locked &&
    !root.classList.contains('locked');
  if (!sessionValid()) return;
  const initial = gesDefaults(rec);
  const dlg = document.createElement('dialog');
  dlg.className = 'msgdlg gesdlg';
  dlg.setAttribute('aria-labelledby', 'gesTitle');
  /** @param {keyof typeof initial} key @param {string} label @param {string} [type] */
  const input = (key, label, type = 'text') => html`<label><span class="l">${label}</span>
    <input name="${key}" type="${type}" value="${initial[key]}" autocomplete="off"></label>`;
  setHtml(
    dlg,
    html`<h3 id="gesTitle">Constancia GES</h3>
    <p class="muted">${GES_HOSPITAL.institucion} · ${GES_HOSPITAL.direccion} · ${GES_HOSPITAL.ciudad}</p>
    <form novalidate>
      <label><span class="l">Confirmación diagnóstica GES</span><select name="patologia">
        <option value="">Selecciona una patología</option>
        ${GES_PATOLOGIAS.map((p) => html`<option value="${p}">${p}</option>`)}
      </select></label>
      <p class="muted">Atención presencial. Las firmas se completan en el formulario impreso.</p>
      <h4>Paciente</h4><div class="g2">
        ${input('paciente_nombre', 'Nombre legal')}${input('paciente_rut', 'RUT del paciente')}
        ${input('paciente_social', 'Nombre social (si corresponde)')}${input('paciente_fono', 'Teléfono celular', 'tel')}
        ${input('paciente_direccion', 'Dirección del paciente')}
        <label><span class="l">Previsión</span><select name="prevision"><option value="">Selecciona la previsión</option><option value="fonasa">Fonasa</option><option value="isapre">Isapre</option></select></label>
        ${input('paciente_comuna', 'Comuna')}${input('paciente_region', 'Región')}
        ${input('paciente_correo', 'Correo electrónico (si tiene)', 'email')}
      </div>
      <h4>Profesional que notifica</h4><div class="g2">
        ${input('profesional_nombre', 'Nombre del profesional')}${input('profesional_rut', 'RUT del profesional')}
        ${input('fecha', 'Fecha de notificación', 'date')}${input('hora', 'Hora de notificación', 'time')}
      </div>
      <p class="muted">Fecha y hora de Rapa Nui. Revisa que correspondan al momento de la notificación.</p>
      <details><summary>Representante (si quien toma conocimiento no es el paciente)</summary><div class="g2">
        ${input('representante_nombre', 'Nombre del representante')}${input('representante_rut', 'RUT del representante')}
        ${input('representante_fono', 'Teléfono del representante', 'tel')}${input('representante_correo', 'Correo del representante', 'email')}
      </div></details>
      <p class="msg err" role="alert"></p>
      <div class="dlg-actions"><button type="button" class="btn">Cancelar</button><button type="submit" class="btn p">Descargar constancia GES</button></div>
    </form>`,
  );
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const submit = form.querySelectorAll('button')[1];
  const err = dlg.querySelector('[role="alert"]');
  // Una constancia toma una copia de los datos visibles de esta atención. No
  // consulta ctx.rec después de una espera ni guarda cambios del diálogo.
  const id = rec.id;
  let active = true;
  let dismiss = () => {};
  const invalidate = () => {
    if (!sessionValid()) dismiss();
  };
  const observer = new MutationObserver(invalidate);
  const unsubscribe = ctx.on('cuenta', invalidate);
  await new Promise((resolve) => {
    dismiss = () => {
      if (!active) return;
      active = false;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(undefined);
    };
    dlg.addEventListener('close', dismiss, { once: true });
    dlg.querySelector('button[type="button"]').addEventListener('click', dismiss);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sessionValid()) {
        dismiss();
        return;
      }
      if (submit.disabled) return;
      const values = { ...initial };
      const fields = new FormData(form);
      for (const key of Object.keys(values)) values[key] = String(fields.get(key) || '').trim();
      err.textContent = validateGes(values) || '';
      if (err.textContent) return;
      submit.disabled = true;
      try {
        const bytes = await buildGesPdf(base64ToBytes(templateB64), values);
        if (!active || !sessionValid()) {
          dismiss();
          return;
        }
        download(bytes, gesFileName(values), 'application/pdf');
        if (id) ctx.accounts?.event('atencion.pdf', id);
        toast('Constancia GES descargada');
        dismiss();
      } catch (error) {
        err.textContent = error instanceof Error ? error.message : 'No se pudo generar la constancia GES.';
      } finally {
        submit.disabled = false;
      }
    });
    dlg.showModal();
  });
  observer.disconnect();
  unsubscribe();
  if (sessionValid()) anchor.focus();
}
