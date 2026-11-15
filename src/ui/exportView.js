/**
 * Pestaña Exportar: PDFs en lote, Excel de estadística y datos seudonimizados.
 */
import { todayIso, fileSafe } from '../core/format.js';
import {
  statsWorkbook,
  anonymizeRecords,
  anonymizedJson,
  anonymizedSheets,
  buildAttentionPdf,
  pdfFileName,
} from '../specialties/activa/index.js';
import { ANON_DEFAULTS, ANON_OPTIONS, correspondenciaSheets, findLeaks, secretFingerprint } from '../core/pseudonym.js';
import { buildXlsx, XLSX_MIME } from '../lib/xlsx.js';
import { createZip } from '../lib/zip.js';
import { $, download, toast, withBusy, nextFrame } from './dom.js';
import { uiConfirm } from './modal.js';
import { html, setHtml } from './html.js';

/** Sufijo de archivo según el filtro: _OperativoNov_2026-11-14. */
function suffix(ctx) {
  const f = ctx.filter;
  return [f.operativo && fileSafe(f.operativo, 30), f.desde, f.hasta].filter(Boolean).join('_') || todayIso();
}

/** @param {import('./context.js').AppContext} ctx */
export function initExportView(ctx) {
  const fill = (sel, opts, value) => {
    setHtml($(sel), html`${opts.map(([v, l]) => html`<option value="${v}">${l}</option>`)}`);
    $(sel).value = value;
  };
  fill('#anFechas', ANON_OPTIONS.fechas, ANON_DEFAULTS.fechas);
  fill('#anEdad', ANON_OPTIONS.edad, ANON_DEFAULTS.edad);
  fill('#anTexto', ANON_OPTIONS.texto, ANON_DEFAULTS.texto);
  ['#anFechas', '#anEdad', '#anTexto'].forEach((s) => $(s).addEventListener('change', () => ($('#anPre').hidden = true)));

  $('#expXlsx').addEventListener('click', (e) => exportStatsXlsx(ctx, e.currentTarget));
  $('#expPdfZip').addEventListener('click', (e) => exportPdfZip(ctx, e.currentTarget));
  $('#anPreview').addEventListener('click', () => preview(ctx));
  $('#anXlsx').addEventListener('click', (e) => exportAnon(ctx, 'xlsx', e.currentTarget));
  $('#anJson').addEventListener('click', (e) => exportAnon(ctx, 'json', e.currentTarget));
  $('#anKey').addEventListener('click', (e) => exportKeyTable(ctx, e.currentTarget));
}

export function renderExportView(ctx) {
  const n = ctx.filtered().length;
  $('#expPdfZip').textContent = n ? `Descargar (${n})` : 'Descargar';
  const s = ctx.store.loadSecret();
  $('#anFp').textContent = s ? secretFingerprint(s) : 'se crea en la primera exportación';
}

/** Verifica que haya datos en el filtro; avisa si no. */
function requireData(ctx) {
  const list = ctx.filtered();
  if (!list.length) {
    toast('No hay atenciones en el filtro');
    return null;
  }
  return list;
}

/** Excel de estadística (también lo usa la pestaña Estadística). */
export function exportStatsXlsx(ctx, button) {
  const list = requireData(ctx);
  if (!list) return;
  return withBusy(button, async () => {
    const bytes = buildXlsx(statsWorkbook(list, ctx.procs, ctx.filter), {
      title: 'Estadística oftalmología',
      creator: 'Hospital Hanga Roa',
    });
    download(bytes, `estadistica_oftalmo_${suffix(ctx)}.xlsx`, XLSX_MIME);
    toast('Excel descargado');
  });
}

