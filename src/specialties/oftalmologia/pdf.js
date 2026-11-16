/**
 * Generación del PDF de una atención sobre la plantilla oficial con campos
 * rellenables (assets/plantilla_hoja_atencion.pdf).
 *
 * Mejoras respecto de la v1:
 *  - Nada se pierde: si un texto no cabe en su casilla con letra legible
 *    (mín. 7 pt), se escribe lo que cabe con "(cont. hoja 2)" y el texto
 *    completo va a una HOJA COMPLEMENTARIA.
 *  - Los procedimientos realizados ya no se comprimen en letra de 4 pt:
 *    si no caben, se resumen en la hoja 1 y se listan en una tabla
 *    (procedimiento, ojo, PIO) en la hoja complementaria.
 *  - Pie de página con ID de atención, fecha de emisión y número de página.
 *  - Metadatos del documento (título, autor, asunto).
 *  - Formulario "aplanado" opcional: el PDF queda no editable y se ve igual
 *    en cualquier visor o sistema al que se suba.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { APP } from '../../config/catalogs.js';
import { ANTECEDENTES, SOLICITADOS, DIAGNOSTICOS } from './config.js';
import { fmtDate, fmtDateTime, toWinAnsi, fileSafe, rutKey, doctorName } from '../../core/format.js';
import { proceduresDone, procLabel, pioFor, procDescriptions } from './clinica.js';

const MIN_LINE_PT = 7; // tamaño mínimo legible en líneas
const MIN_BOX_PT = 6.5; // tamaño mínimo en recuadros multilínea
const MAX_PT = 10;
const GREY = rgb(0.38, 0.42, 0.46);

/**
 * Divide un texto en líneas que caben en `width` con la fuente y tamaño dados.
 * Respeta saltos de línea y corta palabras demasiado largas.
 */
