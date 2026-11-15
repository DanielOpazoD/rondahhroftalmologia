/**
 * Formulario de atención: dibuja casillas y procedimientos, enlaza entradas
 * con el registro en edición y lo refleja en pantalla (`sync`).
 */
import { SEXOS } from '../config/catalogs.js';
import { ANTECEDENTES, SOLICITADOS, DIAGNOSTICOS, TEXT_FIELDS, OJOS, coversEye, diagnosesList } from '../specialties/activa/index.js';
import { escapeHtml, formatRut, isIsoDate, fmtDateTime, fmtDate } from '../core/format.js';
import { auditLabel, shortValue } from '../core/audit.js';
import { patientIdFor, attentionsOf } from '../core/patient.js';
import { refreshRutMarks } from './rut.js';
import { validateRecord, applyBirthDate, findDuplicate } from '../core/record.js';
import { renderCatalogSelects } from './catalogView.js';
import { $, $$, toast } from './dom.js';

/** @param {import('./context.js').AppContext} ctx */
export function initAttentionView(ctx) {
  const chips = (el, defs) => {
    el.innerHTML = defs
      .map((d) => `<button type="button" class="chip" data-k="${d.key}" aria-pressed="false">${escapeHtml(d.label)}</button>`)
      .join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const rec = ctx.rec;
      rec.checks[b.dataset.k] = !rec.checks[b.dataset.k];
      ctx.changed();
    });
  };
  chips($('#antChips'), ANTECEDENTES);
  chips($('#solChips'), SOLICITADOS);
  chips($('#dxChips'), DIAGNOSTICOS);

  const seg = (el, values, labels, onPick) => {
    el.innerHTML = values
      .map((v, i) => `<button type="button" data-v="${v}" aria-pressed="false">${escapeHtml(labels[i])}</button>`)
      .join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) onPick(b.dataset.v);
    });
  };
  seg($('#catSeg'), OJOS, OJOS, (v) => {
    ctx.rec.cat = ctx.rec.cat === v ? '' : v;
    ctx.changed();
  });
  seg(
    $('#sexSeg'),
    SEXOS.map((s) => s.key),
    ['F', 'M', 'Otro'],
    (v) => {
      ctx.rec.f.paciente_sexo = ctx.rec.f.paciente_sexo === v ? '' : v;
      ctx.changed();
    },
  );
  $$('#sexSeg button').forEach((b, i) => (b.title = SEXOS[i].label));

  renderProcList(ctx);
  const list = $('#procList');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.seg button');
    if (!b) return;
    const id = b.closest('.proc').dataset.id;
    const cur = ctx.rec.proc[id] || {};
    cur.eye = cur.eye === b.dataset.v ? '' : b.dataset.v;
    if (!cur.eye) delete ctx.rec.proc[id];
    else ctx.rec.proc[id] = cur;
    ctx.changed();
  });
  list.addEventListener('input', (e) => {
    const i = e.target.closest('.pio input');
    if (!i) return;
    const id = i.closest('.proc').dataset.id;
    ctx.rec.proc[id] ||= { eye: 'AO' };
    ctx.rec.proc[id][i.dataset.e] = i.value;
    ctx.changed({ silent: true });
  });

  // Campos de texto: un solo listener delegado.
  document.addEventListener('input', (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target);
    const k = target.id;
    if (TEXT_FIELDS.includes(k) && k !== 'paciente_sexo') {
      ctx.rec.f[k] = target.value;
      // La edad se calcula sola desde la fecha de nacimiento.
      const ageChanged = (k === 'paciente_fnac' || k === 'fecha_atencion') && applyBirthDate(ctx.rec);
      if (k === 'paciente_fnac' && !isIsoDate(target.value)) $('#paciente_edad').readOnly = false;
      ctx.changed({ silent: !ageChanged && k !== 'paciente_fnac' });
    }
  });
  $('#dupJoin').addEventListener('click', () => ctx.joinExisting($('#dupBanner').dataset.id));
  $('#paciente_rut').addEventListener('blur', (e) => {
    if (!e.target.value.trim()) return;
    ctx.rec.f.paciente_rut = formatRut(e.target.value);
    ctx.changed();
    // Paciente ya registrado: se completan sus datos desde la ficha.
    if (ctx.fillFromPatient()) toast('Paciente registrado: se completaron sus datos');
  });
  $('#patPrev').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) ctx.openRecord(b.dataset.id);
  });
}

