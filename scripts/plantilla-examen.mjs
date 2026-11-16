#!/usr/bin/env node
/**
 * Ajusta la plantilla PDF de oftalmología al examen físico de la 2.18:
 * por ojo, las filas pasan a ser AV · AVcc · PIO (antes AV · PIO · Otro/Resultado).
 *
 *   node scripts/plantilla-examen.mjs            (modifica src/specialties/oftalmologia/plantilla.pdf)
 *
 * Sin borrar objetos del PDF (borrarlos deja huecos en la numeración que
 * algunos lectores reportan como «XRef» inválido):
 *   - `<ojo>_otro_resultado` pasa a llamarse `<ojo>_avcc` y se mueve a la 2.ª fila;
 *   - `<ojo>_pio` se mueve a la 3.ª fila;
 *   - `<ojo>_otro_examen` se saca del formulario y de la página;
 *   - se reescriben los rótulos impresos de esas filas («AVcc» y «PIO»).
 * Es idempotente: si la plantilla ya tiene `od_avcc`, no hace nada.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, PDFArray, StandardFonts, rgb } from 'pdf-lib';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '../src/specialties/oftalmologia/plantilla.pdf');
const doc = await PDFDocument.load(readFileSync(file));
const form = doc.getForm();
if (form.getFields().some((f) => f.getName() === 'od_avcc')) {
  console.log('La plantilla ya tiene AVcc: sin cambios.');
  process.exit(0);
}
const page = doc.getPage(0);
const helv = await doc.embedFont(StandardFonts.Helvetica);
const widgetOf = (/** @type {string} */ name) => form.getTextField(name).acroField.getWidgets()[0];
const LABEL_PT = 10;
const INK = rgb(0.13, 0.13, 0.13);

/** Quita un elemento de un arreglo del PDF (por referencia). @param {PDFArray} arr @param {any} ref */
function removeRef(arr, ref) {
  for (let i = arr.size() - 1; i >= 0; i--) if (arr.get(i) === ref) arr.remove(i);
}

for (const e of ['od', 'oi']) {
  const pioW = widgetOf(`${e}_pio`);
  const otroLabelField = form.getTextField(`${e}_otro_examen`);
  const otroValueField = form.getTextField(`${e}_otro_resultado`);
  const row2 = pioW.getRectangle(); // 2.ª fila (valor)
  const row3 = otroValueField.acroField.getWidgets()[0].getRectangle(); // 3.ª fila (valor)
  const labelCol = otroLabelField.acroField.getWidgets()[0].getRectangle(); // 3.ª fila (rótulo)

  // AVcc: el campo de «Resultado» con otro nombre, en la 2.ª fila.
  otroValueField.acroField.dict.set(PDFName.of('T'), PDFString.of(`${e}_avcc`));
  otroValueField.acroField.getWidgets()[0].setRectangle(row2);
  otroValueField.disableMultiline(); // una línea, centrada como AV y PIO
  // PIO: a la 3.ª fila.
  pioW.setRectangle(row3);
  // «Otro» (sigla): fuera del formulario y de la página.
  const otroRef = otroLabelField.ref;
  const otroWidgetRef = doc.context.getObjectRef(otroLabelField.acroField.getWidgets()[0].dict);
  removeRef(form.acroForm.dict.lookup(PDFName.of('Fields'), PDFArray), otroRef);
  const annots = page.node.Annots();
  if (annots) {
    removeRef(annots, otroRef);
    if (otroWidgetRef) removeRef(annots, otroWidgetRef);
  }

  // Rótulos impresos: «PIO» de la 2.ª fila pasa a «AVcc», y la 3.ª fila dice «PIO».
  const label2 = { x: labelCol.x, y: row2.y, width: labelCol.width, height: row2.height };
  const baseline = (/** @type {{y: number, height: number}} */ r) => r.y + r.height / 2 - LABEL_PT * 0.36;
  page.drawRectangle({ x: label2.x + 1, y: label2.y + 1, width: label2.width - 2, height: label2.height - 2, color: rgb(1, 1, 1) });
  // «AVcc» es más ancho: un poco más chico para que quepa en la celda (26 pt).
  page.drawText('AVcc', { x: label2.x + 3, y: baseline(label2), size: 8.5, font: helv, color: INK });
  page.drawText('PIO', { x: labelCol.x + 4.5, y: baseline(labelCol), size: LABEL_PT, font: helv, color: INK });
}

writeFileSync(file, await doc.save());
console.log('Plantilla actualizada: AV · AVcc · PIO por ojo.');
