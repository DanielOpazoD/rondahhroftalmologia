/** Constancia GES: datos revisables y relleno de la plantilla oficial IF/N°469. */
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { GES_PATOLOGIAS } from '../specialties/activa/config.js';
import { fmtDate, fileSafe, toWinAnsi, isValidRut } from './format.js';
import { personName } from './names.js';

const hospitalClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Pacific/Easter',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const GES_HOSPITAL = Object.freeze({
  institucion: 'Hospital Hanga Roa',
  direccion: 'Simón Paoa S/N',
  ciudad: 'Rapa Nui',
});

/** Calendario y hora civil del hospital, independientes del equipo y del reloj de sincronización. */
export function hospitalDateTime(now = new Date()) {
  const parts = Object.fromEntries(hospitalClock.formatToParts(now).map(({ type, value }) => [type, value]));
  return { fecha: `${parts.year}-${parts.month}-${parts.day}`, hora: `${parts.hour}:${parts.minute}` };
}

/** @typedef {ReturnType<typeof gesDefaults>} DatosGes */

/** No usa la fecha de la atención ni el reloj lógico de sincronización.
 * @param {Pick<import('../domain').Atencion, 'f'>} rec
 * @param {Date} [now] instante actual, convertido al calendario y reloj de Rapa Nui
 */
export function gesDefaults(rec, now = new Date()) {
  const f = rec.f;
  return {
    paciente_nombre: personName(f, 'paciente_'),
    paciente_rut: f.paciente_rut || '',
    paciente_fono: f.paciente_fono || '',
    paciente_social: '',
    paciente_direccion: '',
    paciente_comuna: 'Isla de Pascua',
    paciente_region: 'Quinta región',
    paciente_correo: '',
    prevision: '',
    profesional_nombre: personName(f, 'medico_'),
    profesional_rut: f.medico_rut || '',
    patologia: '',
    ...hospitalDateTime(now),
    representante_nombre: '',
    representante_rut: '',
    representante_fono: '',
    representante_correo: '',
  };
}

/**
 * Mensaje para el primer RUT escrito que no es válido (formato o dígito verificador); null si todos lo son.
 * @param {DatosGes} data @returns {string | null}
 */
function invalidRutError(data) {
  for (const [label, value] of [
    ['del paciente', data.paciente_rut],
    ['del profesional', data.profesional_rut],
    ['del representante', data.representante_rut],
  ]) {
    if (value && (!/^(?:\d{1,9}|\d{1,3}(?:\.\d{3}){1,2})-?[\dkK]$/.test(value.trim()) || !isValidRut(value))) {
      return `El RUT ${label} no es válido. Revisa el número y dígito verificador.`;
    }
  }
  return null;
}

/**
 * El representante es opcional, pero si se anotó algún dato suyo, exige nombre y RUT.
 * @param {DatosGes} data @returns {string | null}
 */
function representanteError(data) {
  const anotado =
    data.representante_nombre.trim() || data.representante_rut.trim() || data.representante_fono.trim() || data.representante_correo.trim();
  if (anotado && (!data.representante_nombre.trim() || !data.representante_rut.trim())) {
    return 'Completa el nombre y RUT del representante.';
  }
  return null;
}

/** @param {DatosGes} data @returns {string | null} */
export function validateGes(data) {
  if (!data.paciente_nombre.trim() || !data.paciente_rut.trim()) return 'Completa el nombre y RUT del paciente.';
  if (!data.profesional_nombre.trim() || !data.profesional_rut.trim()) return 'Completa el nombre y RUT de quien notifica.';
  const rutError = invalidRutError(data);
  if (rutError) return rutError;
  if (!GES_PATOLOGIAS.includes(data.patologia)) return 'Selecciona una patología GES de la lista.';
  if (!['fonasa', 'isapre'].includes(data.prevision)) return 'Selecciona la previsión del paciente.';
  if (!fmtDate(data.fecha) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.hora)) return 'Revisa la fecha y hora de notificación.';
  return representanteError(data);
}

/** @param {DatosGes} data */
export function gesFileName(data) {
  return `Constancia_GES_${data.fecha}_${fileSafe(data.paciente_rut)}_${fileSafe(data.paciente_nombre)}.pdf`;
}

/**
 * Agrega campos dentro de las casillas originales; no redibuja el formulario.
 * Firmas y constancia de recepción quedan en blanco para su suscripción.
 * @param {Uint8Array} template
 * @param {DatosGes} data
 * @param {{flatten?: boolean, now?: Date}} [opts]
 */
