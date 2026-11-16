import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { GES_HOSPITAL, gesDefaults, validateGes, buildGesPdf, gesFileName } from '../src/core/ges.js';
import { GES_PATOLOGIAS } from '../src/specialties/oftalmologia/config.js';
import { minimalRecord } from './fixtures.js';

const TEMPLATE = readFileSync(new URL('../src/specialties/oftalmologia/ges-plantilla.pdf', import.meta.url));
const NOW = new Date('2026-11-15T05:30:00Z');
const ready = () => ({
  ...gesDefaults(
    minimalRecord('ges1', {
      paciente_nombre: 'Ana Paciente Prueba',
      paciente_rut: '12.345.678-5',
      paciente_fono: '+56 9 1234 5678',
      medico_nombre: 'Profesional Prueba',
      medico_rut: '11.111.111-1',
      fecha_atencion: '2020-02-03',
    }),
    NOW,
  ),
  patologia: GES_PATOLOGIAS[0],
  prevision: 'fonasa',
});

test('GES autocompleta los datos visibles sin cambiar el registro ni deducir la patología o previsión', () => {
  const rec = minimalRecord('ges1', { paciente_nombre: 'Prueba', paciente_fono: '+56912345678', ges: 'catarata' });
  const before = structuredClone(rec);
  const data = gesDefaults(rec, NOW);
  assert.equal(data.paciente_nombre, 'Prueba');
  assert.equal(data.paciente_fono, '+56912345678');
  assert.equal(data.paciente_comuna, 'Isla de Pascua');
  assert.equal(data.paciente_region, 'Quinta región');
  assert.equal(data.paciente_rut, '');
  assert.equal(data.profesional_nombre, '');
  assert.equal(data.profesional_rut, '');
  assert.equal(data.patologia, '');
  assert.equal(data.prevision, '');
  assert.deepEqual(rec, before);
  assert.equal(gesDefaults({ f: {} }, NOW).paciente_nombre, '');
});

