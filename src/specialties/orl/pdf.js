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

/** @import { Color, PDFFont } from 'pdf-lib' */
/** @import { Atencion } from '../../domain' */
/** @import { ProcDef } from './config.js' */

/**
 * Nombre de archivo: ORL_2026-11-14_12345678-9_Nombre_Apellido.pdf
 * @param {Atencion} rec
 */
export function pdfFileName(rec) {
  const f = rec.f || {};
  return (
    ['ORL', f.fecha_atencion || 'sin_fecha', rutKey(f.paciente_rut) || null, fileSafe(f.paciente_nombre || 'paciente')]
      .filter(Boolean)
      .join('_') + '.pdf'
  );
}

/** Texto sin espacios en los extremos ('' si no hay). @param {string | undefined} v */
const trimmed = (v) => (v || '').trim();

/** Datos del paciente para la grilla de dos columnas: [etiqueta, valor]. @param {Record<string, string>} f */
function patientGrid(f) {
  return [
    ['Nombre', f.paciente_nombre],
    ['RUT', f.paciente_rut],
    ['Edad', trimmed(f.paciente_edad) ? trimmed(f.paciente_edad) + ' años' : ''],
    ['Sexo', SEXOS.find((s) => s.key === f.paciente_sexo)?.label || ''],
    ['Fono', f.paciente_fono],
    ['Fecha', fmtDate(f.fecha_atencion)],
  ];
}

/**
 * Contenido clínico de la hoja, en orden: [título, líneas]. Una sección sin líneas no se dibuja.
 * @param {Atencion} rec @param {ProcDef[]} procs
 * @returns {[string, string[]][]}
 */
export function clinicalSections(rec, procs) {
  const f = rec.f || {};
  const ant = antecedentsList(rec);
  const sol = requestedList(rec);
  const acc = actionsList(rec);
  const one = (/** @type {string} */ s) => (s ? [s] : []);
  return [
    ['Antecedentes', [ant.length ? ant.join(', ') : 'No refiere']],
    ['Motivo de consulta', one(trimmed(f.motivo_consulta))],
    ['Examen físico', examFindings(rec).map(([k, v]) => `${k}: ${v}`)],
    ['Procedimientos realizados', proceduresDone(rec, procs).map((p) => '- ' + procLabel(p))],
    ['Exámenes solicitados', one(sol.join(', '))],
    ['Diagnósticos', diagnosesList(rec).map((x) => '- ' + x)],
    ['Gestiones', one(acc.join(' | '))],
    ['Plan e indicaciones', one(trimmed(f.plan))],
    [
      'Seguimiento',
      [...one(trimmed(f.seguimiento) && 'Seguimiento: ' + trimmed(f.seguimiento)), ...one(trimmed(f.alta) && 'Alta: ' + trimmed(f.alta))],
    ],
  ];
}

/** Metadatos del documento. @param {PDFDocument} doc @param {Record<string, string>} f @param {Date} now */
function setMetadata(doc, f, now) {
  doc.setTitle(toWinAnsi(`Atención ${ESPECIALIDAD.nombre} - ${f.paciente_nombre || f.paciente_rut || ''} - ${fmtDate(f.fecha_atencion)}`));
  doc.setSubject(toWinAnsi(`Hoja de atención ${ESPECIALIDAD.nombre} - rondas y operativos`));
  doc.setAuthor(toWinAnsi(f.medico_nombre || APP.establecimiento));
  doc.setCreator(`${ESPECIALIDAD.nombre} HHR v${APP.version}`);
  doc.setCreationDate(now);
  doc.setModificationDate(now);
}

/**
 * Dibuja la hoja de una atención.
 * @param {Uint8Array} _templateBytes sin uso: ORL no tiene plantilla (la plataforma la pasa igual)
 * @param {Atencion} rec registro de atención
 * @param {ProcDef[]} procs
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
  // La primera hoja se agrega aquí; `newPage` agrega las siguientes.
  let page = doc.addPage(PAGE);
  let y = 0;

  /** @param {string} s @param {number} x @param {number} [size] @param {PDFFont} [fnt] @param {Color} [color] */
  const text = (s, x, size = SIZE, fnt = font, color = rgb(0, 0, 0)) => page.drawText(toWinAnsi(s), { x, y, size, font: fnt, color });
  const rule = () => page.drawLine({ start: { x: M, y }, end: { x: PAGE[0] - M, y }, thickness: 0.6, color: GREY });
  /** Encabezado de la hoja actual (deja `y` bajo él). */
  const header = () => {
    y = PAGE[1] - M;
    text(`HOJA DE ATENCIÓN ${ESPECIALIDAD.nombre.toUpperCase()}`, M, 13, bold);
    y -= 14;
    text(`Rondas y operativos - ${APP.establecimiento}${f.operativo?.trim() ? ' - ' + f.operativo.trim() : ''}`, M, 9, font, GREY);
    y -= 8;
    rule();
    y -= 18;
  };
  const newPage = () => {
    page = doc.addPage(PAGE);
    header();
  };
  header();
  /** @param {number} h */
  const ensure = (h) => {
    if (y - h < M + 24) newPage();
  };
  /** @param {string} t */
  const heading = (t) => {
    ensure(LINE * 2 + 4);
    text(t.toUpperCase(), M, SIZE, bold);
    y -= LINE;
  };
  /** @param {string} t */
  const paragraph = (t, indent = 0) => {
    for (const line of wrapText(t, font, SIZE, W - indent)) {
      ensure(LINE);
      text(line, M + indent);
      y -= LINE;
    }
  };
  /** @param {string} title @param {string[]} lines */
  const section = (title, lines) => {
    if (!lines.length) return;
    heading(title);
    lines.forEach((l) => paragraph(l));
    y -= 8;
  };

  /* ---- paciente: grilla de dos columnas ---- */
  const datos = patientGrid(f);
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
  for (const [title, lines] of clinicalSections(rec, procs)) section(title, lines);

  /* ---- firma ---- */
  ensure(60);
  y -= 30;
  const fx = PAGE[0] - M - 200;
  page.drawLine({ start: { x: fx, y }, end: { x: PAGE[0] - M, y }, thickness: 0.6, color: GREY });
  y -= 12;
  text([doctorName(f.medico_nombre), f.medico_rut?.trim() && 'RUT ' + f.medico_rut.trim()].filter(Boolean).join(' - ') || 'Firma', fx, 9);

  if (footer) drawFooters(doc, font, rec, now);

  setMetadata(doc, f, now);

  const bytes = await doc.save();
  return { bytes, pages: doc.getPageCount(), overflow: [] };
}

/**
 * @param {PDFDocument} doc
 * @param {PDFFont} font
 * @param {Atencion} rec
 * @param {Date} now
 */
function drawFooters(doc, font, rec, now) {
  const pages = doc.getPages();
  const left = toWinAnsi(`${APP.establecimiento} - ID atención ${rec.id || 'sin guardar'} - emitido ${fmtDateTime(now)}`);
  pages.forEach((p, i) => {
    p.drawText(left, { x: M, y: 24, size: 7, font, color: GREY });
    const right = `Página ${i + 1} de ${pages.length}`;
    p.drawText(right, { x: PAGE[0] - M - font.widthOfTextAtSize(right, 7), y: 24, size: 7, font, color: GREY });
  });
}