export async function buildGesPdf(template, data, { flatten = true, now = new Date() } = {}) {
  const error = validateGes(data);
  if (error) throw new Error(error);
  const doc = await PDFDocument.load(template);
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  const backgroundColor = rgb(0.933, 0.949, 0.949);

  /** Coordenadas desde el borde superior, medidas sobre la plantilla IF/N°469.
   * @param {string} key @param {string} value
   * @param {number} x @param {number} top @param {number} width
   */
  const text = (key, value, x, top, width) => {
    const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();
    const content = toWinAnsi(normalized);
    const label = key.replaceAll('_', ' ');
    if ((normalized.match(/\p{L}/gu) || []).join('') !== (content.match(/\p{L}/gu) || []).join('')) {
      throw new Error(`El texto de «${label}» contiene letras que la fuente del PDF no admite. Revisa ese campo.`);
    }
    let size = 10;
    while (size > 7 && font.widthOfTextAtSize(content, size) > width - 10) size -= 0.5;
    if (font.widthOfTextAtSize(content, size) > width - 10) {
      throw new Error(`El texto de «${label}» no cabe en el formulario. Revísalo antes de descargar.`);
    }
    const field = form.createTextField(key);
    field.setText(content);
    field.addToPage(page, { x: x + 2, y: page.getHeight() - top - 16, width: width - 4, height: 14, borderWidth: 0, backgroundColor });
    field.setFontSize(size);
  };
  text('institucion', GES_HOSPITAL.institucion, 253.7, 79.87, 317.69);
  text('direccion_hospital', GES_HOSPITAL.direccion, 89.5, 106.48, 281.13);
  text('ciudad', GES_HOSPITAL.ciudad, 422.7, 106.48, 148.69);
  text('profesional_nombre', data.profesional_nombre, 177.15, 132.04, 394.24);
  text('profesional_rut', data.profesional_rut, 66.82, 157.53, 109.34);
  text('paciente_nombre', data.paciente_nombre, 109.31, 202.45, 462.08);
  text('paciente_social', data.paciente_social, 109.31, 229.34, 462.08);
  text('paciente_rut', data.paciente_rut, 66.82, 254.57, 109.34);
  text('paciente_direccion', data.paciente_direccion, 89.5, 279.61, 281.13);
  text('paciente_comuna', data.paciente_comuna, 422.7, 279.61, 148.69);
  text('paciente_region', data.paciente_region, 76.83, 304.44, 101.67);
  text('paciente_fono', data.paciente_fono, 231.13, 304.44, 94.08);
  text('paciente_correo', data.paciente_correo, 422.24, 304.44, 149.15);
  text('patologia', data.patologia, 150.15, 349.62, 421.23);
  text('notificacion', `${fmtDate(data.fecha)} ${data.hora}`, 172.85, 545.73, 398.54);
  text('representante_nombre', data.representante_nombre, 82.32, 696.37, 329.88);
  text('representante_rut', data.representante_rut, 440.31, 696.37, 131.07);
  text('representante_fono', data.representante_fono, 82.32, 719.89, 104.52);
  text('representante_correo', data.representante_correo, 281.29, 719.89, 290.26);

  /** @param {string} key @param {number} x @param {number} top */
  const check = (key, x, top) => {
    const field = form.createCheckBox(key);
    field.addToPage(page, { x: x + 3, y: page.getHeight() - top - 15, width: 12, height: 12, borderWidth: 0, backgroundColor });
    field.check();
  };
  check(data.prevision, data.prevision === 'fonasa' ? 383.7 : 447.62, 254.57);
  check('confirmacion', 155, 375.35);
  check('presencial', 231, 471.8);
  form.updateFieldAppearances(font);
  if (flatten) {
    form.flatten();
    // La plantilla no trae anotaciones. pdf-lib deja referencias a algunos
    // widgets eliminados al aplanar los campos recién creados.
    page.node.delete(PDFName.of('Annots'));
    doc.catalog.delete(PDFName.of('AcroForm'));
  }
  doc.setTitle(toWinAnsi(`Constancia GES - ${data.paciente_nombre}`));
  doc.setAuthor(toWinAnsi(data.profesional_nombre));
  doc.setSubject('Constancia de información al paciente GES - Hospital Hanga Roa');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  return doc.save();
}
