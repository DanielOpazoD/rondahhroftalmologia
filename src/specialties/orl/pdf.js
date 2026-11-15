/**
 * PDF de una atención ORL, dibujado desde cero con pdf-lib.
 *
 * No hay hoja oficial de ORL: en vez de rellenar una plantilla (como
 * oftalmología), se dibuja una hoja simple (título, paciente, examen,
 * diagnósticos, plan y firma) que pasa a una página nueva cuando no cabe.
 * Por eso esta especialidad no tiene plantilla.pdf (ver scripts/build.mjs).
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { APP, SEXOS } from '../../config/catalogs.js';
import { ESPECIALIDAD } from './config.js';
import { fmtDate, fmtDateTime, toWinAnsi, fileSafe, rutKey, doctorName } from '../../core/format.js';
import { wrapText } from '../../core/pdfTexto.js';
import { antecedentsList, requestedList, diagnosesList, proceduresDone, procLabel, examFindings, actionsList } from './clinica.js';

const PAGE = /** @type {[number, number]} */ ([612, 792]); // carta
const M = 54; // margen
const GREY = rgb(0.38, 0.42, 0.46);
const SIZE = 10;
const LINE = SIZE * 1.35;

/** Nombre de archivo: ORL_2026-11-14_12345678-9_Nombre_Apellido.pdf */
export function pdfFileName(rec) {
  const f = rec.f || {};
  return (
    ['ORL', f.fecha_atencion || 'sin_fecha', rutKey(f.paciente_rut) || null, fileSafe(f.paciente_nombre || 'paciente')]
      .filter(Boolean)
      .join('_') + '.pdf'
  );
}

/**
 * Dibuja la hoja de una atención.
 * @param {Uint8Array} _templateBytes sin uso: ORL no tiene plantilla (la plataforma la pasa igual)
 * @param {object} rec registro de atención
 * @param {import('./config.js').ProcDef[]} procs
 * @param {{footer?: boolean, now?: Date}} [opts]
 * @returns {Promise<{bytes: Uint8Array, pages: number, overflow: string[]}>} `overflow` siempre vacío: nada se recorta
 */