export function wrapText(text, font, size, width) {
  const out = [];
  const max = width - 4;
  for (const par of toWinAnsi(text).split('\n')) {
    let line = '';
    for (let word of par.split(/\s+/).filter(Boolean)) {
      const candidate = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= max) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      while (font.widthOfTextAtSize(word, size) > max && word.length > 1) {
        let i = word.length;
        while (i > 1 && font.widthOfTextAtSize(word.slice(0, i), size) > max) i--;
        out.push(word.slice(0, i));
        word = word.slice(i);
      }
      line = word;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Nombre de archivo: Oftalmo_2026-11-14_12345678-9_Nombre_Apellido.pdf */
export function pdfFileName(rec) {
  const f = rec.f || {};
  const rut = rutKey(f.paciente_rut);
  return (
    ['Oftalmo', f.fecha_atencion || 'sin_fecha', rut || null, fileSafe(f.paciente_nombre || 'paciente')].filter(Boolean).join('_') + '.pdf'
  );
}

/**
 * Rellena la plantilla con una atención.
 * @param {Uint8Array} templateBytes bytes de la plantilla PDF
 * @param {object} rec registro de atención
 * @param {import('./config.js').ProcDef[]} procs
 * @param {{flatten?: boolean, footer?: boolean, now?: Date}} [opts]
 * @returns {Promise<{bytes: Uint8Array, pages: number, overflow: string[]}>}
 *   `overflow`: secciones que se completaron en la hoja complementaria.
 */
export async function buildAttentionPdf(templateBytes, rec, procs, opts = {}) {
  const { flatten = true, footer = true, now = new Date() } = opts;
  const f = rec.f || {};
  const doc = await PDFDocument.load(templateBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  /** Secciones cuyo texto completo va a la hoja complementaria: [título, texto]. */
  const annex = [];

  /* ---- helpers de campos ---- */
  const field = (name) => {
    try {
      return form.getTextField(name);
    } catch {
      return null; // la plantilla no tiene ese campo: se ignora
    }
  };
  const rect = (fl) => fl.acroField.getWidgets()[0].getRectangle();
  const setSize = (fl, size) => fl.acroField.setDefaultAppearance(`0 g /Helv ${Math.round(size * 2) / 2} Tf`);

  /** Campo de una línea: reduce la letra hasta que quepa; si no cabe, recorta. */
  /** @param {string} name @param {string} value @param {{max?: number, title?: string}} [opts] */
  const setSingle = (name, value, { max = MAX_PT, title } = {}) => {
    const fl = field(name);
    const s = toWinAnsi(value).replace(/\n+/g, ' ').trim();
    if (!fl || !s) return;
    const w = rect(fl).width - 4;
    let size = max;
    while (size > MIN_LINE_PT && font.widthOfTextAtSize(s, size) > w) size -= 0.5;
    let text = s;
    if (font.widthOfTextAtSize(s, size) > w) {
      const tail = '... (cont. hoja 2)';
      while (text.length > 1 && font.widthOfTextAtSize(text + tail, size) > w) text = text.slice(0, -1);
      text = text.trimEnd() + tail;
      if (title) annex.push([title, value]);
    }
    fl.setText(text);
    setSize(fl, size);
  };

  /** Texto repartido en varios campos de una línea (motivo, plan, observaciones). */
  /** @returns {{fits: boolean, lines: string[], size?: number}} */
  const fitLines = (names, value) => {
    const fls = names.map(field).filter(Boolean);
    if (!fls.length || !value?.trim()) return { fits: true, lines: [] };
    const w = rect(fls[0]).width;
    for (let size = MAX_PT; size >= MIN_LINE_PT; size -= 0.5) {
      const lines = wrapText(value, font, size, w);
      if (lines.length <= fls.length) return { fits: true, lines, size };
    }
    return { fits: false, lines: wrapText(value, font, MIN_LINE_PT, w), size: MIN_LINE_PT };
  };
  /** @param {string[]} names @param {{lines: string[], size?: number}} fit */
  const writeLines = (names, { lines, size }) => {
    names.map(field).forEach((fl, i) => {
      if (!fl) return;
      fl.setText(lines[i] || '');
      setSize(fl, size || MAX_PT);
    });
  };
  const setLines = (names, value, title) => {
    const r = fitLines(names, value);
    if (!r.lines.length) return;
    if (!r.fits) {
      const tail = ' ... (cont. hoja 2)';
      const kept = r.lines.slice(0, names.length);
      const w = rect(field(names[0])).width - 4;
      let last = kept[kept.length - 1];
      while (last.length > 1 && font.widthOfTextAtSize(last + tail, r.size) > w) last = last.slice(0, -1);
      kept[kept.length - 1] = last.trimEnd() + tail;
      r.lines = kept;
      annex.push([title, value]);
    }
    writeLines(names, r);
  };

  /** Recuadro multilínea (hallazgos, otros diagnósticos). */
  const setBox = (name, value, title) => {
    const fl = field(name);
    if (!fl || !value?.trim()) return;
    fl.enableMultiline();
    const r = rect(fl);
    let size = MAX_PT;
    let lines = wrapText(value, font, size, r.width);
    const fitsAt = (sz, ls) => ls.length * sz * 1.15 <= r.height - 2;
    while (size > MIN_BOX_PT && !fitsAt(size, lines)) {
      size -= 0.5;
      lines = wrapText(value, font, size, r.width);
    }
    if (!fitsAt(size, lines)) {
      const maxLines = Math.max(1, Math.floor((r.height - 2) / (size * 1.15)));
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,14}$/, '') + '...(hoja 2)';
      annex.push([title, value]);
    }
    fl.setText(lines.join('\n'));
    setSize(fl, size);
  };

  /* ---- datos del paciente ---- */
  for (const k of [
    'paciente_nombre',
    'paciente_rut',
    'paciente_edad',
    'paciente_fono',
    'medico_nombre',
    'medico_rut',
    'test_schirmer_detalle',
  ]) {
    setSingle(k, f[k]);
  }
  setSingle('fecha_atencion', fmtDate(f.fecha_atencion));
  setSingle('antecedente_cirugia_detalle', f.antecedente_cirugia_detalle, { title: 'Antecedente quirúrgico' });
  setSingle('antecedentes_otros', f.antecedentes_otros, { title: 'Otros antecedentes' });
  setLines(['motivo_consulta_1', 'motivo_consulta_2', 'motivo_consulta_3', 'motivo_consulta_4'], f.motivo_consulta, 'Motivo de consulta');

  /* ---- examen físico ---- */
  for (const e of ['od', 'oi']) {
    const E = e.toUpperCase();
    setSingle(`${e}_av`, f[`${e}_av`], { title: `AV ${E}` });
    setSingle(`${e}_avcc`, f[`${e}_avcc`], { title: `AVcc ${E}` });
    setSingle(`${e}_pio`, pioFor(rec, e, procs), { title: `PIO ${E}` });
    // Recuadro del ojo: hallazgos y, debajo, las descripciones de procedimientos («FO: …», «BMC: …»).
    const box = [(f[`${e}_hallazgos`] || '').trim(), ...procDescriptions(rec, e, procs)].filter(Boolean).join('\n');
    setBox(`${e}_hallazgos`, box, `Examen ${E}`);
  }

  /* ---- observaciones + procedimientos realizados ---- */
  const done = proceduresDone(rec, procs);
  const obsNames = ['examen_observaciones_1', 'examen_observaciones_2'];
  const obs = (f.examen_obs || '').trim();
  const procText = done.length ? `Proc. realizados: ${done.map((p) => procLabel(p, { desc: false })).join('; ')}.` : '';
  const full = [obs, procText].filter(Boolean).join(' | ');
  let procsInAnnex = false;
  if (full) {
    const r = fitLines(obsNames, full);
    if (r.fits) {
      writeLines(obsNames, r);
    } else {
      procsInAnnex = done.length > 0;
      const short = [obs, done.length ? `Proc. realizados (${done.length}): ver detalle en hoja complementaria.` : '']
        .filter(Boolean)
        .join(' | ');
      setLines(obsNames, short, 'Observaciones del examen');
      // si `short` tampoco cabe, setLines ya agregó las observaciones completas al anexo
    }
  }

  /* ---- solicitados, diagnósticos, acciones ---- */
  setSingle('procedimientos_otros', f.procedimientos_otros, { title: 'Otros procedimientos solicitados' });
  setBox('diagnosticos_otros', f.diagnosticos_otros, 'Otros diagnósticos');
  setSingle('ges', f.ges, { title: 'GES' });
  setSingle('interconsulta', f.interconsulta, { title: 'Interconsulta' });
  setSingle('receta', f.receta, { title: 'Receta' });
  setSingle('diagnosticos_acciones_otros', f.diagnosticos_acciones_otros, { title: 'Otras acciones' });

  /* ---- plan ---- */
  setLines(
    [
      'plan_indicaciones_1',
      'plan_indicaciones_2',
      'plan_indicaciones_3',
      'plan_indicaciones_4',
      'plan_indicaciones_5',
      'plan_indicaciones_6',
    ],
    f.plan,
    'Plan e indicaciones',
  );
  setSingle('seguimiento', f.seguimiento, { title: 'Seguimiento' });
  setSingle('alta', f.alta, { title: 'Alta' });

  /* ---- casillas ---- */
  for (const { key } of [...ANTECEDENTES, ...SOLICITADOS, ...DIAGNOSTICOS]) {
    try {
      const c = form.getCheckBox(key);
      rec.checks?.[key] ? c.check() : c.uncheck();
    } catch {
      /* casilla ausente en la plantilla */
    }
  }
  try {
    const cat = rec.checks?.diagnostico_catarata;
    const od = form.getCheckBox('diagnostico_catarata_od');
    const oi = form.getCheckBox('diagnostico_catarata_oi');
    cat && (rec.cat === 'OD' || rec.cat === 'AO') ? od.check() : od.uncheck();
    cat && (rec.cat === 'OI' || rec.cat === 'AO') ? oi.check() : oi.uncheck();
  } catch {
    /* casillas ausentes */
  }

  form.updateFieldAppearances(font);
  if (flatten) form.flatten();

  // La página 2 de la plantilla está en blanco: se reemplaza por la hoja complementaria si hace falta.
  while (doc.getPageCount() > 1) doc.removePage(doc.getPageCount() - 1);
  if (annex.length || procsInAnnex) {
    drawAnnex(doc, { font, bold }, rec, procs, annex, procsInAnnex ? done : []);
  }

  if (footer) drawFooters(doc, font, rec, now);

  doc.setTitle(toWinAnsi(`Atención oftalmológica - ${f.paciente_nombre || f.paciente_rut || ''} - ${fmtDate(f.fecha_atencion)}`));
  doc.setSubject('Hoja de atención oftalmológica - rondas y operativos');
  doc.setAuthor(toWinAnsi(f.medico_nombre || APP.establecimiento));
  doc.setCreator(`${APP.nombre} v${APP.version}`);
  doc.setKeywords([APP.establecimiento, f.operativo || ''].filter(Boolean).map(toWinAnsi));
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const bytes = await doc.save();
  return {
    bytes,
    pages: doc.getPageCount(),
    overflow: [...annex.map((a) => a[0]), ...(procsInAnnex ? ['Procedimientos realizados'] : [])],
  };
}

/* --------------------------------------------------- hoja complementaria */

function drawAnnex(doc, fonts, rec, procs, sections, done) {
  const { font, bold } = fonts;
  const { width, height } = doc.getPage(0).getSize();
  const M = 54; // margen
  const W = width - 2 * M;
  const f = rec.f || {};
  /** @type {import('pdf-lib').PDFPage} */
  let page;
  let y = 0;

  const newPage = () => {
    page = doc.addPage([width, height]);
    y = height - M;
    page.drawText('HOJA COMPLEMENTARIA - ATENCIÓN OFTALMOLÓGICA', { x: M, y, size: 12, font: bold });
    y -= 16;
    const id = [f.paciente_nombre, f.paciente_rut && 'RUT ' + f.paciente_rut, f.fecha_atencion && 'Fecha ' + fmtDate(f.fecha_atencion)]
      .filter(Boolean)
      .join('   |   ');
    page.drawText(toWinAnsi(id), { x: M, y, size: 9.5, font });
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 0.8, color: GREY });
    y -= 20;
  };
  const ensure = (h) => {
    if (y - h < M + 20) newPage();
  };
  const heading = (t) => {
    ensure(30);
    page.drawText(toWinAnsi(t.toUpperCase()), { x: M, y, size: 10, font: bold });
    y -= 14;
  };
  const paragraph = (t, size = 9.5) => {
    for (const line of wrapText(t, font, size, W)) {
      ensure(size * 1.35);
      page.drawText(line, { x: M, y, size, font });
      y -= size * 1.35;
    }
    y -= 8;
  };

  newPage();

  if (done.length) {
    heading('Procedimientos realizados');
    const cols = [
      { t: 'Procedimiento', w: W * 0.55 },
      { t: 'Ojo', w: W * 0.11 },
      { t: 'PIO OD (mmHg)', w: W * 0.17 },
      { t: 'PIO OI (mmHg)', w: W * 0.17 },
    ];
    const rowH = 15;
    const row = (cells, fnt) => {
      ensure(rowH);
      let x = M;
      cells.forEach((c, i) => {
        page.drawText(toWinAnsi(String(c)), { x: x + 3, y: y - 10.5, size: 9, font: fnt });
        x += cols[i].w;
      });
      page.drawLine({ start: { x: M, y: y - rowH }, end: { x: M + W, y: y - rowH }, thickness: 0.4, color: GREY });
      y -= rowH;
    };
    row(
      cols.map((c) => c.t),
      bold,
    );
    done.forEach((p) => row([p.nombre, p.ojo, p.pioOd, p.pioOi], font));
    y -= 6;
    page.drawText(`Total: ${done.length} procedimientos, ${done.reduce((a, p) => a + p.ojos, 0)} ojos.`, { x: M, y: y - 4, size: 9, font });
    y -= 26;
  }

  for (const [title, text] of sections) {
    heading(title);
    paragraph(text);
  }

  ensure(60);
  y -= 20;
  page.drawLine({ start: { x: width - M - 200, y }, end: { x: width - M, y }, thickness: 0.6, color: GREY });
  y -= 12;
  const firma = toWinAnsi([doctorName(f.medico_nombre), f.medico_rut && 'RUT ' + f.medico_rut].filter(Boolean).join(' - '));
  page.drawText(firma, { x: width - M - 200, y, size: 9, font });
}

function drawFooters(doc, font, rec, now) {
  const pages = doc.getPages();
  const left = toWinAnsi(`${APP.establecimiento} - ID atención ${rec.id || 'sin guardar'} - emitido ${fmtDateTime(now)}`);
  pages.forEach((p, i) => {
    const { width } = p.getSize();
    p.drawText(left, { x: 54, y: 24, size: 7, font, color: GREY });
    const right = `Página ${i + 1} de ${pages.length}`;
    p.drawText(right, { x: width - 54 - font.widthOfTextAtSize(right, 7), y: 24, size: 7, font, color: GREY });
  });
}
