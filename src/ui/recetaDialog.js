/** Receta para lentes: revisión por paciente, PDF editable e impresión. */
import templateB64 from '../specialties/activa/recetaPlantilla.js';
import { recetaDefaults, validateReceta, buildRecetaPdf, recetaFileName, RECETA_LABELS } from '../core/receta.js';
import { html } from './html.js';
import { base64ToBytes } from './dom.js';
import { openClinicalForm, clinicalInput } from './clinicalForm.js';

/** @param {import('./context.js').AppContext} ctx @param {import('../domain').Atencion} rec @param {HTMLElement} anchor */
export function downloadReceta(ctx, rec, anchor) {
  const initial = recetaDefaults(rec);
  const input = (key, type = 'text') => clinicalInput(initial, key, RECETA_LABELS[key], type);
  return openClinicalForm(ctx, {
    title: 'Receta para lentes',
    initial,
    anchor,
    id: rec.id,
    validate: validateReceta,
    build: (values) => buildRecetaPdf(base64ToBytes(templateB64), values),
    filename: recetaFileName,
    downloadLabel: 'Descargar receta',
    body: html`<p class="muted">Hospital Hanga Roa · Revisa los datos antes de emitir la receta.</p>
      <h4>Paciente</h4><div class="clinical-grid"><div class="span2">${input('paciente_nombre')}</div>${input('paciente_rut')}${input('paciente_edad')}</div>
      <h4>Lejos</h4><div class="receta-grid">${input('lejos_od')}${input('lejos_oi')}${input('lejos_dp')}</div>
      <h4>Cerca</h4><div class="receta-grid">${input('cerca_od')}${input('cerca_oi')}${input('cerca_dp')}</div>
      <h4>Esquema TABO</h4><div class="g2">${input('tabo_eje_od')}${input('tabo_eje_oi')}</div>
      <h4>Profesional y fecha</h4><div class="clinical-grid"><div class="span2">${input('oftalmologo_nombre')}</div><div class="span2">${input('fecha', 'date')}</div></div>
      <p class="hint">Fecha de Rapa Nui. Prescripción óptica manual; DP = distancia pupilar. El PDF conserva sus campos editables y la firma en blanco.</p>`,
  });
}
