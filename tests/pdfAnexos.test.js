import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray, StandardFonts } from 'pdf-lib';
import { appendAnnexes } from '../src/core/pdfAnexos.js';

const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

async function pdfOf(pages, text = 'x') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]).drawText(`${text} ${i + 1}`, { x: 20, y: 200, size: 12, font });
  return doc.save();
}

/** Nombres de los archivos incrustados en un PDF. */
function embeddedNames(doc) {
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const ef = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const arr = ef?.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (!arr) return [];
  const out = [];
  for (let i = 0; i < arr.size(); i += 2) out.push(arr.lookup(i).decodeText());
  return out;
}

test('PDF con anexos: hoja + índice + imagen + páginas del PDF; Word incrustado', async () => {
  const hoja = await pdfOf(2, 'Hoja'); // la hoja (con su hoja complementaria)
  const r = await appendAnnexes(hoja, [
    { nombre: 'fondo de ojo.png', tipo: 'image/png', bytes: PNG, como: 'imagen-png' },
    { nombre: 'OCT macular.pdf', tipo: 'application/pdf', bytes: await pdfOf(3, 'OCT'), como: 'pdf' },
    {
      nombre: 'informe.docx',
      tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: new Uint8Array([80, 75, 3, 4]),
      como: 'incrustar',
    },
    { nombre: 'pendiente.jpg', tipo: 'image/jpeg', bytes: null, como: 'incrustar' },
  ]);
  const doc = await PDFDocument.load(r.bytes);
  // 2 de la hoja + 1 índice + 1 imagen + 3 del PDF adjunto.
  assert.equal(doc.getPageCount(), 7);
  assert.equal(r.paginas, 7);
  assert.deepEqual(embeddedNames(doc), ['informe.docx']);
  assert.deepEqual(r.incrustados, ['informe.docx']);
  assert.deepEqual(r.faltantes, ['pendiente.jpg']);
  // La hoja original queda primero, sin cambios de tamaño.
  assert.deepEqual(doc.getPage(0).getSize(), { width: 300, height: 400 });
  // El índice va justo después de la hoja (A4).
  assert.equal(Math.round(doc.getPage(2).getSize().width), 595);
});

test('PDF con anexos: un adjunto ilegible no rompe el documento (se incrusta tal cual)', async () => {
  const r = await appendAnnexes(await pdfOf(1), [
    { nombre: 'dañado.pdf', tipo: 'application/pdf', bytes: new Uint8Array([1, 2, 3]), como: 'pdf' },
    { nombre: 'foto rota.jpg', tipo: 'image/jpeg', bytes: new Uint8Array([9, 9, 9]), como: 'imagen-jpg' },
  ]);
  const doc = await PDFDocument.load(r.bytes);
  assert.equal(doc.getPageCount(), 2); // hoja + índice
  assert.deepEqual(r.ilegibles, ['dañado.pdf', 'foto rota.jpg']);
  assert.deepEqual(embeddedNames(doc).sort(), ['dañado.pdf', 'foto rota.jpg'].sort());
});
