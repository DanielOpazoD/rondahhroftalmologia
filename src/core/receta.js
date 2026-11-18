/** Autocompletado y relleno de la receta para lentes proporcionada por el hospital. */
import { PDFDocument, StandardFonts, TextAlignment } from 'pdf-lib';
import { ageAt, fileSafe, fmtDate, isValidRut } from './format.js';
import { hospitalDateTime } from './ges.js';
import { givenNamesFirst, personName } from './names.js';
import { clinicalFormValues } from './clinicalForms.js';

/** @param {Pick<import('../domain').Atencion, 'f'>} rec @param {Date} [now] */
export function recetaDefaults(rec, now = new Date()) {
  const f = rec.f;
  const { fecha } = hospitalDateTime(now);
  const age = ageAt(f.paciente_fnac, fecha);
  return {
    paciente_nombre: givenNamesFirst(f, 'paciente_'),
    paciente_rut: f.paciente_rut || '',
    paciente_edad: age !== null ? String(age) : f.fecha_atencion === fecha ? f.paciente_edad || '' : '',
    lejos_od: '',
    lejos_oi: '',
    lejos_dp: '',
    cerca_od: '',
    cerca_oi: '',
    cerca_dp: '',
    tabo_eje_od: '',
    tabo_eje_oi: '',
    oftalmologo_nombre: givenNamesFirst(f, 'medico_'),
    fecha,
  };
}

/** @typedef {ReturnType<typeof recetaDefaults>} DatosReceta */

/**
 * Valores con que se abre la receta: lo guardado en la atención sobre lo propuesto.
 * Hasta la 2.27.0 se proponían los apellidos primero; un nombre guardado igual a
 * esa propuesta antigua se reemplaza por la nueva (nombres primero).
 * @param {import('../domain').Atencion} rec @param {Date} [now]
 * @returns {DatosReceta}
 */
export function recetaValues(rec, now = new Date()) {
  const proposed = recetaDefaults(rec, now);
  const values = clinicalFormValues(rec, 'receta', proposed);
  for (const [key, prefix] of /** @type {const} */ ([
    ['paciente_nombre', 'paciente_'],
    ['oftalmologo_nombre', 'medico_'],
  ])) {
    if (values[key] === personName(rec.f, prefix)) values[key] = proposed[key];
  }
  return values;
}

export const RECETA_LABELS = Object.freeze({
  paciente_nombre: 'Nombre del paciente',
  paciente_rut: 'RUT del paciente',
  paciente_edad: 'Edad',
  lejos_od: 'Lejos OD',
  lejos_oi: 'Lejos OI',
  lejos_dp: 'DP de lejos',
  cerca_od: 'Cerca OD',
  cerca_oi: 'Cerca OI',
  cerca_dp: 'DP de cerca',
  tabo_eje_od: 'Eje TABO OD',
  tabo_eje_oi: 'Eje TABO OI',
  oftalmologo_nombre: 'Nombre del profesional',
  fecha: 'Fecha de la receta',
});

/** Los valores ópticos son manuales: no se deducen ni se transforman.
 * @param {DatosReceta} data @returns {string | null}
 */
export function validateReceta(data) {
  if (!data.paciente_nombre.trim()) return 'Completa el nombre del paciente.';
  if (!data.oftalmologo_nombre.trim()) return 'Completa el nombre del profesional.';
  if (
    data.paciente_rut &&
    (!/^(?:\d{1,9}|\d{1,3}(?:\.\d{3}){1,2})-?[\dkK]$/.test(data.paciente_rut.trim()) || !isValidRut(data.paciente_rut))
  ) {
    return 'Revisa el RUT del paciente y su dígito verificador, o deja el campo vacío si no tiene RUT.';
  }
  if (!fmtDate(data.fecha)) return 'Revisa la fecha de la receta.';
  return null;
}

/** @param {DatosReceta} data */
export function recetaFileName(data) {
  return `Receta_Lentes_${data.fecha}_${data.paciente_rut ? fileSafe(data.paciente_rut) : 'sin_RUT'}_${fileSafe(data.paciente_nombre)}.pdf`;
}

/** Conserva los campos editables y el campo de firma vacío de la plantilla.
 * @param {Uint8Array} template @param {DatosReceta} data @param {{now?: Date}} [opts]
 */
export async function buildRecetaPdf(template, data, { now = new Date() } = {}) {
  const error = validateReceta(data);
  if (error) throw new Error(error);
  const doc = await PDFDocument.load(template);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  /** @param {string} value @param {string} label */
  const printable = (value, label) => {
    const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim().replaceAll('−', '-');
    const text = normalized.replaceAll('≥', '>=').replaceAll('≤', '<=');
    // La fuente decide qué caracteres admite; no se eliminan ni cambian otros signos ópticos.
    try {
      font.encodeText(text);
    } catch {
      throw new Error(`«${label}» contiene caracteres que la fuente del PDF no admite. Revisa ese campo.`);
    }
    return text;
  };
  for (const key of /** @type {(keyof DatosReceta)[]} */ (Object.keys(RECETA_LABELS))) {
    const field = form.getTextField(key);
    const text = printable(key === 'fecha' ? fmtDate(data.fecha) : data[key], RECETA_LABELS[key]);
    const width = Math.min(...field.acroField.getWidgets().map((w) => w.getRectangle().width)) - 6;
    let size = 11;
    while (size > 8 && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
    if (font.widthOfTextAtSize(text, size) > width) {
      throw new Error(`«${RECETA_LABELS[key]}» no cabe en su casilla. Revisa el texto antes de emitir la receta.`);
    }
    // La plantilla usa escapes octales en /DA; pdf-lib no los decodifica al cambiar el tamaño.
    const appearance = field.acroField.DA()?.decodeText();
    if (appearance) field.acroField.setDefaultAppearance(appearance);
    field.setText(text);
    field.setFontSize(size);
    // Centrado en su casilla (la plantilla deja algunos campos pegados al borde izquierdo).
    field.setAlignment(TextAlignment.Center);
  }
  // No se escribe ni aplana oftalmologo_firma (/Sig): no constituye una firma del profesional.
  form.updateFieldAppearances(font);
  doc.setTitle(printable(`Receta para lentes - ${data.paciente_nombre}`, 'Nombre del paciente'));
  doc.setAuthor(printable(data.oftalmologo_nombre, 'Nombre del profesional'));
  doc.setSubject('Receta para lentes - Hospital Hanga Roa');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  return doc.save();
}
