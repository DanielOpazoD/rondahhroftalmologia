/**
 * Pestaña Ingreso: preingreso de los pacientes del día y lista de atención.
 *
 * Pensada para trabajo simultáneo: una persona ingresa pacientes (datos
 * demográficos) mientras médicos y otros profesionales abren cada paciente
 * de la lista y registran lo clínico. Todo se fusiona campo a campo.
 */
import { formatRut, isIsoDate, todayIso, ageAt, fmtDate } from '../core/format.js';
import { resolvePatientId, isAttended, attentionsOf } from '../core/patient.js';
import { diagnosesList } from '../specialties/activa/index.js';
import { initSexSelector, renderSexSelector } from './patientFields.js';
import { $ } from './dom.js';
import { updateRutMark } from './rut.js';
import { html, setHtml } from './html.js';
import { icon } from './icons.js';

const FIELDS = { ing_rut: 'paciente_rut', ing_nombre: 'paciente_nombre', ing_fnac: 'paciente_fnac', ing_fono: 'paciente_fono' };

/** @param {import('./context.js').AppContext} ctx */
export function initIntakeView(ctx) {
  ctx.intakeSexo = '';
  initSexSelector(
    $('#ingSexo'),
    () => ctx.intakeSexo,
    (v) => {
      ctx.intakeSexo = v;
      renderSexo(ctx);
    },
  );

  // Al escribir el RUT de un paciente ya registrado, se completan sus datos.
  $('#ing_rut').addEventListener('blur', () => {
    const el = $('#ing_rut');
    if (el.value.trim()) el.value = formatRut(el.value);
    updateRutMark(el);
    fillFromRegistry(ctx);
  });
  $('#ing_nombre').addEventListener('blur', () => !$('#ing_rut').value.trim() && fillFromRegistry(ctx));
  $('#ing_fnac').addEventListener('input', () => updateAge());
  $('#ingFecha').addEventListener('change', () => {
    updateAge();
    renderIntake(ctx);
  });
  $('#ingOp').addEventListener('change', () => renderIntake(ctx));
  $('#ingAdd').addEventListener('click', () => admit(ctx));
  for (const id of Object.keys(FIELDS)) {
    $('#' + id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') admit(ctx);
    });
  }

  $('#ingList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    if (b.dataset.a === 'open') ctx.openRecord(b.dataset.id);
    if (b.dataset.a === 'del') ctx.deleteRecord(b.dataset.id);
  });
}

function renderSexo(ctx) {
  renderSexSelector($('#ingSexo'), ctx.intakeSexo);
}

function updateAge() {
  const fnac = $('#ing_fnac').value;
  const ref = $('#ingFecha').value || todayIso();
  const age = isIsoDate(fnac) ? ageAt(fnac, ref) : null;
  $('#ing_edad').readOnly = isIsoDate(fnac);
  if (isIsoDate(fnac)) $('#ing_edad').value = age === null ? '' : String(age);
}

/** Completa los campos vacíos con la ficha existente del paciente (si la hay). */
function fillFromRegistry(ctx) {
  const id = resolvePatientId({ paciente_rut: $('#ing_rut').value, paciente_nombre: $('#ing_nombre').value }, ctx.store.loadPatients());
  const p = id && ctx.store.getPatient(id);
  if (!p) {
    $('#ingHint').textContent = id && $('#ing_rut').value.trim() ? 'Paciente nuevo.' : '';
    return;
  }
  for (const [el, key] of Object.entries(FIELDS)) {
    const input = $('#' + el);
    if (!input.value.trim() && p.f[key]) input.value = p.f[key];
  }
  if (!ctx.intakeSexo && p.f.paciente_sexo) {
    ctx.intakeSexo = p.f.paciente_sexo;
    renderSexo(ctx);
  }
  updateAge();
  updateRutMark($('#ing_rut'));
  const prev = attentionsOf(ctx.records, id);
  $('#ingHint').textContent =
    `Paciente ya registrado · ${prev.length} ${prev.length === 1 ? 'atención' : 'atenciones'} en ${ctx.especialidadNombre}${prev[0] ? ` (última: ${fmtDate(prev[0].f.fecha_atencion)})` : ''}.`;
}

