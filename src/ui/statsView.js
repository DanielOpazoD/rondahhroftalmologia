/**
 * Filtro compartido (Estadística / Exportar) y tablero de estadística.
 */
import { SEXOS } from '../config/catalogs.js';
import { escapeHtml, fmtDate } from '../core/format.js';
import { computeStats, operativosOf, sortedEntries, ageGroupLabels, describeFilter } from '../core/stats.js';
import { $ } from './dom.js';

/** @param {import('./context.js').AppContext} ctx */
export function initFilter(ctx) {
  const update = () => {
    ctx.filter = { operativo: $('#fOp').value, desde: $('#fFrom').value, hasta: $('#fTo').value };
    ctx.onFilterChange();
  };
  ['#fOp', '#fFrom', '#fTo'].forEach((s) => $(s).addEventListener('change', update));
}

/** Rellena el selector de operativos y el contador del filtro. */
export function renderFilter(ctx) {
  const sel = $('#fOp');
  const ops = operativosOf(ctx.records);
  const cur = ctx.filter.operativo || '';
  sel.innerHTML = '<option value="">Todos los operativos</option>' + ops.map((o) => `<option>${escapeHtml(o)}</option>`).join('');
  sel.value = ops.includes(cur) ? cur : '';
  if (sel.value !== cur) ctx.filter.operativo = sel.value;
  $('#fCount').textContent = `${ctx.filtered().length} atenciones`;
}

/** Mueve la tarjeta de filtro a la pestaña visible. */
export function placeFilter(tabId) {
  const slot = document.querySelector(`#${tabId} .filterSlot`);
  if (slot) slot.appendChild($('#filterCard'));
}

const bars = (entries, total) => {
  if (!entries.length) return '<p class="muted">Sin datos.</p>';
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return `<div class="tw"><table class="st"><tr><th>Ítem</th><th style="width:36%"></th><th>N°</th><th>%</th></tr>${entries
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td><div class="hb" style="width:${(v / max) * 100}%"></div></td><td>${v}</td><td>${total ? Math.round((v / total) * 100) : 0}%</td></tr>`)
    .join('')}</table></div>`;
};
const kpi = (v, label) => `<div class="kpi"><b>${v}</b><span>${label}</span></div>`;

export function renderStats(ctx) {
  const list = ctx.filtered();
  const S = computeStats(list, ctx.procs);
  const rows = Object.entries(S.proc).sort((a, b) => b[1].pac - a[1].pac);
  const max = Math.max(1, ...rows.map((r) => r[1].pac));
  const tot = rows.reduce((a, [, o]) => ({ od: a.od + o.od, oi: a.oi + o.oi }), { od: 0, oi: 0 });
  const groups = ageGroupLabels();
  const sexKeys = ['F', 'M', 'O', 'Sin dato'];
  const fmt1 = (x) => (x === null ? '—' : Math.round(x * 10) / 10);

  $('#stOut').innerHTML = `
  <div class="card"><h2>${escapeHtml(describeFilter(ctx.filter, fmtDate))}</h2>
    <div class="kpis">${kpi(S.n, 'Atenciones')}${kpi(S.pacientes, 'Pacientes distintos')}${kpi(S.procTotal, 'Procedimientos realizados')}${kpi(S.ojos, 'Ojos (suma)')}${kpi(fmt1(S.edad.promedio), 'Edad promedio')}</div></div>
  <div class="card"><h2>Procedimientos realizados</h2>${
    rows.length
      ? `<div class="tw"><table class="st"><tr><th>Procedimiento</th><th style="width:26%"></th><th>Pac.</th><th>OD</th><th>OI</th><th>Ojos</th></tr>
        ${rows.map(([k, o]) => `<tr><td>${escapeHtml(k)}</td><td><div class="hb" style="width:${(o.pac / max) * 100}%"></div></td><td>${o.pac}</td><td>${o.od}</td><td>${o.oi}</td><td>${o.ojos}</td></tr>`).join('')}
        <tr class="tot"><td>Total</td><td></td><td>${S.procTotal}</td><td>${tot.od}</td><td>${tot.oi}</td><td>${S.ojos}</td></tr></table></div>`
      : '<p class="muted">Sin procedimientos registrados en este filtro.</p>'
  }</div>
  <div class="card"><h2>Diagnósticos</h2>${bars(sortedEntries(S.dx), S.n)}</div>
  <div class="card"><h2>Procedimientos solicitados</h2>${bars(sortedEntries(S.sol), S.n)}</div>
  <div class="card"><h2>Gestiones</h2><div class="kpis">${kpi(S.gest.ges, 'Con GES')}${kpi(S.gest.ic, 'Con interconsulta')}${kpi(S.gest.receta, 'Con receta')}${kpi(S.gest.seguimiento, 'Con seguimiento')}${kpi(S.gest.alta, 'Con alta')}</div></div>
  <div class="card"><h2>Edad y sexo</h2><div class="tw"><table class="st"><tr><th>Grupo</th>${SEXOS.map((s) => `<th>${s.key === 'O' ? 'Otro' : s.label}</th>`).join('')}<th>Sin dato</th><th>Total</th></tr>
    ${groups
      .map((g) => {
        const o = S.edadSexo[g];
        const t = sexKeys.reduce((a, k) => a + o[k], 0);
        return t ? `<tr><td>${g}</td>${sexKeys.map((k) => `<td>${o[k]}</td>`).join('')}<td>${t}</td></tr>` : '';
      })
      .join('')}
    <tr class="tot"><td>Total</td>${sexKeys.map((k) => `<td>${S.sexo[k]}</td>`).join('')}<td>${S.n}</td></tr></table></div></div>
  <div class="card"><h2>Por día</h2>${
    S.porDia.length
      ? `<div class="tw"><table class="st"><tr><th>Fecha</th><th>Atenciones</th><th>Pacientes</th><th>Proc.</th><th>Ojos</th></tr>${S.porDia
          .map((d) => `<tr><td>${escapeHtml(fmtDate(d.fecha) || d.fecha)}</td><td>${d.atenciones}</td><td>${d.pacientes}</td><td>${d.procedimientos}</td><td>${d.ojos}</td></tr>`)
          .join('')}</table></div>`
      : '<p class="muted">Sin datos.</p>'
  }</div>`;
}
