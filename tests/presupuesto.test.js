/**
 * Presupuesto de tamaño (ver docs/RENDIMIENTO.md): la app es un solo HTML que
 * cada equipo descarga y guarda; las plantillas PDF van dentro en base64 (+33 %).
 * Si una plantilla nueva o editada trae peso que no se ve (perfil de color de
 * imprenta, metadatos, fuentes completas, imágenes en texto), esta prueba falla:
 *   node scripts/plantillas-livianas.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from 'pdf-lib';

const DIR = new URL('../src/specialties/oftalmologia/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.pdf'));
const N = (/** @type {string} */ s) => PDFName.of(s);

/** KB máximos por plantilla (la IPD es una imagen escaneada en gris). */
const MAX_KB = { 'plantilla.pdf': 150, 'ipd-plantilla.pdf': 300, 'receta-plantilla.pdf': 60, 'ges-plantilla.pdf': 40 };

test('presupuesto: cada plantilla tiene un tope de tamaño', () => {
  assert.deepEqual(files.sort(), Object.keys(MAX_KB).sort(), 'plantilla nueva: agrégala a MAX_KB');
  for (const f of files) {
    const kb = readFileSync(new URL(f, DIR)).length / 1024;
    assert.ok(kb <= MAX_KB[/** @type {keyof typeof MAX_KB} */ (f)], `${f}: ${Math.round(kb)} KB (node scripts/plantillas-livianas.mjs)`);
  }
});

test('presupuesto: las plantillas no traen peso invisible', async () => {
  for (const f of files) {
    const doc = await PDFDocument.load(readFileSync(new URL(f, DIR)));
    for (const k of ['OutputIntents', 'Metadata', 'AF']) assert.ok(!doc.catalog.has(N(k)), `${f}: /${k}`);
    assert.ok(!doc.catalog.lookupMaybe(N('Names'), PDFDict)?.has(N('EmbeddedFiles')), `${f}: archivos incrustados`);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) assert.ok(!String(obj.dict.get(N('Filter'))).includes('ASCII85'), `${f}: flujo en ASCII85`);
      if (obj instanceof PDFDict && obj.get(N('Type')) === N('FontDescriptor')) {
        const file = obj.lookupMaybe(N('FontFile2'), PDFRawStream) || obj.lookupMaybe(N('FontFile'), PDFRawStream);
        assert.ok(!file || file.contents.length < 60_000, `${f}: fuente completa incrustada (${obj.get(N('FontName'))})`);
      }
    }
  }
});
