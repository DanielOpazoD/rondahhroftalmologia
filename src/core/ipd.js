/** Informe del proceso diagnóstico sobre el formulario MINSAL original. */
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { GES_PROBLEMAS } from '../config/gesCatalog.js';
import { hospitalDateTime } from './ges.js';
import { NAME_PARTS, personName } from './names.js';
import { ageAt, cleanRut, fmtDate, fileSafe, isIsoDate, isValidRut, toWinAnsi } from './format.js';
import { wrapText } from './pdfTexto.js';

export const IPD_HOSPITAL = Object.freeze({ servicio: 'Metropolitano Oriente', establecimiento: 'Hospital Hanga Roa' });

/**
 * Edad con que se precarga el IPD: la de hoy si hay fecha de nacimiento; si
 * no, la anotada en la atención, pero solo si es de hoy (si no, quedaría vieja).
 * @param {Record<string, string>} f campos de la atención
 * @param {string} hoy fecha del informe (AAAA-MM-DD)
 */
function initialAge(f, hoy) {
  if (isIsoDate(f.paciente_fnac)) return String(ageAt(f.paciente_fnac, hoy) ?? '');
  return f.fecha_atencion === hoy ? f.paciente_edad || '' : '';
}

/** @param {Pick<import('../domain').Atencion, 'f'>} rec @param {Date} [now] */
export function ipdDefaults(rec, now = new Date()) {
  const f = rec.f;
  const clock = hospitalDateTime(now);
  return {
    paciente_apellido_paterno: f.paciente_apellido_paterno || '',
    paciente_apellido_materno: f.paciente_apellido_materno || '',
    paciente_nombres: f.paciente_nombres || '',
    profesional_apellido_paterno: f.medico_apellido_paterno || '',
    profesional_apellido_materno: f.medico_apellido_materno || '',
    profesional_nombres: f.medico_nombres || '',
    paciente_rut: f.paciente_rut || '',
    paciente_fnac: f.paciente_fnac || '',
    paciente_edad: initialAge(f, clock.fecha),
    paciente_sexo: f.paciente_sexo || '',
    profesional_rut: f.medico_rut || '',
    ...clock,
    problema: '',
    subgrupo: '',
    diagnostico: '',
    fundamentos: '',
    tratamiento: '',
    inicio_tratamiento: '',
    especialidad: '',
    unidad: '',
    historia: '',
    folio: '',
  };
}

/** @typedef {ReturnType<typeof ipdDefaults>} DatosIpd */

/**
 * Problema con los datos de una persona del IPD (paciente o profesional), o null.
 * @param {DatosIpd} data @param {'paciente_' | 'profesional_'} p
 */
function personProblem(data, p) {
  const quien = p === 'paciente_' ? 'del paciente' : 'del profesional';
  if (!data[`${p}apellido_paterno`]?.trim() || !data[`${p}nombres`]?.trim()) return `Completa apellido paterno y nombres ${quien}.`;
  const rut = data[`${p}rut`];
  if (!/^(?:\d{1,9}|\d{1,3}(?:\.\d{3}){1,2})-?[\dkK]$/.test(rut.trim()) || !isValidRut(rut)) return `Revisa el RUT ${quien}.`;
  if (cleanRut(rut).length > 9) return 'El RUT no cabe en las casillas del formulario IPD.';
  return null;
}

/**
 * Problema con la fecha de nacimiento o la edad del paciente, o null.
 * @param {DatosIpd} data
 */
function ageProblem(data) {
  const fnac = data.paciente_fnac;
  if (fnac && (!isIsoDate(fnac) || fnac > data.fecha)) return 'Revisa la fecha de nacimiento.';
  if (fnac && (ageAt(fnac, data.fecha) ?? 0) > 999) return 'La edad no cabe en las tres casillas del IPD.';
  if (data.paciente_edad && !/^\d{1,3}$/.test(data.paciente_edad)) return 'Revisa la edad en años (hasta 3 dígitos).';
  return null;
}

/** @param {DatosIpd} data @returns {string | null} */
export function validateIpd(data) {
  const person = personProblem(data, 'paciente_') || personProblem(data, 'profesional_');
  if (person) return person;
  if (!GES_PROBLEMAS.some((p) => p.id === data.problema)) return 'Selecciona el problema de salud GES.';
  if (!fmtDate(data.fecha) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.hora)) return 'Revisa la fecha y hora del informe.';
  const age = ageProblem(data);
  if (age) return age;
  if (data.inicio_tratamiento && !isIsoDate(data.inicio_tratamiento)) return 'Revisa la fecha límite de inicio del tratamiento.';
  if (data.historia && !/^\d{1,9}$/.test(data.historia)) return 'La historia clínica admite hasta 9 dígitos (puede quedar vacía).';
  return null;
}

