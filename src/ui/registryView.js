/**
 * Pestaña Pacientes: registro de pacientes (la unidad) y, por paciente, su
 * historial de atenciones de esta especialidad a lo largo del tiempo.
 */
import { SEXOS } from '../config/catalogs.js';
import { escapeHtml, fmtDate, normalizeText, cleanRut, ageAt, isIsoDate, todayIso, isValidRut } from '../core/format.js';
import { isAttended, patientLabel } from '../core/patient.js';
import { diagnosesList } from '../specialties/activa/index.js';
import { $ } from './dom.js';

const ICON = (name) => `<svg><use href="#i-${name}"/></svg>`;

/** @param {import('./context.js').AppContext} ctx */
export function initRegistryView(ctx) {
  ctx.openPatientId = null;
  $('#regSearch').addEventListener('input', () => renderRegistry(ctx));
  $('#regOp').addEventListener('change', () => renderRegistry(ctx));
  $('#regList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (b) showPatient(ctx, b.dataset.p);
  });
  $('#patBack').addEventListener('click', () => showPatient(ctx, null));
  $('#patNew').addEventListener('click', () => ctx.openPatientId && ctx.newAttentionFor(ctx.openPatientId));
  $('#patAttentions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const rec = ctx.records.find((r) => r.id === b.dataset.id);
    if (!rec) return;
    ({
      open: () => ctx.openRecord(rec.id),
      pdf: () => ctx.downloadPdf(rec, b),
      copy: () => ctx.copyNote(rec),
      del: () => ctx.deleteRecord(rec.id),
    })[b.dataset.a]?.();
  });
}

/** Coincide por nombre (sin tildes) o RUT (sin puntos ni guion). */
export function matchesQuery(p, q) {
  if (!q) return true;
  const nq = normalizeText(q);
  const rq = cleanRut(q);
  return normalizeText(p.f?.paciente_nombre).includes(nq) || (rq.length >= 3 && cleanRut(p.f?.paciente_rut).includes(rq));
}

/** Atenciones agrupadas por paciente (una pasada). */
function byPatient(records) {
  const map = new Map();
  for (const r of records) {
    if (!r.pacienteId) continue;
    if (!map.has(r.pacienteId)) map.set(r.pacienteId, []);
    map.get(r.pacienteId).push(r);
  }
  for (const list of map.values()) list.sort((a, b) => (b.f.fecha_atencion || '').localeCompare(a.f.fecha_atencion || ''));
  return map;
}

const ageNow = (p, fallback) => (isIsoDate(p.f.paciente_fnac) ? ageAt(p.f.paciente_fnac, todayIso()) : fallback);
const sexLabel = (k) => SEXOS.find((s) => s.key === k)?.label || '';

function showPatient(ctx, id) {
  ctx.openPatientId = id;
  $('#patListView').hidden = Boolean(id);
  $('#patDetailView').hidden = !id;
  renderRegistry(ctx);
  scrollTo(0, 0);
}

export function renderRegistry(ctx) {
  const future = ctx.store.loadFutureRecords().length;
  $('#futureBanner').hidden = !future;
  $('#futureBanner').textContent = future
    ? `Hay ${future} atención(es) guardadas con una versión más nueva de la app. Recarga la página para verlas y editarlas.`
    : '';
  const groups = byPatient(ctx.records);
  if (ctx.openPatientId) return renderPatient(ctx, groups.get(ctx.openPatientId) || []);

  const sel = $('#regOp');
  const ops = ctx.operativos.map((o) => o.nombre);
  const cur = sel.value;
  sel.innerHTML =
    '<option value="">Todos los operativos</option>' +
    ops.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  sel.value = ops.includes(cur) ? cur : '';

  const q = $('#regSearch').value.trim();
  const op = sel.value;
  const patients = ctx.store
    .loadPatients()
    .map((p) => ({ p, recs: groups.get(p.id) || [] }))
    .filter(({ p, recs }) => recs.length && matchesQuery(p, q) && (!op || recs.some((r) => r.f.operativo === op)))
    .sort(
      (a, b) =>
        (b.recs[0].f.fecha_atencion || '').localeCompare(a.recs[0].f.fecha_atencion || '') ||
        patientLabel(a.p).localeCompare(patientLabel(b.p), 'es'),
    );
  $('#regCount').textContent = patients.length;
  if (!patients.length) {
    $('#regList').innerHTML = `<div class="empty">${
      ctx.records.length
        ? 'Sin resultados para esta búsqueda.'
        : 'Aún no hay pacientes.<br>Ingrésalos en la pestaña Ingreso o desde una atención.'
    }</div>`;
    return;
  }
  $('#regList').innerHTML = `<section class="pgroup">${patients
    .slice(0, 500)
    .map(({ p, recs }) => {
      const last = recs[0];
      const age = ageNow(p, last.f.paciente_edad);
      const meta = [
        p.f.paciente_rut,
        age !== '' && age != null ? `${age} a` : '',
        p.f.paciente_sexo,
        `última: ${fmtDate(last.f.fecha_atencion)}`,
      ]
        .filter(Boolean)
        .map(escapeHtml)
        .join(' · ');
      const dx = diagnosesList(last, { withOthers: false }).slice(0, 2);
      return `<div class="prow"><button type="button" class="pmain" data-p="${escapeHtml(p.id)}" title="Ver paciente">
        <span class="pname">${escapeHtml(patientLabel(p))}</span>
        <span class="pmeta">${meta}</span>
        <span class="ptags">${dx.map((d) => `<span class="tag">${escapeHtml(d)}</span>`).join('')}<span class="tag soft">${recs.length} ${
          recs.length === 1 ? 'atención' : 'atenciones'
        }</span></span>
      </button></div>`;
    })
    .join(
      '',
    )}</section>${patients.length > 500 ? '<p class="hint">Se muestran los 500 más recientes: usa la búsqueda para encontrar otros.</p>' : ''}`;
}

