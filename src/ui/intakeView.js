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
import { NAME_PARTS, refreshNames } from '../core/names.js';
import { $, dataOf } from './dom.js';
import { updateRutMark } from './rut.js';
import { html, setHtml } from './html.js';
import { icon } from './icons.js';

const FIELDS = {
  ing_rut: 'paciente_rut',
  ing_nombre: 'paciente_nombre',
  ...Object.fromEntries(NAME_PARTS.map((k) => ['ing_' + k, 'paciente_' + k])),
  ing_fnac: 'paciente_fnac',
  ing_fono: 'paciente_fono',
};

/**
 * Campo del ingreso por su id: los de FIELDS e `ing_edad` son <input> de
 * src/partials/paciente.html (el id se arma en ejecución, por eso se indica el tipo).
 * @param {string} id
 */
const fieldOf = (id) => /** @type {HTMLInputElement} */ ($('#' + id));

/** @param {import('./context.js').AppContext} ctx */
export function initIntakeView(ctx) {
  ctx.intakeSexo = '';
  ctx.intakePatientId = null;
  const updateName = () => {
    ctx.intakePatientId = null;
    const f = Object.fromEntries(NAME_PARTS.map((k) => ['paciente_' + k, $(`#ing_${k}`).value]));
    refreshNames(f);
    $('#ing_nombre').value = f.paciente_nombre;
  };
  for (const k of NAME_PARTS) {
    $(`#ing_${k}`).addEventListener('input', updateName);
    $(`#ing_${k}`).addEventListener('blur', () => !$('#ing_rut').value.trim() && fillFromRegistry(ctx));
  }
  $('#ing_rut').addEventListener('input', () => {
    ctx.intakePatientId = null;
  });
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
    $('#' + id).addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter') admit(ctx);
    });
  }

  $('#ingList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('button[data-a]'));
    if (!b) return;
    if (b.dataset.a === 'open') ctx.openRecord(dataOf(b, 'id'));
    if (b.dataset.a === 'del') ctx.deleteRecord(dataOf(b, 'id'));
  });
}

/** @param {import('./context.js').AppContext} ctx */
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

/** Completa los campos vacíos con la ficha existente del paciente (si la hay). @param {import('./context.js').AppContext} ctx */
function fillFromRegistry(ctx) {
  const id = resolvePatientId({ paciente_rut: $('#ing_rut').value, paciente_nombre: $('#ing_nombre').value }, ctx.store.loadPatients());
  const p = id && ctx.store.getPatient(id);
  if (!p) {
    $('#ingHint').textContent = id && $('#ing_rut').value.trim() ? 'Paciente nuevo.' : '';
    return;
  }
  ctx.intakePatientId = p.id;
  for (const [el, key] of Object.entries(FIELDS)) {
    const input = fieldOf(el);
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

/** @param {import('./context.js').AppContext} ctx */
function clearForm(ctx) {
  ctx.intakePatientId = null;
  for (const id of [...Object.keys(FIELDS), 'ing_edad']) fieldOf(id).value = '';
  $('#ing_edad').readOnly = false;
  ctx.intakeSexo = '';
  renderSexo(ctx);
  updateRutMark($('#ing_rut'));
  $('#ingHint').textContent = '';
  $('#ing_rut').focus();
}

/** Agrega a la lista del día el paciente del formulario. @param {import('./context.js').AppContext} ctx */
async function admit(ctx) {
  const data = {
    paciente_rut: $('#ing_rut').value.trim() ? formatRut($('#ing_rut').value) : '',
    paciente_nombre: $('#ing_nombre').value.trim(),
    ...($('#ing_nombres').value || $('#ing_apellido_paterno').value || $('#ing_apellido_materno').value
      ? Object.fromEntries(NAME_PARTS.map((k) => ['paciente_' + k, $(`#ing_${k}`).value.trim()]))
      : {}),
    paciente_fnac: $('#ing_fnac').value,
    paciente_edad: $('#ing_edad').value.trim(),
    paciente_sexo: ctx.intakeSexo,
    paciente_fono: $('#ing_fono').value.trim(),
  };
  const result = await ctx.admitPatient(data, {
    fecha: $('#ingFecha').value || todayIso(),
    operativo: $('#ingOp').value,
    pacienteId: ctx.intakePatientId ?? undefined,
  });
  if (result.ok) clearForm(ctx);
}

/** "Viernes 14 de noviembre". @param {string} iso fecha AAAA-MM-DD */
function dayTitle(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Lista del día. @param {import('./context.js').AppContext} ctx */
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
  $('#ingCount').textContent = String(list.length);
  $('#ingPend').textContent = String(pending);

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
