/**
 * Filtro compartido (Estadística / Exportar) y tablero de estadística.
 */
import { escapeHtml, fmtDate } from '../core/format.js';
import { computeStats, operativosOf, sortedEntries, ageGroupLabels } from '../core/stats.js';
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
  const n = ctx.filtered().length;
  $('#fCount').textContent = `${n} ${n === 1 ? 'atención' : 'atenciones'}`;
}

/** Mueve la tarjeta de filtro a la pestaña visible. */
export function placeFilter(tabId) {
  const slot = document.querySelector(`#${tabId} .filterSlot`);
  if (slot) slot.appendChild($('#filterCard'));
}

const bars = (entries, total) => {
  if (!entries.length) return '<p class="hint">Sin datos.</p>';
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return `<table class="st bars">${entries
    .map(
      ([k, v]) =>
        `<tr><td>${escapeHtml(k)}</td><td class="bar"><div class="hb" style="width:${(v / max) * 100}%"></div></td><td>${v}</td><td class="pct">${total ? Math.round((v / total) * 100) : 0}%</td></tr>`,
    )
    .join('')}</table>`;
};
const kpi = (v, label) => `<div class="kpi"><b>${v}</b><span>${label}</span></div>`;
const card = (title, body) => `<div class="card"><h2>${title}</h2>${body}</div>`;

export function renderStats(ctx) {
  const list = ctx.filtered();
  const S = computeStats(list, ctx.procs);
  if (!S.n) {
    $('#stOut').innerHTML = '<div class="empty">No hay atenciones en este filtro.</div>';
    return;
  }
  const rows = Object.entries(S.proc).sort((a, b) => b[1].pac - a[1].pac);
  const tot = rows.reduce((a, [, o]) => ({ od: a.od + o.od, oi: a.oi + o.oi }), { od: 0, oi: 0 });
  const groups = ageGroupLabels();
  const sexKeys = ['F', 'M', 'O', 'Sin dato'];
  const fmt1 = (x) => (x === null ? '—' : Math.round(x * 10) / 10);
  const gest = [
    ['GES', S.gest.ges],
    ['Interconsulta', S.gest.ic],
    ['Receta', S.gest.receta],
    ['Seguimiento', S.gest.seguimiento],
    ['Alta', S.gest.alta],
  ]
    .map(([k, v]) => `<span><b>${v}</b> ${k}</span>`)
    .join('');

  const procTable = rows.length
    ? `<div class="tw"><table class="st"><tr><th>Procedimiento</th><th>Pac.</th><th>OD</th><th>OI</th><th>Ojos</th></tr>
        ${rows.map(([k, o]) => `<tr><td>${escapeHtml(k)}</td><td>${o.pac}</td><td>${o.od}</td><td>${o.oi}</td><td>${o.ojos}</td></tr>`).join('')}
        <tr class="tot"><td>Total</td><td>${S.procTotal}</td><td>${tot.od}</td><td>${tot.oi}</td><td>${S.ojos}</td></tr></table></div>`
    : '<p class="hint">Sin procedimientos registrados.</p>';

  const ageTable = `<div class="tw"><table class="st"><tr><th>Edad</th><th>F</th><th>M</th><th>Otro</th><th>S/d</th><th>Total</th></tr>
    ${groups
      .map((g) => {
        const o = S.edadSexo[g];
        const t = sexKeys.reduce((a, k) => a + o[k], 0);
        return t ? `<tr><td>${g}</td>${sexKeys.map((k) => `<td>${o[k] || '·'}</td>`).join('')}<td>${t}</td></tr>` : '';
      })
      .join('')}
    <tr class="tot"><td>Total</td>${sexKeys.map((k) => `<td>${S.sexo[k]}</td>`).join('')}<td>${S.n}</td></tr></table></div>`;

  const dayTable = `<div class="tw"><table class="st"><tr><th>Fecha</th><th>Atenciones</th><th>Pacientes</th><th>Proc.</th><th>Ojos</th></tr>${S.porDia
    .map(
      (d) =>
        `<tr><td>${escapeHtml(fmtDate(d.fecha) || d.fecha)}</td><td>${d.atenciones}</td><td>${d.pacientes}</td><td>${d.procedimientos}</td><td>${d.ojos}</td></tr>`,
    )
    .join('')}</table></div>`;

  $('#stOut').innerHTML = `
  <div class="card">
    <div class="kpis">${kpi(S.n, 'Atenciones')}${kpi(S.pacientes, 'Pacientes')}${kpi(S.procTotal, 'Procedimientos')}${kpi(S.ojos, 'Ojos')}${kpi(fmt1(S.edad.promedio), 'Edad promedio')}</div>
    <div class="gestline">${gest}</div>
  </div>
  <div class="g2 cards">
    ${card('Procedimientos realizados', procTable)}
    ${card('Diagnósticos', bars(sortedEntries(S.dx), S.n))}
    ${card('Procedimientos solicitados', bars(sortedEntries(S.sol), S.n))}
    ${card('Edad y sexo', ageTable)}
  </div>
  ${S.porDia.length > 1 ? card('Por día', dayTable) : ''}`;
}