/** @param {DatosIpd} data */
export function ipdFileName(data) {
  return `IPD_${data.fecha}_${fileSafe(data.paciente_rut)}_${fileSafe(personName(data, 'paciente_'))}.pdf`;
}

/** No pierde letras del nombre ni del texto clínico al pasar a WinAnsi. @param {string} value */
function safe(value) {
  const normalized = value.normalize('NFC');
  const out = toWinAnsi(normalized);
  if ((normalized.match(/\p{L}/gu) || []).join('') !== (out.match(/\p{L}/gu) || []).join('')) {
    throw new Error('El PDF no admite algunas letras del texto. Revisa los nombres y campos antes de imprimir.');
  }
  return out;
}

/**
 * Edad que se imprime: calculada a la fecha del informe si hay fecha de
 * nacimiento; si no, la escrita; null si no hay ninguna.
 * @param {DatosIpd} data
 */
function printedAge(data) {
  if (data.paciente_fnac) return ageAt(data.paciente_fnac, data.fecha);
  return data.paciente_edad ? Number(data.paciente_edad) : null;
}

/**
 * Hojas complementarias con los textos clínicos que no cupieron en el formulario.
 * @param {PDFDocument} doc
 * @param {import('pdf-lib').PDFFont} font
 * @param {DatosIpd} data
 * @param {[string, string][]} annex [etiqueta, texto completo]
 */
function writeAnnex(doc, font, data, annex) {
  // `cursor` en 0 obliga a crear la primera hoja antes de escribir.
  let extra = doc.getPage(0);
  let cursor = 0;
  const newAnnex = () => {
    extra = doc.addPage([612, 792]);
    extra.drawText('IPD - Hoja complementaria', { x: 36, y: 752, font, size: 14 });
    const who = `${personName(data, 'paciente_')} | ${data.paciente_rut}`;
    wrapText(safe(who), font, 10, 540).forEach((line, i) => extra.drawText(line, { x: 36, y: 730 - i * 12, font, size: 10 }));
    extra.drawText(`Informe: ${fmtDate(data.fecha)} ${data.hora} (Rapa Nui)`, { x: 36, y: 694, font, size: 10 });
    extra.drawText(safe(personName(data, 'profesional_')), { x: 36, y: 48, font, size: 9 });
    extra.drawText('Firma profesional: __________________________', { x: 310, y: 48, font, size: 9 });
    cursor = 663;
  };
  for (const [label, value] of annex) {
    if (cursor < 100) newAnnex();
    extra.drawText(label, { x: 36, y: cursor, font, size: 11 });
    cursor -= 18;
    for (const line of wrapText(safe(value), font, 10, 540)) {
      if (cursor < 80) newAnnex();
      extra.drawText(line, { x: 36, y: cursor, font, size: 10 });
      cursor -= 13;
    }
    cursor -= 18;
  }
}

