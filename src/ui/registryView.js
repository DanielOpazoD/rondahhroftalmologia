/**
 * Pestaña Pacientes: lista de atenciones guardadas, agrupadas por día.
 * Tocar una fila la abre; a la derecha, copiar nota, PDF y eliminar.
 */
import { SEXOS } from '../config/catalogs.js';
import { escapeHtml, fmtDate, normalizeText, cleanRut } from '../core/format.js';
import { operativosOf } from '../core/stats.js';
import { diagnosesList } from '../core/clinical.js';
import { $ } from './dom.js';

/** @param {import('./context.js').AppContext} ctx */
export function initRegistryView(ctx) {
  $('#regSearch').addEventListener('input', () => renderRegistry(ctx));
  $('#regOp').addEventListener('change', () => renderRegistry(ctx));
  $('#regList').addEventListener('click', (e) => {
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
export function matchesQuery(rec, q) {
  if (!q) return true;
  const nq = normalizeText(q);
  const rq = cleanRut(q);
  return normalizeText(rec.f?.paciente_nombre).includes(nq) || (rq.length >= 3 && cleanRut(rec.f?.paciente_rut).includes(rq));
}

/** "viernes 14 de noviembre" (o la fecha dd-mm-aaaa si no se puede). */
function dayLabel(iso) {
  if (!iso) return 'Sin fecha';
  const [y, m, d] = iso.split('-').map(Number);
  try {
    const s = new Date(y, m - 1, d).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return fmtDate(iso);
  }
}

const ICON = (name) => `<svg><use href="#i-${name}"/></svg>`;

function row(r, ctx) {
  const f = r.f;
  const id = escapeHtml(r.id);
  const sexo = SEXOS.find((s) => s.key === f.paciente_sexo)?.key || '';
  const meta = [f.paciente_rut, f.paciente_edad && `${f.paciente_edad} a`, sexo, f.operativo].filter(Boolean).map(escapeHtml).join(' · ');
  const dx = diagnosesList(r, { withOthers: false });
  const nProc = Object.keys(r.proc || {}).length;
  const tags = [
    ...dx.slice(0, 3).map((d) => `<span class="tag">${escapeHtml(d)}</span>`),
    nProc ? `<span class="tag soft">${nProc} proc.</span>` : '',
  ].join('');
  const active = ctx.rec.id === r.id ? ' active' : '';
  return `<div class="prow${active}">
    <button type="button" class="pmain" data-a="open" data-id="${id}" title="Abrir atención">
      <span class="pname">${escapeHtml(f.paciente_nombre || '(sin nombre)')}</span>
      <span class="pmeta">${meta}</span>
      ${tags ? `<span class="ptags">${tags}</span>` : ''}
    </button>
    <div class="pact">
      <button type="button" class="ib sm" data-a="copy" data-id="${id}" title="Copiar nota para Eloísa" aria-label="Copiar nota">${ICON('copy')}</button>
      <button type="button" class="ib sm" data-a="pdf" data-id="${id}" title="Descargar PDF" aria-label="Descargar PDF">${ICON('pdf')}</button>
      <button type="button" class="ib sm danger" data-a="del" data-id="${id}" title="Eliminar" aria-label="Eliminar atención">${ICON('trash')}</button>
    </div>
  </div>`;
}

export function renderRegistry(ctx) {
  const sel = $('#regOp');
  const ops = operativosOf(ctx.records);
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos los operativos</option>' + ops.map((o) => `<option>${escapeHtml(o)}</option>`).join('');
  sel.value = ops.includes(cur) ? cur : '';

  const future = ctx.store.loadFutureRecords().length;
  $('#futureBanner').hidden = !future;
  $('#futureBanner').textContent = future
    ? `Hay ${future} atención(es) guardadas con una versión más nueva de la app. Recarga la página para verlas y editarlas.`
    : '';

  const q = $('#regSearch').value.trim();
  const op = sel.value;
  const list = ctx.records.filter((r) => (!op || r.f.operativo === op) && matchesQuery(r, q));
  $('#regCount').textContent = list.length;

  if (!list.length) {
    $('#regList').innerHTML =
      `<div class="empty">${ctx.records.length ? 'Sin resultados para esta búsqueda.' : 'Aún no hay pacientes atendidos.<br>Las atenciones guardadas aparecerán aquí.'}</div>`;
    return;
  }
  // ctx.records ya viene ordenado por fecha descendente.
  const groups = new Map();
  for (const r of list) {
    const k = r.f.fecha_atencion || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  $('#regList').innerHTML = [...groups]
    .map(
      ([day, recs]) => `<section class="pgroup">
        <h3><span>${escapeHtml(dayLabel(day))}</span><span>${recs.length} ${recs.length === 1 ? 'paciente' : 'pacientes'}</span></h3>
        ${recs.map((r) => row(r, ctx)).join('')}
      </section>`,
    )
    .join('');
}
