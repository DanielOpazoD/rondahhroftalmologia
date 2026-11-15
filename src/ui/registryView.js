/**
 * Pestaña Registro: búsqueda y acciones sobre atenciones guardadas.
 */
import { escapeHtml, fmtDate, normalizeText, cleanRut } from '../core/format.js';
import { operativosOf } from '../core/stats.js';
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

export function renderRegistry(ctx) {
  const sel = $('#regOp');
  const ops = operativosOf(ctx.records);
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos los operativos</option>' + ops.map((o) => `<option>${escapeHtml(o)}</option>`).join('');
  sel.value = ops.includes(cur) ? cur : '';

  const q = $('#regSearch').value.trim();
  const op = sel.value;
  const list = ctx.records.filter((r) => (!op || r.f.operativo === op) && matchesQuery(r, q));
  $('#regCount').textContent = list.length;
  $('#regList').innerHTML = list.length
    ? list
        .map((r) => {
          const f = r.f;
          const n = Object.keys(r.proc || {}).length;
          const meta = [f.paciente_rut, fmtDate(f.fecha_atencion), f.paciente_edad && f.paciente_edad + ' a', `${n} proc.`, f.operativo].filter(Boolean).map(escapeHtml).join(' · ');
          return `<div class="it"><div class="t"><b>${escapeHtml(f.paciente_nombre || '(sin nombre)')}</b><span class="muted">${meta}</span></div>
          <button type="button" class="btn sm" data-a="open" data-id="${escapeHtml(r.id)}">Abrir</button>
          <button type="button" class="btn sm" data-a="pdf" data-id="${escapeHtml(r.id)}">PDF</button>
          <button type="button" class="btn sm" data-a="copy" data-id="${escapeHtml(r.id)}">Nota</button>
          <button type="button" class="btn d sm" data-a="del" data-id="${escapeHtml(r.id)}" aria-label="Eliminar atención">✕</button></div>`;
        })
        .join('')
    : `<p class="muted">${ctx.records.length ? 'Sin resultados para esta búsqueda.' : 'Aún no hay atenciones guardadas.'}</p>`;
}