/** @param {Uint8Array} template @param {DatosIpd} data @param {{flatten?: boolean, now?: Date}} [opts] */
export async function buildIpdPdf(template, data, { flatten = true, now = new Date() } = {}) {
  const error = validateIpd(data);
  if (error) throw new Error(error);
  const doc = await PDFDocument.load(template);
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  // La imagen original (1226 × 1612) está centrada, sin deformar, en carta.
  const scale = 568 / 1226;
  const left = 22;
  const top = 22.584;
  /** @type {[string, string][]} */
  const annex = [];
  /** Coordenadas en píxeles de la plantilla, desde arriba.
   * @param {string} key @param {string} value @param {number} x @param {number} y
   * @param {number} width @param {number} [height] @param {number} [maxSize]
   */
  const text = (key, value, x, y, width, height = 28, maxSize = 10) => {
    const content = safe(value).replace(/\s+/g, ' ').trim();
    let size = maxSize;
    while (size > 8 && font.widthOfTextAtSize(content, size) > width * scale - 2) size -= 0.5;
    if (font.widthOfTextAtSize(content, size) > width * scale - 2) {
      throw new Error(`«${key.replaceAll('_', ' ')}» no cabe en su casilla. Revisa ese dato.`);
    }
    const field = form.createTextField(key);
    field.setText(content);
    field.addToPage(page, {
      x: left + x * scale,
      y: page.getHeight() - top - (y + height) * scale,
      width: width * scale,
      height: height * scale,
      borderWidth: 0,
    });
    field.setFontSize(size);
  };
  /** @param {string} key @param {string} value @param {number[]} xs @param {number} y */
  const digits = (key, value, xs, y) => {
    for (let i = 0; i < xs.length; i++) text(`${key}_${i + 1}`, value[i] || '', xs[i] + 5, y, 22, 30, 11);
  };
  /** @param {string} key @param {string} iso @param {number[]} xs @param {number} y */
  const date = (key, iso, xs, y) => digits(key, iso ? iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4) : '', xs, y);
  /** @param {string} key @param {string} value @param {number} y */
  const rut = (key, value, y) => {
    const clean = cleanRut(value);
    digits(key, clean.slice(0, -1).padStart(8, ' ') + clean.slice(-1), [130, 164, 197, 230, 263, 297, 330, 363, 413], y);
  };
  date('fecha_informe', data.fecha, [562, 596, 644, 678, 729, 762, 794, 827], 85);
  digits('hora_informe', data.hora.replace(':', ''), [1070, 1104, 1153, 1187], 86);
  text('folio', data.folio, 1020, 43, 193);
  text('servicio_salud', IPD_HOSPITAL.servicio, 30, 142, 490);
  text('establecimiento', IPD_HOSPITAL.establecimiento, 540, 142, 670);
  text('especialidad', data.especialidad, 30, 198, 615);
  text('unidad', data.unidad, 666, 198, 543);
  /** @param {'paciente_' | 'profesional_'} prefix @param {number} y */
  const names = (prefix, y) => {
    const cols = [
      [70, 355],
      [444, 303],
      [770, 436],
    ];
    NAME_PARTS.forEach((k, i) => text(prefix + k, data[`${prefix}${k}`], cols[i][0], y, cols[i][1], 35, 11));
  };
  names('paciente_', 274);
  names('profesional_', 1462);
  digits('historia_clinica', data.historia, [895, 933, 970, 1006, 1042, 1078, 1114, 1150, 1186], 242);
  rut('paciente_rut', data.paciente_rut, 348);
  rut('profesional_rut', data.profesional_rut, 1541);
  date('fecha_nacimiento', data.paciente_fnac, [415, 449, 492, 526, 570, 603, 636, 669], 404);
  if (['M', 'F'].includes(data.paciente_sexo)) text('sexo', 'X', 189, data.paciente_sexo === 'M' ? 390 : 416, 21, 22, 8);
  const age = printedAge(data);
  if (age !== null) {
    digits('edad', String(age).padStart(3, ' '), [929, 963, 997], 398);
    text('edad_anos', 'X', 1048, 393, 25, 19, 8);
  }
  // El original imprime «SI» dentro de la casilla. Se conserva la etiqueta y
  // se agrega la X a su derecha, dentro de los bordes del recuadro inferior.
  page.drawRectangle({
    x: left + 1121 * scale,
    y: page.getHeight() - top - 522 * scale,
    width: 33 * scale,
    height: 22 * scale,
    color: rgb(1, 1, 1),
  });
  page.drawText('SI', { x: left + 1123 * scale, y: page.getHeight() - top - 517 * scale, size: 6, font });
  text('confirmacion_ges_si', 'X', 1138, 500, 18, 22, 8);
  const problem = GES_PROBLEMAS.find((p) => p.id === data.problema);
  // validateIpd ya lo exigió al comienzo; se vuelve a comprobar aquí, donde se usa.
  if (!problem) throw new Error('Selecciona el problema de salud GES.');
  /** @param {string} key @param {string} value @param {string} label @param {number} y @param {number} height */
  const clinical = (key, value, label, y, height) => {
    const size = 10;
    const width = 1110 * scale;
    let lines = wrapText(safe(value), font, size, width);
    const capacity = Math.floor((height * scale) / (size * 1.2));
    if (lines.length > capacity) {
      annex.push([label, value]);
      lines = [...lines.slice(0, capacity - 1), '(Continúa en hoja complementaria)'];
    }
    lines.forEach((line, i) => text(`${key}_${i + 1}`, line, 55, y + (i * size * 1.2) / scale, 1110, (size * 1.2) / scale, size));
  };
  wrapText(problem.titulo, font, 10, 800 * scale).forEach((line, i) =>
    text(`problema_salud_${i + 1}`, line, 55, 508 + i * 28, 800, 28, 10),
  );
  clinical('subgrupo', data.subgrupo, 'Subgrupo o subproblema AUGE', 661, 54);
  clinical('diagnostico', data.diagnostico, 'Diagnóstico', 775, 208);
  clinical('fundamentos', data.fundamentos, 'Fundamentos del diagnóstico', 1046, 130);
  clinical('tratamiento', data.tratamiento, 'Tratamiento e indicaciones', 1235, 130);
  date('inicio_tratamiento', data.inicio_tratamiento, [887, 921, 968, 1002, 1056, 1091, 1127, 1163], 1380);
  form.updateFieldAppearances(font);
  if (flatten) {
    form.flatten();
    page.node.delete(PDFName.of('Annots'));
    doc.catalog.delete(PDFName.of('AcroForm'));
  }
  writeAnnex(doc, font, data, annex);
  doc.setTitle(safe(`IPD - ${personName(data, 'paciente_')}`));
  doc.setAuthor(safe(personName(data, 'profesional_')));
  doc.setSubject('Informe del proceso diagnóstico - Hospital Hanga Roa');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  return doc.save();
}
