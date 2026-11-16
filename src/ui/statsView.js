/**
 * Pestaña Reportes: filtro y tablero de estadística. Minimalista: lo que no
 * tiene datos no se muestra (secciones vacías, contadores en cero, columnas
 * de sexo sin casos); el Excel sí trae todo.
 */
import { fmtDate } from '../core/format.js';
import { computeStats, operativosOf, sortedEntries, ageGroupLabels } from '../specialties/activa/index.js';
import { $ } from './dom.js';
import { html, setHtml } from './html.js';

/** @param {import('./context.js').AppContext} ctx */
export function initFilter(ctx) {
  const update = () => {
    ctx.filter = { operativo: $('#fOp').value, desde: $('#fFrom').value, hasta: $('#fTo').value };
    ctx.onFilterChange();
  };
  ['#fOp', '#fFrom', '#fTo'].forEach((s) => $(s).addEventListener('change', update));
}

/** Rellena el selector de operativos y el contador del filtro. @param {import('./context.js').AppContext} ctx */
export function renderFilter(ctx) {
  const sel = $('#fOp');
  const ops = operativosOf(ctx.records);
  const cur = ctx.filter.operativo || '';
  setHtml(sel, html`<option value="">Todos los operativos</option>${ops.map((o) => html`<option>${o}</option>`)}`);
  sel.value = ops.includes(cur) ? cur : '';
  if (sel.value !== cur) ctx.filter.operativo = sel.value;
  const n = ctx.filtered().length;
  $('#fCount').textContent = `${n} ${n === 1 ? 'atención' : 'atenciones'}`;
}

/** Mueve la tarjeta de filtro a la pestaña visible. @param {string} tabId */
export function placeFilter(tabId) {
  const slot = document.querySelector(`#${tabId} .filterSlot`);
  if (slot) slot.appendChild($('#filterCard'));
}

/**
 * Barras horizontales con conteo y porcentaje.
 * @param {[string, number][]} entries pares [etiqueta, cantidad]
 * @param {number} total base del porcentaje
 */
const bars = (entries, total) => {
  if (!entries.length) return html`<p class="hint">Sin datos.</p>`;
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const rowsHtml = entries.map(
    ([k, v]) =>
      html`<tr><td>${k}</td><td class="bar"><div class="hb" data-w="${(v / max) * 100}"></div></td><td>${v}</td><td class="pct">${total ? Math.round((v / total) * 100) : 0}%</td></tr>`,
  );
  return html`<table class="st bars">${rowsHtml}</table>`;
};
/** @param {number | string} v @param {string} label */
const kpi = (v, label) => html`<div class="kpi"><b>${v}</b><span>${label}</span></div>`;
/** @param {string} title @param {import('./html.js').SafeHtml} body */
const card = (title, body) => html`<div class="card"><h2>${title}</h2>${body}</div>`;

/** @param {import('./context.js').AppContext} ctx */
export function renderStats(ctx) {
  const list = ctx.filtered();
  const S = computeStats(list, ctx.procs);
  if (!S.n) {
    setHtml($('#stOut'), html`<div class="empty">No hay atenciones en este filtro.</div>`);
    return;
  }
  const rows = Object.entries(S.proc).sort((a, b) => b[1].pac - a[1].pac);
  const tot = rows.reduce((a, [, o]) => ({ od: a.od + o.od, oi: a.oi + o.oi }), { od: 0, oi: 0 });
  const groups = ageGroupLabels();
  // F y M siempre; «Otro» y «Sin dato» solo si hay casos.
  const sexKeys = /** @type {('F' | 'M' | 'O' | 'Sin dato')[]} */ (['F', 'M', 'O', 'Sin dato']).filter(
    (k) => k === 'F' || k === 'M' || S.sexo[k],
  );
  const sexLabel = { F: 'F', M: 'M', O: 'Otro', 'Sin dato': 'S/d' };
  // Decimales con coma (es-CL): «68,4».
  const fmt1 = (/** @type {number | null} */ x) =>
    x === null ? '—' : (Math.round(x * 10) / 10).toLocaleString('es-CL', { maximumFractionDigits: 1 });
  const gest = [
    ['GES', S.gest.ges],
    ['Interconsulta', S.gest.ic],
    ['Receta', S.gest.receta],
    ['Seguimiento', S.gest.seguimiento],
    ['Alta', S.gest.alta],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => html`<span><b>${v}</b> ${k}</span>`);

  const procTable = html`<div class="tw"><table class="st"><tr><th>Procedimiento</th><th>Pac.</th><th>OD</th><th>OI</th><th>Ojos</th></tr>
    ${rows.map(([k, o]) => html`<tr><td>${k}</td><td>${o.pac}</td><td>${o.od}</td><td>${o.oi}</td><td>${o.ojos}</td></tr>`)}
    <tr class="tot"><td>Total</td><td>${S.procTotal}</td><td>${tot.od}</td><td>${tot.oi}</td><td>${S.ojos}</td></tr></table></div>`;

  const ageRows = groups.map((g) => {
    const o = S.edadSexo[g];
    const t = sexKeys.reduce((a, k) => a + o[k], 0);
    return t ? html`<tr><td>${g}</td>${sexKeys.map((k) => html`<td>${o[k] || '·'}</td>`)}<td>${t}</td></tr>` : '';
  });
  const ageTable = html`<div class="tw"><table class="st"><tr><th>Edad</th>${sexKeys.map((k) => html`<th>${sexLabel[k]}</th>`)}<th>Total</th></tr>
    ${ageRows}
    <tr class="tot"><td>Total</td>${sexKeys.map((k) => html`<td>${S.sexo[k]}</td>`)}<td>${S.n}</td></tr></table></div>`;

  const dx = sortedEntries(S.dx);
  const sol = sortedEntries(S.sol);
  const dayRows = S.porDia.map(
    (d) =>
      html`<tr><td>${fmtDate(d.fecha) || d.fecha}</td><td>${d.atenciones}</td><td>${d.pacientes}</td><td>${d.procedimientos}</td><td>${d.ojos}</td></tr>`,
  );
  const dayTable = html`<div class="tw"><table class="st"><tr><th>Fecha</th><th>Atenciones</th><th>Pacientes</th><th>Proc.</th><th>Ojos</th></tr>${dayRows}</table></div>`;

  setHtml(
    $('#stOut'),
    html`
  <div class="card">
    <div class="kpis">${kpi(S.n, 'Atenciones')}${kpi(S.pacientes, 'Pacientes')}${kpi(S.procTotal, 'Procedimientos')}${kpi(S.ojos, 'Ojos')}${kpi(fmt1(S.edad.promedio), 'Edad promedio')}</div>
    ${gest.length ? html`<div class="gestline">${gest}</div>` : ''}
  </div>
  <div class="g2 cards">
    ${rows.length ? card('Procedimientos realizados', procTable) : ''}
    ${dx.length ? card('Diagnósticos', bars(dx, S.n)) : ''}
    ${sol.length ? card('Procedimientos solicitados', bars(sol, S.n)) : ''}
    ${card('Edad y sexo', ageTable)}
  </div>
  ${S.porDia.length > 1 ? card('Por día', dayTable) : ''}`,
  );
  applyBarWidths($('#stOut'));
}

/** Ancho de las barras por CSSOM (la CSP no permite atributos style en el HTML). @param {ParentNode} root */
function applyBarWidths(root) {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.hb[data-w]'))) {
    el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w) || 0))}%`;
  }
}
