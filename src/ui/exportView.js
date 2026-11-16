/**
 * Descargas de la pestaña Reportes (junto a la estadística, con el mismo
 * filtro): Excel de estadística, PDF de cada atención y datos seudonimizados.
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
import { $, download, toast, nextFrame } from './dom.js';
import { withBusy } from './busy.js';
import { uiConfirm } from './modal.js';
import { openMenu } from './menu.js';
import { html, setHtml } from './html.js';

/** @typedef {import('./context.js').AppContext} AppContext */
/** @typedef {import('../domain').Atencion} Atencion */

/**
 * Sufijo de archivo según el filtro: _OperativoNov_2026-11-14.
 * @param {AppContext} ctx
 */
function suffix(ctx) {
  const f = ctx.filter;
  return [f.operativo && fileSafe(f.operativo, 30), f.desde, f.hasta].filter(Boolean).join('_') || todayIso();
}

/** @param {AppContext} ctx */
export function initExportView(ctx) {
  /**
   * @param {string} sel
   * @param {string[][]} opts pares [valor, etiqueta]
   * @param {string} value elegido
   */
  const fill = (sel, opts, value) => {
    setHtml($(sel), html`${opts.map(([v, l]) => html`<option value="${v}">${l}</option>`)}`);
    $(sel).value = value;
  };
  fill('#anFechas', ANON_OPTIONS.fechas, ANON_DEFAULTS.fechas);
  fill('#anEdad', ANON_OPTIONS.edad, ANON_DEFAULTS.edad);
  fill('#anTexto', ANON_OPTIONS.texto, ANON_DEFAULTS.texto);
  ['#anFechas', '#anEdad', '#anTexto'].forEach((s) => $(s).addEventListener('change', () => ($('#anPre').hidden = true)));

  $('#repDownload').addEventListener('click', async (/** @type {MouseEvent} */ e) => {
    const button = /** @type {HTMLButtonElement} */ (e.currentTarget);
    const n = ctx.filtered().length;
    const choice = await openMenu(
      button,
      [
        { value: 'xlsx', label: 'Estadística (Excel)', hint: 'Resumen, atenciones, prestaciones, por día, edad y sexo' },
        { value: 'pdfs', label: 'PDF de cada atención', hint: `${n} ${n === 1 ? 'hoja' : 'hojas'} en un ZIP`, disabled: !n },
        { value: 'anXlsx', label: 'Datos seudonimizados (Excel)', hint: 'Sin nombre, RUT ni teléfono' },
        { value: 'anJson', label: 'Datos seudonimizados (JSON)' },
      ],
      { label: 'Descargar' },
    );
    if (choice === 'xlsx') exportStatsXlsx(ctx, button);
    if (choice === 'pdfs') void exportPdfZip(ctx, button);
    if (choice === 'anXlsx') exportAnon(ctx, 'xlsx', button);
    if (choice === 'anJson') exportAnon(ctx, 'json', button);
  });
  $('#anPreview').addEventListener('click', () => preview(ctx));
  /** Botón que recibió el clic. @param {MouseEvent} e */
  const target = (e) => /** @type {HTMLButtonElement} */ (e.currentTarget);
  $('#anXlsx').addEventListener('click', (/** @type {MouseEvent} */ e) => exportAnon(ctx, 'xlsx', target(e)));
  $('#anJson').addEventListener('click', (/** @type {MouseEvent} */ e) => exportAnon(ctx, 'json', target(e)));
  $('#anKey').addEventListener('click', (/** @type {MouseEvent} */ e) => exportKeyTable(ctx, target(e)));
}

/** @param {AppContext} ctx */
export function renderExportView(ctx) {
  const s = ctx.store.loadSecret();
  $('#anFp').textContent = s ? secretFingerprint(s) : 'se crea en la primera exportación';
}

/**
 * Verifica que haya datos en el filtro; avisa si no.
 * @param {AppContext} ctx
 * @returns {Atencion[] | null}
 */
function requireData(ctx) {
  const list = ctx.filtered();
  if (!list.length) {
    toast('No hay atenciones en el filtro');
    return null;
  }
  return list;
}

/**
 * Excel de estadística (también lo usa la pestaña Estadística).
 * @param {AppContext} ctx
 * @param {HTMLButtonElement} button
 */
export function exportStatsXlsx(ctx, button) {
  const list = requireData(ctx);
  if (!list) return;
  return withBusy(button, async () => {
    const bytes = buildXlsx(statsWorkbook(list, ctx.procs, ctx.filter), {
      title: 'Estadística oftalmología',
      creator: 'Hospital Hanga Roa',
    });
    download(bytes, `estadistica_oftalmo_${suffix(ctx)}.xlsx`, XLSX_MIME);
    ctx.accounts?.event('exportar.excel', undefined, { n: list.length });
    toast('Excel descargado');
  });
}

/**
 * @param {AppContext} ctx
 * @param {HTMLButtonElement} button
 */
async function exportPdfZip(ctx, button) {
  const list = requireData(ctx);
  if (!list) return;
  const prog = $('#expPdfProg');
  await withBusy(button, async () => {
    const tpl = ctx.templateBytes();
    /** @type {{name: string, data: Uint8Array}[]} */
    const entries = [];
    /** @type {Atencion[]} */
    const withAnnex = [];
    for (let i = 0; i < list.length; i++) {
      prog.textContent = `Generando ${i + 1} de ${list.length}…`;
      await nextFrame();
      const r = await buildAttentionPdf(tpl, list[i], ctx.procs, ctx.pdfOptions());
      entries.push({ name: pdfFileName(list[i]), data: r.bytes });
      if (r.overflow.length) withAnnex.push(list[i]);
    }
    download(createZip(entries), `pdf_oftalmo_${suffix(ctx)}.zip`, 'application/zip');
    ctx.accounts?.event('exportar.pdfs', undefined, { n: list.length });
    prog.textContent = `${list.length} PDF generados` + (withAnnex.length ? ` (${withAnnex.length} con hoja complementaria)` : '') + '.';
  });
}

/**
 * Clave del equipo; se crea al primer uso.
 * @param {AppContext} ctx
 */
function secret(ctx) {
  return ctx.ensureSecret();
}

function anonOptions() {
  return { fechas: $('#anFechas').value, edad: $('#anEdad').value, texto: $('#anTexto').value };
}

/**
 * Seudonimiza y verifica fugas. Muestra el resultado de la verificación.
 * @param {AppContext} ctx
 * @param {Atencion[]} list
 */
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

/** @param {AppContext} ctx */
function preview(ctx) {
  const list = requireData(ctx);
  if (!list) return;
  const { result } = runAnon(ctx, list);
  const pre = $('#anPre');
  pre.hidden = false;
  pre.textContent =
    JSON.stringify(result.registros.slice(0, 3), null, 2) + (result.registros.length > 3 ? `\n… y ${result.registros.length - 3} más` : '');
}

/**
 * @param {AppContext} ctx
 * @param {'xlsx' | 'json'} format
 * @param {HTMLButtonElement} button
 */
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
    ctx.accounts?.event('exportar.seudonimizado', undefined, { n: list.length });
    toast('Exportación seudonimizada descargada');
  });
}

/**
 * @param {AppContext} ctx
 * @param {HTMLButtonElement} button
 */
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
    ctx.accounts?.event('exportar.correspondencia', undefined, { n: list.length });
  });
}