/** Dibuja la lista de procedimientos según la configuración actual. */
export function renderProcList(ctx) {
  $('#procList').innerHTML = ctx.procs
    .map(
      (p) => `<div class="proc" data-id="${escapeHtml(p.id)}"><div class="nm">${escapeHtml(p.n)}</div>
      <div class="seg" role="group" aria-label="Ojo para ${escapeHtml(p.n)}">${OJOS.map((v) => `<button type="button" data-v="${v}" aria-pressed="false">${v}</button>`).join('')}</div>
      ${p.pio ? `<div class="pio">${['od', 'oi'].map((e) => `<label class="pf"><span>PIO ${e.toUpperCase()}</span><input data-e="${e}" aria-label="PIO ${e.toUpperCase()} ${escapeHtml(p.n)}" placeholder="mmHg" inputmode="decimal"></label>`).join('')}</div>` : ''}</div>`,
    )
    .join('');
}

const setPressed = (b, on) => {
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
};

/** Refleja el registro en edición en el formulario. */
export function syncAttentionView(ctx) {
  const rec = ctx.rec;
  for (const k of TEXT_FIELDS) {
    const el = /** @type {HTMLInputElement | null} */ (document.getElementById(k));
    if (el && el.value !== (rec.f[k] || '')) el.value = rec.f[k] || '';
  }
  $$('.chip').forEach((c) => setPressed(c, !!rec.checks[c.dataset.k]));
  $('#cxBox').hidden = !rec.checks.antecedente_cirugia;
  $('#schBox').hidden = !rec.checks.procedimiento_test_schirmer;
  $('#catBox').hidden = !rec.checks.diagnostico_catarata;
  $$('#catSeg button').forEach((b) => setPressed(b, b.dataset.v === rec.cat));
  $$('#sexSeg button').forEach((b) => setPressed(b, b.dataset.v === rec.f.paciente_sexo));

  let n = 0;
  $$('#procList .proc').forEach((row) => {
    const p = rec.proc[row.dataset.id];
    row.classList.toggle('done', !!p);
    if (p) n++;
    row.querySelectorAll('.seg button').forEach((b) => setPressed(b, !!p && p.eye === b.dataset.v));
    row.querySelectorAll('.pio input').forEach((i) => {
      const v = p ? p[i.dataset.e] || '' : '';
      if (i.value !== v) i.value = v;
      i.closest('.pf').hidden = !!p && !coversEye(p.eye, i.dataset.e);
    });
  });
  // Procedimientos guardados que ya no están en la lista configurada.
  n += Object.keys(rec.proc).filter((id) => !ctx.procs.some((p) => p.id === id)).length;
  $('#procBadge').textContent = n;
  const fromBirth = isIsoDate(rec.f.paciente_fnac);
  $('#paciente_edad').readOnly = fromBirth;
  $('#paciente_edad').title = fromBirth ? 'Calculada desde la fecha de nacimiento' : '';
  renderCatalogSelects(ctx);
  renderPrevious(ctx);
  refreshRutMarks();
  renderHistory(ctx);
  renderToolbar(ctx);
  showValidation(ctx);
}

