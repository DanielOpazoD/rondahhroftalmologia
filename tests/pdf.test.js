import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { buildAttentionPdf, pdfFileName, wrapText } from '../src/pdf/attentionPdf.js';
import { fullRecord, minimalRecord, PROCS } from './fixtures.js';

const TEMPLATE = readFileSync(new URL('../assets/plantilla_hoja_atencion.pdf', import.meta.url));
const NOW = new Date(2026, 10, 14, 10, 30);

test('pdfFileName incluye fecha, RUT y nombre sin caracteres problemáticos', () => {
  assert.equal(pdfFileName(fullRecord()), 'Oftalmo_2026-11-14_11111111-1_Maria_Jose_Tepano_Pakarati.pdf');
  assert.equal(pdfFileName(minimalRecord('x', { paciente_nombre: 'Ana' })), 'Oftalmo_2026-11-14_Ana.pdf');
});

test('wrapText respeta ancho y corta palabras largas', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');
  const lines = wrapText('uno dos tres ' + 'x'.repeat(200), font, 10, 100);
  assert.ok(lines.length > 3);
  for (const l of lines) assert.ok(font.widthOfTextAtSize(l, 10) <= 96, l);
});

test('atención breve: 1 página, campos rellenos (no aplanado)', async () => {
  const rec = minimalRecord(
    'a1',
    { paciente_nombre: 'Juan Prueba', paciente_rut: '12.345.678-5', motivo_consulta: 'Control', plan: 'Lentes' },
    { checks: { antecedente_hta: true }, proc: { fo: { eye: 'AO' } } },
  );
  const r = await buildAttentionPdf(TEMPLATE, rec, PROCS, { flatten: false, now: NOW });
  assert.equal(r.pages, 1);
  assert.deepEqual(r.overflow, []);
  const doc = await PDFDocument.load(r.bytes);
  const form = doc.getForm();
  assert.equal(form.getTextField('paciente_nombre').getText(), 'Juan Prueba');
  assert.equal(form.getTextField('fecha_atencion').getText(), '14-11-2026');
  assert.equal(form.getTextField('motivo_consulta_1').getText(), 'Control');
  assert.match(form.getTextField('examen_observaciones_1').getText(), /Proc\. realizados: Fondo de ojo \(FO\) AO/);
  assert.ok(form.getCheckBox('antecedente_hta').isChecked());
  assert.ok(!form.getCheckBox('antecedente_dm2').isChecked());
  assert.match(doc.getTitle(), /Juan Prueba/);
});

test('atención extensa: hoja complementaria y formulario aplanado', async () => {
  const rec = fullRecord();
  PROCS.forEach((p) => (rec.proc[p.id] ||= { eye: 'AO' }));
  rec.f.motivo_consulta = 'Texto de motivo muy largo. '.repeat(60);
  const r = await buildAttentionPdf(TEMPLATE, rec, PROCS, { now: NOW });
  assert.equal(r.pages, 2);
  assert.ok(r.overflow.includes('Procedimientos realizados'));
  assert.ok(r.overflow.includes('Motivo de consulta'));
  const doc = await PDFDocument.load(r.bytes);
  assert.equal(doc.getForm().getFields().length, 0, 'aplanado: sin campos editables');
});

test('catarata marca el ojo correcto', async () => {
  const rec = minimalRecord('c', { paciente_nombre: 'X' }, { checks: { diagnostico_catarata: true }, cat: 'OI' });
  const doc = await PDFDocument.load((await buildAttentionPdf(TEMPLATE, rec, PROCS, { flatten: false, now: NOW })).bytes);
  const form = doc.getForm();
  assert.ok(form.getCheckBox('diagnostico_catarata').isChecked());
  assert.ok(form.getCheckBox('diagnostico_catarata_oi').isChecked());
  assert.ok(!form.getCheckBox('diagnostico_catarata_od').isChecked());
});
