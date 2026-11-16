/** Constancia GES: revisión, descarga e impresión del PDF. */
import templateB64 from '../specialties/activa/gesPlantilla.js';
import { GES_PATOLOGIAS } from '../specialties/activa/config.js';
import { GES_HOSPITAL, gesDefaults, validateGes, buildGesPdf, gesFileName } from '../core/ges.js';
import { html } from './html.js';
import { base64ToBytes } from './dom.js';
import { openClinicalForm, clinicalInput } from './clinicalForm.js';
import { clinicalFormValues } from '../core/clinicalForms.js';

/**
 * @param {import('./context.js').AppContext} ctx
 * @param {import('../domain').Atencion} rec
 * @param {HTMLElement} anchor botón que recupera el foco al cerrar
 * @returns {Promise<void>}
 */
export function downloadGes(ctx, rec, anchor) {
  const initial = clinicalFormValues(rec, 'ges', gesDefaults(rec));
  /** @param {string} key @param {string} label @param {string} [type] */
  const input = (key, label, type = 'text') => clinicalInput(initial, key, label, type);
  return openClinicalForm(ctx, {
    title: 'Constancia GES',
    className: 'gesdlg',
    initial,
    anchor,
    id: rec.id,
    remember: (values, previous) => ctx.rememberForm(rec, 'ges', previous, values),
    validate: validateGes,
    build: (values) => buildGesPdf(base64ToBytes(templateB64), values),
    filename: gesFileName,
    downloadLabel: 'Descargar constancia GES',
    body: html`<p class="muted">${GES_HOSPITAL.institucion} · ${GES_HOSPITAL.direccion} · ${GES_HOSPITAL.ciudad}</p>
      <label><span class="l">Confirmación diagnóstica GES</span><select name="patologia"><option value="">Selecciona una patología</option>${GES_PATOLOGIAS.map((p) => html`<option value="${p}">${p}</option>`)}</select></label>
      <h4>Paciente</h4><div class="clinical-grid">
        <div class="span2">${input('paciente_nombre', 'Nombre legal')}</div>${input('paciente_rut', 'RUT del paciente')}${input('paciente_fono', 'Teléfono celular', 'tel')}
        <div class="span2">${input('paciente_direccion', 'Dirección del paciente')}</div>${input('paciente_comuna', 'Comuna')}${input('paciente_region', 'Región')}
        <label><span class="l">Previsión</span><select name="prevision"><option value="">Selecciona</option><option value="fonasa">Fonasa</option><option value="isapre">Isapre</option></select></label>
        ${input('paciente_social', 'Nombre social (opcional)')}<div class="span2">${input('paciente_correo', 'Correo electrónico (si tiene)', 'email')}</div>
      </div>
      <h4>Profesional que notifica</h4><div class="clinical-grid">
        ${input('profesional_nombre', 'Nombre del profesional')}${input('profesional_rut', 'RUT del profesional')}
        ${input('fecha', 'Fecha de notificación', 'date')}${input('hora', 'Hora de notificación', 'time')}
      </div>
      <p class="hint">Fecha y hora de Rapa Nui · Atención presencial · Firmas en el formulario impreso.</p>
      <details><summary>Representante (si corresponde)</summary><div class="clinical-grid">
        ${input('representante_nombre', 'Nombre del representante')}${input('representante_rut', 'RUT del representante')}
        ${input('representante_fono', 'Teléfono del representante', 'tel')}${input('representante_correo', 'Correo del representante', 'email')}
      </div></details>`,
  });
}