export async function buildAttentionPdf(_templateBytes, rec, procs, opts = {}) {
  const { footer = true, now = new Date() } = opts;
  const f = rec.f || {};
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = PAGE[0] - 2 * M;
  /** @type {import('pdf-lib').PDFPage} */
  let page;
  let y = 0;

  const text = (s, x, size = SIZE, fnt = font, color = rgb(0, 0, 0)) => page.drawText(toWinAnsi(s), { x, y, size, font: fnt, color });
  const rule = () => page.drawLine({ start: { x: M, y }, end: { x: PAGE[0] - M, y }, thickness: 0.6, color: GREY });
  const newPage = () => {
    page = doc.addPage(PAGE);
    y = PAGE[1] - M;
    text(`HOJA DE ATENCIÓN ${ESPECIALIDAD.nombre.toUpperCase()}`, M, 13, bold);
    y -= 14;
    text(`Rondas y operativos - ${APP.establecimiento}${f.operativo?.trim() ? ' - ' + f.operativo.trim() : ''}`, M, 9, font, GREY);
    y -= 8;
    rule();
    y -= 18;
  };
  const ensure = (h) => {
    if (y - h < M + 24) newPage();
  };
  const heading = (t) => {
    ensure(LINE * 2 + 4);
    text(t.toUpperCase(), M, SIZE, bold);
    y -= LINE;
  };
  const paragraph = (t, indent = 0) => {
    for (const line of wrapText(t, font, SIZE, W - indent)) {
      ensure(LINE);
      text(line, M + indent);
      y -= LINE;
    }
  };
  const section = (title, lines) => {
    if (!lines.length) return;
    heading(title);
    lines.forEach((l) => paragraph(l));
    y -= 8;
  };

  newPage();

  /* ---- paciente: grilla de dos columnas ---- */
  const sexo = SEXOS.find((s) => s.key === f.paciente_sexo)?.label || '';
  const datos = [
    ['Nombre', f.paciente_nombre],
    ['RUT', f.paciente_rut],
    ['Edad', f.paciente_edad?.trim() ? f.paciente_edad.trim() + ' años' : ''],
    ['Sexo', sexo],
    ['Fono', f.paciente_fono],
    ['Fecha', fmtDate(f.fecha_atencion)],
  ];
  for (let i = 0; i < datos.length; i += 2) {
    datos.slice(i, i + 2).forEach(([k, v], j) => {
      const x = M + j * (W / 2);
      let s = toWinAnsi((v || '').trim() || '-');
      while (s.length > 1 && font.widthOfTextAtSize(s, 9) > W / 2 - 56) s = s.slice(0, -1);
      text(k + ':', x, 9, bold);
      text(s, x + 48, 9);
    });
    y -= LINE;
  }
  y -= 4;
  rule();
  y -= 18;

  /* ---- contenido clínico ---- */
  const ant = antecedentsList(rec);
  section('Antecedentes', [ant.length ? ant.join(', ') : 'No refiere']);
  section('Motivo de consulta', f.motivo_consulta?.trim() ? [f.motivo_consulta.trim()] : []);
  section(
    'Examen físico',
    examFindings(rec).map(([k, v]) => `${k}: ${v}`),
  );
  section(
    'Procedimientos realizados',
    proceduresDone(rec, procs).map((p) => '- ' + procLabel(p)),
  );
  const sol = requestedList(rec);
  section('Exámenes solicitados', sol.length ? [sol.join(', ')] : []);
  section(
    'Diagnósticos',
    diagnosesList(rec).map((x) => '- ' + x),
  );
  const acc = actionsList(rec);
  section('Gestiones', acc.length ? [acc.join(' | ')] : []);
  section('Plan e indicaciones', f.plan?.trim() ? [f.plan.trim()] : []);
  section(
    'Seguimiento',
    [f.seguimiento?.trim() && 'Seguimiento: ' + f.seguimiento.trim(), f.alta?.trim() && 'Alta: ' + f.alta.trim()].filter(Boolean),
  );

  /* ---- firma ---- */
  ensure(60);
  y -= 30;
  const fx = PAGE[0] - M - 200;
  page.drawLine({ start: { x: fx, y }, end: { x: PAGE[0] - M, y }, thickness: 0.6, color: GREY });
  y -= 12;
  text([doctorName(f.medico_nombre), f.medico_rut?.trim() && 'RUT ' + f.medico_rut.trim()].filter(Boolean).join(' - ') || 'Firma', fx, 9);

  if (footer) drawFooters(doc, font, rec, now);

  doc.setTitle(toWinAnsi(`Atención ${ESPECIALIDAD.nombre} - ${f.paciente_nombre || f.paciente_rut || ''} - ${fmtDate(f.fecha_atencion)}`));
  doc.setSubject(toWinAnsi(`Hoja de atención ${ESPECIALIDAD.nombre} - rondas y operativos`));
  doc.setAuthor(toWinAnsi(f.medico_nombre || APP.establecimiento));
  doc.setCreator(`${ESPECIALIDAD.nombre} HHR v${APP.version}`);
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const bytes = await doc.save();
  return { bytes, pages: doc.getPageCount(), overflow: [] };
}

function drawFooters(doc, font, rec, now) {
  const pages = doc.getPages();
  const left = toWinAnsi(`${APP.establecimiento} - ID atención ${rec.id || 'sin guardar'} - emitido ${fmtDateTime(now)}`);
  pages.forEach((p, i) => {
    p.drawText(left, { x: M, y: 24, size: 7, font, color: GREY });
    const right = `Página ${i + 1} de ${pages.length}`;
    p.drawText(right, { x: PAGE[0] - M - font.widthOfTextAtSize(right, 7), y: 24, size: 7, font, color: GREY });
  });
}