/** Título y estado de la barra superior: a quién se atiende y si hay cambios sin guardar. */
export function renderToolbar(ctx) {
  const f = ctx.rec.f;
  // Atención nueva de un paciente (mismo RUT o nombre) que ya tiene una ese día.
  const dup = !ctx.rec.id && (f.paciente_rut?.trim() || f.paciente_nombre?.trim()) ? findDuplicate(ctx.rec, ctx.records) : null;
  $('#dupBanner').hidden = !dup;
  if (dup) {
    $('#dupBanner').dataset.id = dup.id;
    $('#dupText').textContent =
      `${dup.f.paciente_nombre || dup.f.paciente_rut} ya tiene una atención este día (en este u otro equipo). Continúa en ella para no duplicar: lo que escribiste se agrega.`;
  }
  $('#tbName').textContent = f.paciente_nombre?.trim() || (ctx.rec.id ? '(sin nombre)' : 'Nueva atención');
  const state = ctx.dirty ? (ctx.rec.id ? 'Cambios sin guardar' : 'Sin guardar') : ctx.rec.id ? 'Guardada' : 'Sin datos';
  const el = $('#tbState');
  el.textContent = state;
  el.className = ctx.dirty ? 'dirty' : ctx.rec.id ? 'saved' : '';
}

/**
 * Muestra mensajes de validación junto a los campos.
 * Las advertencias se ven mientras se escribe; los errores, solo al intentar guardar.
 */
export function showValidation(ctx, { showErrors = false } = {}) {
  const { fields } = validateRecord(ctx.rec);
  $$('.msg').forEach((m) => {
    const k = m.dataset.msg;
    const item = fields[k];
    const show = !!item && (item.level === 'warn' || showErrors);
    m.textContent = show ? item.msg : '';
    m.className = 'msg' + (show ? (item.level === 'error' ? ' err' : ' warn') : '');
    const input = document.getElementById(k);
    if (input && input.tagName === 'INPUT') {
      input.classList.toggle('invalid', show && item.level === 'error');
      input.classList.toggle('warned', show && item.level === 'warn');
      input.setAttribute('aria-invalid', String(show));
    }
  });
}

const TIPO = { ingresada: 'Ingresada a la lista', creada: 'Creada', editada: 'Editada', eliminada: 'Eliminada' };

/** Historial de cambios (bitácora) de la atención abierta. */
export function renderHistory(ctx) {
  const id = ctx.rec.id;
  const entries = id ? ctx.store.auditFor(id) : [];
  $('#histCard').hidden = !entries.length;
  $('#histCount').textContent = entries.length;
  $('#histList').innerHTML = entries
    .map((e) => {
      const cambios = (e.cambios || [])
        .slice(0, 30)
        .map(
          (c) =>
            `<li>${escapeHtml(auditLabel(c.c, ctx.procs))}: <span class="hval">${escapeHtml(shortValue(c.a))}</span> → <span class="hval">${escapeHtml(shortValue(c.d))}</span></li>`,
        )
        .join('');
      const more = (e.cambios || []).length > 30 ? `<li>… y ${e.cambios.length - 30} cambios más</li>` : '';
      return `<li><div class="hmeta"><b>${TIPO[e.tipo] || escapeHtml(e.tipo)}</b> · ${escapeHtml(fmtDateTime(new Date(e.at)))} · ${escapeHtml(e.equipo)}</div>${cambios || more ? `<ul>${cambios}${more}</ul>` : ''}</li>`;
    })
    .join('');
}

/** Otras atenciones del mismo paciente (historial clínico a lo largo del tiempo). */
export function renderPrevious(ctx) {
  const id = ctx.rec.pacienteId || patientIdFor(ctx.rec.f);
  const others = id ? attentionsOf(ctx.records, id).filter((r) => r.id !== ctx.rec.id) : [];
  $('#patPrev').hidden = !others.length;
  $('#patPrev').innerHTML = others.length
    ? `<b>Otras atenciones (${others.length}):</b>` +
      others
        .slice(0, 6)
        .map((r) => {
          const dx = diagnosesList(r, { withOthers: false }).slice(0, 2).join(', ');
          return `<button type="button" data-id="${escapeHtml(r.id)}" title="Abrir">${escapeHtml(fmtDate(r.f.fecha_atencion))}${dx ? ' · ' + escapeHtml(dx) : ''}</button>`;
        })
        .join('') +
      (others.length > 6 ? `<span class="muted">y ${others.length - 6} más (ver en Pacientes)</span>` : '')
    : '';
}