function clearForm(ctx) {
  for (const id of [...Object.keys(FIELDS), 'ing_edad']) $('#' + id).value = '';
  $('#ing_edad').readOnly = false;
  ctx.intakeSexo = '';
  renderSexo(ctx);
  updateRutMark($('#ing_rut'));
  $('#ingHint').textContent = '';
  $('#ing_rut').focus();
}

async function admit(ctx) {
  const data = {
    paciente_rut: $('#ing_rut').value.trim() ? formatRut($('#ing_rut').value) : '',
    paciente_nombre: $('#ing_nombre').value.trim(),
    paciente_fnac: $('#ing_fnac').value,
    paciente_edad: $('#ing_edad').value.trim(),
    paciente_sexo: ctx.intakeSexo,
    paciente_fono: $('#ing_fono').value.trim(),
  };
  const result = await ctx.admitPatient(data, { fecha: $('#ingFecha').value || todayIso(), operativo: $('#ingOp').value });
  if (result.ok) clearForm(ctx);
}

/** "Viernes 14 de noviembre". */
function dayTitle(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Lista del día. */
export function renderIntake(ctx) {
  if (!$('#ingFecha').value) $('#ingFecha').value = todayIso();
  const sel = $('#ingOp');
  const cur = sel.dataset.init ? sel.value : ctx.store.loadMedico().op || '';
  sel.dataset.init = '1';
  const ops = ctx.operativos.map((o) => o.nombre);
  setHtml(sel, html`<option value="">Sin operativo</option>${ops.map((n) => html`<option value="${n}">${n}</option>`)}`);
  sel.value = ops.includes(cur) ? cur : '';

  const date = $('#ingFecha').value;
  const op = sel.value;
  const list = ctx.records
    .filter((r) => r.f.fecha_atencion === date && (!op || r.f.operativo === op))
    .sort((a, b) => (a.created || 0) - (b.created || 0));
  const pending = list.filter((r) => !isAttended(r)).length;
  $('#ingCount').textContent = list.length;
  $('#ingPend').textContent = pending;

  if (!list.length) {
    setHtml(
      $('#ingList'),
      html`<div class="empty">No hay pacientes en la lista de ${dayTitle(date)}${op ? ' para este operativo' : ''}.</div>`,
    );
    return;
  }
  const rows = list.map((r, i) => {
    const f = r.f;
    const done = isAttended(r);
    const meta = [f.paciente_rut, f.paciente_edad && `${f.paciente_edad} a`, f.paciente_sexo, f.medico_nombre].filter(Boolean).join(' · ');
    const dx = diagnosesList(r, { withOthers: false }).slice(0, 2);
    return html`<div class="prow${ctx.rec.id === r.id ? ' active' : ''}">
        <button type="button" class="pmain" data-a="open" data-id="${r.id}" title="Abrir atención">
          <span class="pname">${i + 1}. ${f.paciente_nombre || '(sin nombre)'}</span>
          <span class="pmeta">${meta}</span>
          <span class="ptags">${dx.map((d) => html`<span class="tag">${d}</span>`)}<span class="state ${done ? 'done' : 'pend'}">${done ? 'Atendido' : 'Por atender'}</span></span>
        </button>
        <div class="pact">
          ${done ? '' : html`<button type="button" class="ib sm danger" data-a="del" data-id="${r.id}" title="Quitar de la lista" aria-label="Quitar de la lista">${icon('trash')}</button>`}
        </div>
      </div>`;
  });
  setHtml(
    $('#ingList'),
    html`<section class="pgroup"><h3><span>${dayTitle(date)}</span><span>${list.length} ${list.length === 1 ? 'paciente' : 'pacientes'}</span></h3>${rows}</section>`,
  );
}