async function exportPdfZip(ctx, button) {
  const list = requireData(ctx);
  if (!list) return;
  const prog = $('#expPdfProg');
  await withBusy(button, async () => {
    const tpl = ctx.templateBytes();
    const entries = [];
    const withAnnex = [];
    for (let i = 0; i < list.length; i++) {
      prog.textContent = `Generando ${i + 1} de ${list.length}…`;
      await nextFrame();
      const r = await buildAttentionPdf(tpl, list[i], ctx.procs, ctx.pdfOptions());
      entries.push({ name: pdfFileName(list[i]), data: r.bytes });
      if (r.overflow.length) withAnnex.push(list[i]);
    }
    download(createZip(entries), `pdf_oftalmo_${suffix(ctx)}.zip`, 'application/zip');
    prog.textContent = `${list.length} PDF generados` + (withAnnex.length ? ` (${withAnnex.length} con hoja complementaria)` : '') + '.';
  });
}

/** Clave del equipo; se crea al primer uso. */
function secret(ctx) {
  return ctx.ensureSecret();
}

function anonOptions() {
  return { fechas: $('#anFechas').value, edad: $('#anEdad').value, texto: $('#anTexto').value };
}

/** Seudonimiza y verifica fugas. Muestra el resultado de la verificación. */
function runAnon(ctx, list) {
  const result = anonymizeRecords(list, ctx.procs, { ...anonOptions(), secret: secret(ctx) });
  const leaks = findLeaks(JSON.stringify(result.registros), list);
  const box = $('#anCheck');
  box.hidden = false;
  if (leaks.length) {
    box.className = 'banner warn';
    box.textContent =
      `Atención: se encontraron ${leaks.length} posible(s) identificador(es) en los textos (` +
      leaks
        .slice(0, 6)
        .map((l) => `${l.tipo} ${l.muestra}`)
        .join(', ') +
      '). Puede ser una coincidencia con una palabra común; revisa la vista previa o elige «Excluir textos libres».';
  } else {
    box.className = 'banner ok';
    box.textContent = `Verificación automática: no se encontraron nombres, RUT ni teléfonos de los ${result.correspondencia.length} pacientes en la salida.`;
  }
  renderExportView(ctx);
  return { result, leaks };
}

function preview(ctx) {
  const list = requireData(ctx);
  if (!list) return;
  const { result } = runAnon(ctx, list);
  const pre = $('#anPre');
  pre.hidden = false;
  pre.textContent =
    JSON.stringify(result.registros.slice(0, 3), null, 2) + (result.registros.length > 3 ? `\n… y ${result.registros.length - 3} más` : '');
}

function exportAnon(ctx, format, button) {
  const list = requireData(ctx);
  if (!list) return;
  return withBusy(button, async () => {
    const { result, leaks } = runAnon(ctx, list);
    if (
      leaks.length &&
      !(await uiConfirm({
        title: 'Posibles identificadores',
        message: 'La verificación encontró posibles identificadores en los textos (detalle bajo la lista). ¿Descargar igual?',
        tone: 'warn',
        okLabel: 'Descargar igual',
      }))
    ) {
      return;
    }
    const name = `oftalmo_seudonimizado_${suffix(ctx)}`;
    if (format === 'json') {
      download(JSON.stringify(anonymizedJson(result), null, 2), name + '.json', 'application/json');
    } else {
      download(buildXlsx(anonymizedSheets(result, ctx.procs), { title: 'Datos seudonimizados' }), name + '.xlsx', XLSX_MIME);
    }
    toast('Exportación seudonimizada descargada');
  });
}

async function exportKeyTable(ctx, button) {
  const list = requireData(ctx);
  if (!list) return;
  if (
    !(await uiConfirm({
      title: 'Tabla de correspondencia',
      message:
        'Contiene nombres y RUT: permite volver a identificar a los pacientes. Guárdala en un lugar seguro, separada de los datos seudonimizados, y no la subas a servicios externos.',
      tone: 'warn',
      okLabel: 'Descargar',
    }))
  ) {
    return;
  }
  return withBusy(button, async () => {
    const result = anonymizeRecords(list, ctx.procs, { ...anonOptions(), secret: secret(ctx) });
    download(
      buildXlsx(correspondenciaSheets(result), { title: 'CONFIDENCIAL' }),
      `CONFIDENCIAL_correspondencia_${suffix(ctx)}.xlsx`,
      XLSX_MIME,
    );
  });
}
