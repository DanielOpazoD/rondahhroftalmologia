import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { recetaDefaults, validateReceta, buildRecetaPdf, recetaFileName, RECETA_LABELS } from '../src/core/receta.js';

const TEMPLATE = readFileSync(new URL('../src/specialties/oftalmologia/receta-plantilla.pdf', import.meta.url));
const NOW = new Date('2026-11-16T03:30:00Z');
const ready = () => ({
  ...recetaDefaults(
    {
      f: {
        paciente_apellido_paterno: 'Ejemplo',
        paciente_apellido_materno: 'Ficticio',
        paciente_nombres: 'Paciente Prueba',
        paciente_rut: '12.345.678-5',
        paciente_fnac: '1959-03-20',
        medico_apellido_paterno: 'Prueba',
        medico_apellido_materno: 'Ficticio',
        medico_nombres: 'Profesional',
      },
    },
    NOW,
  ),
  lejos_od: '−1,00 −0,50 × 90°',
  lejos_oi: '-1,25 -0,75 x 80',
  lejos_dp: '64',
  cerca_od: '+1,50 -0,50 x 90',
  cerca_oi: '+1,25 -0,75 x 80',
  cerca_dp: '61',
  tabo_eje_od: '90',
  tabo_eje_oi: '80',
});

test('receta: propone paciente y profesional en orden, edad actual y fecha de Rapa Nui, sin deducir la óptica ni cambiar datos', () => {
  const rec = {
    f: {
      paciente_apellido_paterno: 'Tepano',
      paciente_apellido_materno: 'Pakarati',
      paciente_nombres: 'María José',
      paciente_nombre: 'Texto anterior',
      paciente_rut: '12.345.678-5',
      paciente_fnac: '1959-11-16',
      fecha_atencion: '2020-01-01',
      paciente_edad: '60',
      medico_nombre: 'Profesional anterior',
      receta: 'Otro medicamento',
      od_av: '20/40',
      oi_av: '20/30',
    },
  };
  const before = structuredClone(rec),
    d = recetaDefaults(rec, NOW);
  assert.equal(d.paciente_nombre, 'Tepano Pakarati María José');
  assert.equal(d.paciente_rut, rec.f.paciente_rut);
  assert.equal(d.paciente_edad, '66');
  assert.equal(d.oftalmologo_nombre, 'Profesional anterior');
  assert.equal(d.fecha, '2026-11-15');
  for (const k of ['lejos_od', 'lejos_oi', 'lejos_dp', 'cerca_od', 'cerca_oi', 'cerca_dp', 'tabo_eje_od', 'tabo_eje_oi']) {
    assert.equal(d[k], '', k);
  }
  assert.deepEqual(rec, before);
  assert.equal(recetaDefaults({ f: { fecha_atencion: '2026-11-15', paciente_edad: '60' } }, NOW).paciente_edad, '60');
  assert.equal(recetaDefaults({ f: { fecha_atencion: '2020-01-01', paciente_edad: '60' } }, NOW).paciente_edad, '');
  assert.equal(recetaDefaults({ f: {} }, NOW).paciente_nombre, '');
  assert.match(recetaDefaults({ f: {} }).fecha, /^\d{4}-\d{2}-\d{2}$/);
});

test('receta: identidad y fecha revisables, sin exigir RUT a quien no lo tiene ni inventar valores clínicos', () => {
  const d = ready();
  assert.equal(validateReceta(d), null);
  assert.equal(validateReceta({ ...d, paciente_rut: '', paciente_edad: '6 meses', lejos_od: '', cerca_od: '' }), null);
  for (const change of [
    { paciente_nombre: ' ' },
    { oftalmologo_nombre: '' },
    { fecha: '2026-02-30' },
    { paciente_rut: '12.345.678-9' },
    { paciente_rut: 'K12.345.678-5' },
  ]) {
    assert.ok(validateReceta({ ...d, ...change }));
  }
  assert.equal(recetaFileName(d), 'Receta_Lentes_2026-11-15_12_345_678-5_Ejemplo_Ficticio_Paciente_Prueba.pdf');
  assert.match(recetaFileName({ ...d, paciente_rut: '' }), /_sin_RUT_/);
});

test('receta: usa los campos originales, conserva los signos y deja el PDF editable con la firma sin rellenar', async () => {
  const d = ready();
  const pdf = await PDFDocument.load(await buildRecetaPdf(TEMPLATE, d, { now: NOW }));
  const form = pdf.getForm();
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getPage(0).getWidth(), 396);
  assert.equal(pdf.getPage(0).getHeight(), 612);
  assert.equal(form.getFields().length, 14);
  for (const key of Object.keys(RECETA_LABELS)) {
    const field = form.getTextField(key),
      value = key === 'fecha' ? '15-11-2026' : d[key].replaceAll('−', '-');
    assert.equal(field.getText(), value, key);
    assert.equal(field.isReadOnly(), false);
    const widgets = field.acroField.getWidgets();
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].dict.get(PDFName.of('V')).decodeText(), value);
    assert.ok(widgets[0].getAppearances().normal);
  }
  const sig = form.getSignature('oftalmologo_firma');
  assert.equal(sig.acroField.dict.get(PDFName.of('V')), undefined);
  assert.equal(pdf.getPage(0).node.Annots().size(), 14);
  assert.match(pdf.getTitle(), /Ejemplo Ficticio Paciente Prueba/);
  assert.equal(pdf.getAuthor(), 'Prueba Ficticio Profesional');
});

test('receta: rechaza textos que no caben o caracteres no representables; nunca corta ni quita signos', async () => {
  await assert.rejects(() => buildRecetaPdf(TEMPLATE, { ...ready(), paciente_nombre: '' }), /nombre del paciente/);
  await assert.rejects(() => buildRecetaPdf(TEMPLATE, { ...ready(), lejos_od: '-1.00 '.repeat(100) }), /Lejos OD.*no cabe/);
  await assert.rejects(() => buildRecetaPdf(TEMPLATE, { ...ready(), paciente_nombre: '患者' }), /caracteres/);
  await assert.rejects(() => buildRecetaPdf(TEMPLATE, { ...ready(), lejos_od: '-1.00 → +1.00' }), /caracteres/);
  const pdf = await PDFDocument.load(await buildRecetaPdf(TEMPLATE, { ...ready(), lejos_od: '  −2,00  ≥ −3,00\n“prueba”  ' }));
  assert.equal(pdf.getForm().getTextField('lejos_od').getText(), '-2,00 >= -3,00 “prueba”');
  const signs = await PDFDocument.load(await buildRecetaPdf(TEMPLATE, { ...ready(), lejos_od: '-1,00 × 90° · prueba • 2' }));
  assert.equal(signs.getForm().getTextField('lejos_od').getText(), '-1,00 × 90° · prueba • 2');
});