function renderPatient(ctx, recs) {
  const p = ctx.store.getPatient(ctx.openPatientId);
  if (!p) return showPatient(ctx, null);
  const f = p.f;
  const age = ageNow(p, recs[0]?.f.paciente_edad);
  const rutMark = f.paciente_rut
    ? isValidRut(f.paciente_rut)
      ? ' <span class="rutmark inline ok" title="RUT válido">✓</span>'
      : ' <span class="rutmark inline bad" title="RUT inválido">✗</span>'
    : '';
  const meta = [
    f.paciente_rut && `RUT ${escapeHtml(f.paciente_rut)}${rutMark}`,
    f.paciente_fnac && `Nac. ${escapeHtml(fmtDate(f.paciente_fnac))}`,
    age !== '' && age != null && `${escapeHtml(String(age))} años`,
    sexLabel(f.paciente_sexo) && escapeHtml(sexLabel(f.paciente_sexo)),
    f.paciente_fono && `Fono ${escapeHtml(f.paciente_fono)}`,
  ].filter(Boolean);
  $('#patCard').innerHTML = `<h2>${escapeHtml(patientLabel(p))}</h2><div class="patmeta">${meta.join(' · ')}</div>`;
  $('#patAttentions').innerHTML = recs.length
    ? `<section class="pgroup"><h3><span>Atenciones de ${escapeHtml(ctx.especialidadNombre)}</span><span>${recs.length}</span></h3>${recs
        .map((r) => {
          const id = escapeHtml(r.id);
          const done = isAttended(r);
          const dx = diagnosesList(r, { withOthers: false }).slice(0, 3);
          const rmeta = [r.f.operativo, r.f.medico_nombre].filter(Boolean).map(escapeHtml).join(' · ');
          return `<div class="prow${ctx.rec.id === r.id ? ' active' : ''}">
            <button type="button" class="pmain" data-a="open" data-id="${id}" title="Abrir atención">
              <span class="pname">${escapeHtml(fmtDate(r.f.fecha_atencion) || 'Sin fecha')}</span>
              <span class="pmeta">${rmeta}</span>
              <span class="ptags">${dx.map((d) => `<span class="tag">${escapeHtml(d)}</span>`).join('')}${done ? '' : '<span class="state pend">Por atender</span>'}</span>
            </button>
            <div class="pact">
              <button type="button" class="ib sm" data-a="copy" data-id="${id}" title="Copiar nota" aria-label="Copiar nota">${ICON('copy')}</button>
              <button type="button" class="ib sm" data-a="pdf" data-id="${id}" title="Descargar PDF" aria-label="Descargar PDF">${ICON('pdf')}</button>
              <button type="button" class="ib sm danger" data-a="del" data-id="${id}" title="Eliminar" aria-label="Eliminar atención">${ICON('trash')}</button>
            </div>
          </div>`;
        })
        .join('')}</section>`
    : '<div class="empty">Este paciente aún no tiene atenciones en esta especialidad.</div>';
}