test('GES toma la fecha/hora actual de Rapa Nui en cualquier zona del PC, independiente de la fecha de atención', () => {
  const previous = process.env.TZ;
  try {
    const instant = new Date('2026-11-16T03:30:00Z');
    for (const zone of ['UTC', 'Pacific/Easter', 'America/Santiago', 'Pacific/Auckland', 'Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      const data = gesDefaults(minimalRecord('x', { fecha_atencion: '2020-01-01' }), instant);
      assert.equal(data.fecha, '2026-11-15', zone);
      assert.equal(data.hora, '22:30', zone);
    }
    const current = gesDefaults({ f: {} });
    assert.match(current.fecha, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('GES exige identidad de ambos, selección explícita, fecha y hora válidas y representante identificable', () => {
  assert.equal(validateGes(ready()), null);
  for (const key of [
    'paciente_nombre',
    'paciente_rut',
    'profesional_nombre',
    'profesional_rut',
    'patologia',
    'prevision',
    'fecha',
    'hora',
  ]) {
    assert.ok(validateGes({ ...ready(), [key]: ' ' }), key);
  }
  for (const change of [
    { patologia: 'Glaucoma' },
    { patologia: 'Catarata' },
    { prevision: 'otra' },
    { fecha: '2026-02-30' },
    { hora: '24:00' },
    { hora: '12:60' },
    { representante_nombre: 'Representante sin RUT' },
    { representante_fono: '912345678' },
    { paciente_rut: 'x' },
    { paciente_rut: '12.345.678-4' },
    { paciente_rut: 'X123456785' },
    { profesional_rut: '11.111.111-2' },
    { representante_nombre: 'Representante Prueba', representante_rut: '11.111.111-2' },
  ]) {
    assert.ok(validateGes({ ...ready(), ...change }));
  }
  assert.equal(validateGes({ ...ready(), representante_nombre: 'Representante Prueba', representante_rut: '11.111.111-1' }), null);
  assert.equal(validateGes({ ...ready(), paciente_rut: '123456785', profesional_rut: '10.000.013-K' }), null);
});

test('GES mantiene una patología por constancia y el nombre de archivo usa la fecha de notificación', () => {
  assert.equal(GES_PATOLOGIAS.length, 7);
  for (const patologia of GES_PATOLOGIAS) assert.equal(validateGes({ ...ready(), patologia }), null);
  assert.equal(gesFileName(ready()), 'Constancia_GES_2026-11-15_12_345_678-5_Ana_Paciente_Prueba.pdf');
});

test('PDF GES rellena la plantilla oficial, casillas y datos del representante sin escribir firmas', async () => {
  const data = {
    ...ready(),
    prevision: 'isapre',
    representante_nombre: 'Representante Prueba',
    representante_rut: '11.111.111-1',
    representante_fono: '912345678',
    representante_correo: 'prueba@example.test',
  };
  const doc = await PDFDocument.load(await buildGesPdf(TEMPLATE, data, { flatten: false, now: NOW }));
  const form = doc.getForm();
  assert.equal(doc.getPageCount(), 1);
  assert.equal(form.getTextField('institucion').getText(), GES_HOSPITAL.institucion);
  assert.equal(form.getTextField('direccion_hospital').getText(), 'Simón Paoa S/N');
  assert.equal(form.getTextField('ciudad').getText(), 'Rapa Nui');
  for (const [key, value] of Object.entries(data)) {
    if (['prevision', 'fecha', 'hora'].includes(key)) continue;
    assert.equal(form.getTextField(key).getText() || '', value, key);
    assert.ok(form.getTextField(key).acroField.getWidgets()[0].getNormalAppearance(), key);
  }
  assert.equal(form.getTextField('notificacion').getText(), '15-11-2026 00:30');
  for (const key of ['isapre', 'confirmacion', 'presencial']) assert.ok(form.getCheckBox(key).isChecked(), key);
  assert.ok(!form.getFields().some((f) => /^(firma|conocimiento|teleconsulta|oncologico|fonasa)/.test(f.getName())));
  assert.equal(doc.getAuthor(), data.profesional_nombre);
});

test('GES respeta los dos cambios de hora de Rapa Nui sin inventar la hora omitida', () => {
  for (const [instant, fecha, hora] of [
    ['2026-04-05T02:59:00Z', '2026-04-04', '21:59'],
    ['2026-04-05T03:00:00Z', '2026-04-04', '21:00'],
    ['2026-09-06T03:59:00Z', '2026-09-05', '21:59'],
    ['2026-09-06T04:00:00Z', '2026-09-05', '23:00'],
  ]) {
    const data = gesDefaults({ f: {} }, new Date(instant));
    assert.equal(data.fecha, fecha);
    assert.equal(data.hora, hora);
  }
});

test('PDF GES aplanado conserva una página y rechaza textos que no caben en vez de cortarlos', async () => {
  for (const patologia of GES_PATOLOGIAS) {
    const doc = await PDFDocument.load(await buildGesPdf(TEMPLATE, { ...ready(), patologia }));
    assert.equal(doc.getPageCount(), 1);
    assert.ok(!doc.catalog.has(PDFName.of('AcroForm')));
    assert.ok(!doc.getPage(0).node.has(PDFName.of('Annots')), 'sin referencias a widgets eliminados');
    assert.equal(doc.getForm().getFields().length, 0);
  }
  await assert.rejects(buildGesPdf(TEMPLATE, { ...ready(), patologia: 'No GES' }), /Selecciona una patología/);
  await assert.rejects(buildGesPdf(TEMPLATE, { ...ready(), paciente_nombre: 'Nombre largo '.repeat(100) }), /no cabe/);
  await assert.rejects(buildGesPdf(TEMPLATE, { ...ready(), paciente_nombre: 'Hōnē Prueba' }), /letras que la fuente/);
});
