/** IPD autocompletado y editable, con catálogo GES completo por área. */
import templateB64 from '../specialties/activa/ipdPlantilla.js';
import { GES_AREAS, GES_SUBGRUPOS } from '../config/gesCatalog.js';
import { IPD_HOSPITAL, ipdDefaults, validateIpd, buildIpdPdf, ipdFileName } from '../core/ipd.js';
import { NAME_PARTS, personName, hasNameParts } from '../core/names.js';
import { SEXOS } from '../config/catalogs.js';
import { html, setHtml } from './html.js';
import { base64ToBytes } from './dom.js';
import { openClinicalForm, clinicalInput } from './clinicalForm.js';

/** @param {import('./context.js').AppContext} ctx @param {import('../domain').Atencion} rec @param {HTMLElement} anchor */
export function downloadIpd(ctx, rec, anchor) {
  const initial = ipdDefaults(rec);
  const input = (key, label, type = 'text') => clinicalInput(initial, key, label, type);
  const names = (prefix) =>
    html`<div class="clinical-names">${NAME_PARTS.map((k, i) => input(prefix + k, ['Apellido paterno', 'Apellido materno', 'Nombres'][i]))}</div>`;
  const legacy = (prefix) =>
    !hasNameParts(rec.f, prefix) && personName(rec.f, prefix)
      ? html`<p class="hint">Nombre anterior: ${personName(rec.f, prefix)}. Completa sus campos separados.</p>`
      : '';
  const areaOptions = GES_AREAS.map(
    (g) => html`<optgroup label="${g.area}">${g.problemas.map((p) => html`<option value="${p.id}">${p.titulo}</option>`)}</optgroup>`,
  );
  return openClinicalForm(ctx, {
    title: 'IPD · Informe del proceso diagnóstico',
    className: 'ipddlg',
    initial,
    anchor,
    id: rec.id,
    validate: validateIpd,
    build: (values) => buildIpdPdf(base64ToBytes(templateB64), values),
    filename: ipdFileName,
    downloadLabel: 'Descargar IPD',
    body: html`<p class="muted">Servicio de Salud ${IPD_HOSPITAL.servicio} · ${IPD_HOSPITAL.establecimiento}</p>
      <div class="ipd-columns"><div>
        <h4>Paciente</h4>${legacy('paciente_')}<fieldset class="clinical-fieldset"><legend class="sr">Paciente</legend>${names('paciente_')}
        <div class="clinical-names">${input('paciente_rut', 'RUT del paciente')}${input('paciente_fnac', 'Fecha de nacimiento', 'date')}
        <label><span class="l">Sexo</span><select name="paciente_sexo"><option value="">Sin informar</option>${SEXOS.map((s) => html`<option value="${s.key}"${initial.paciente_sexo === s.key ? html` selected` : ''}>${s.label}</option>`)}</select></label></div></fieldset>
        <h4>Profesional</h4>${legacy('medico_')}<fieldset class="clinical-fieldset"><legend class="sr">Profesional</legend>${names('profesional_')}${input('profesional_rut', 'RUT del profesional')}</fieldset>
        <h4>Informe · hora de Rapa Nui</h4><div class="clinical-names">${input('fecha', 'Fecha del informe', 'date')}${input('hora', 'Hora del informe', 'time')}${input('folio', 'Folio (opcional)')}</div>
        <details><summary>Datos administrativos opcionales</summary><div class="clinical-names">${input('especialidad', 'Especialidad')}${input('unidad', 'Unidad')}${input('historia', 'Historia clínica')}</div></details>
      </div><div>
        <label><span class="l">Problema de salud AUGE / GES</span><select name="problema"><option value="">Selecciona un problema</option>${areaOptions}</select></label>
        <label><span class="l">Subgrupo o subproblema AUGE (opcional)</span><input name="subgrupo" list="ipdSubgrupos" autocomplete="off"><datalist id="ipdSubgrupos"></datalist></label>
        <p class="hint" data-subgroup-hint>Selecciona un problema para ver sus subgrupos disponibles.</p>
        ${[
          ['diagnostico', 'Diagnóstico'],
          ['fundamentos', 'Fundamentos del diagnóstico'],
          ['tratamiento', 'Tratamiento e indicaciones'],
        ].map(([key, label]) => html`<label><span class="l">${label}</span><textarea name="${key}" rows="3"></textarea></label>`)}
        ${input('inicio_tratamiento', 'Iniciar tratamiento a más tardar el (opcional)', 'date')}
        <p class="hint">Confirmación GES: Sí (X) · Firma en el formulario impreso.</p>
      </div></div>`,
    setup: (form) => {
      const problemSelect = form.elements.namedItem('problema');
      const sub = form.elements.namedItem('subgrupo');
      if (!(problemSelect instanceof HTMLSelectElement) || !(sub instanceof HTMLInputElement)) return;
      problemSelect.addEventListener('change', () => {
        const selected = problemSelect.value;
        const subgroups = GES_SUBGRUPOS.find((s) => s.problemaId === selected);
        sub.value = '';
        setHtml(form.querySelector('datalist'), html`${(subgroups?.opciones || []).map((s) => html`<option value="${s}"></option>`)}`);
        form.querySelector('[data-subgroup-hint]').textContent = subgroups
          ? 'Opciones del manual SIGGES MINSAL. Selecciona o escribe el subgrupo.'
          : 'Sin subdivisiones verificadas en el catálogo local. Puedes escribir el subgrupo si corresponde.';
      });
    },
  });
}
