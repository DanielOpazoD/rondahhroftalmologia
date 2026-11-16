import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { ipdDefaults, validateIpd, buildIpdPdf, ipdFileName, IPD_HOSPITAL } from '../src/core/ipd.js';
import { GES_AREAS, GES_PROBLEMAS, GES_SUBGRUPOS } from '../src/config/gesCatalog.js';
import { GES_PATOLOGIAS } from '../src/specialties/oftalmologia/config.js';
import { wrapText } from '../src/core/pdfTexto.js';

const TEMPLATE = readFileSync(new URL('../src/specialties/oftalmologia/ipd-plantilla.pdf', import.meta.url));
const NOW = new Date('2026-11-16T03:30:00Z');
const fields = {
  paciente_apellido_paterno: 'Ejemplo',
  paciente_apellido_materno: 'Ficticio',
  paciente_nombres: 'Paciente de Prueba',
  paciente_rut: '12.345.678-5',
  paciente_fnac: '1959-03-20',
  paciente_sexo: 'F',
  medico_apellido_paterno: 'Prueba',
  medico_apellido_materno: 'Ficticio',
  medico_nombres: 'Profesional',
  medico_rut: '11.111.111-1',
};
const ready = () => ({
  ...ipdDefaults({ f: fields }, NOW),
  problema: '11',
  subgrupo: 'Catarata Bilateral',
  diagnostico: 'Diagnóstico libre',
  fundamentos: 'Fundamentos libres',
  tratamiento: 'Indicaciones libres',
});

test('IPD: 90 títulos MINSAL únicos por área, con las siete patologías oftalmológicas y subgrupos documentados', () => {
  assert.deepEqual(
    GES_PROBLEMAS.map((p) => Number(p.id)).sort((a, b) => a - b),
    Array.from({ length: 90 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    GES_AREAS.find((g) => g.area === 'Oftalmología').problemas.map((p) => p.titulo),
    GES_PATOLOGIAS,
  );
  assert.equal(GES_SUBGRUPOS.find((s) => s.problemaId === '11').opciones.length, 3);
  assert.deepEqual(GES_SUBGRUPOS.find((s) => s.problemaId === '29').opciones, ['Presbicia pura', 'Otros vicios de refracción']);
  assert.ok(GES_SUBGRUPOS.every((s) => s.fuente.includes('bibliotecaminsal.cl') && s.pagina > 0));
});

test('IPD: autocompleta nombres explícitos y usa Rapa Nui; no deduce clínica ni modifica la atención', () => {
  const rec = { f: { ...fields, fecha_atencion: '2020-01-01', diagnosticos_otros: 'Anterior', plan: 'Otro plan' } };
  const before = structuredClone(rec);
  const d = ipdDefaults(rec, NOW);
  assert.equal(d.fecha, '2026-11-15');
  assert.equal(d.hora, '22:30');
  assert.equal(d.paciente_apellido_paterno, 'Ejemplo');
  assert.equal(d.profesional_nombres, 'Profesional');
  for (const k of [
    'especialidad',
    'unidad',
    'historia',
    'problema',
    'diagnostico',
    'fundamentos',
    'tratamiento',
    'inicio_tratamiento',
    'folio',
  ]) {
    assert.equal(d[k], '', k);
  }
  assert.deepEqual(rec, before);
  const legacy = ipdDefaults({ f: { paciente_nombre: 'María José Tepano Pakarati', medico_nombre: 'Dra. Apellido' } }, NOW);
  assert.equal(legacy.paciente_nombres, '');
  assert.equal(legacy.profesional_apellido_paterno, '');
  assert.match(validateIpd(legacy), /apellido paterno y nombres del paciente/);
  assert.match(ipdDefaults({ f: {} }).fecha, /^\d{4}-\d{2}-\d{2}$/);
});

test('IPD: valida identidad y fechas, permite materno y administrativos vacíos y clínica libre', () => {
  const d = ready();
  assert.equal(validateIpd(d), null);
  assert.equal(
    validateIpd({ ...d, paciente_apellido_materno: '', profesional_apellido_materno: '', paciente_fnac: '', paciente_sexo: '' }),
    null,
  );
  for (const change of [
    { paciente_nombres: '' },
    { profesional_nombres: '' },
    { paciente_apellido_paterno: '' },
    { profesional_rut: '' },
    { paciente_rut: '12.345.678-9' },
    { profesional_rut: 'K11.111.111-1' },
    { paciente_rut: '123456789-2' },
    { problema: '999' },
    { fecha: '2026-02-30' },
    { hora: '24:01' },
    { paciente_fnac: '2030-01-01' },
    { paciente_fnac: '1959-02-30' },
    { inicio_tratamiento: 'no' },
    { historia: '1234567890' },
    { historia: 'ABC' },
  ]) {
    assert.ok(validateIpd({ ...d, ...change }), JSON.stringify(change));
  }
  assert.equal(validateIpd({ ...d, historia: '000123', inicio_tratamiento: '2026-11-20', diagnostico: 'Texto manual < y >' }), null);
});

test('IPD: PDF conserva cada dígito en su casilla, nombres en orden, datos fijos, SI con X y administrativos vacíos', async () => {
  const d = {
    ...ready(),
    historia: '123',
    folio: 'FICTICIO',
    especialidad: 'Oftalmología',
    unidad: 'Consulta',
    inicio_tratamiento: '2026-12-01',
  };
  const bytes = await buildIpdPdf(TEMPLATE, d, { flatten: false, now: NOW });
  const pdf = await PDFDocument.load(bytes),
    form = pdf.getForm();
  assert.equal(pdf.getPageCount(), 1);
  const value = (key) => form.getTextField(key).getText();
  assert.equal(value('servicio_salud'), IPD_HOSPITAL.servicio);
  assert.equal(value('establecimiento'), IPD_HOSPITAL.establecimiento);
  assert.equal(Array.from({ length: 8 }, (_, i) => value('fecha_informe_' + (i + 1))).join(''), '15112026');
  assert.equal(Array.from({ length: 4 }, (_, i) => value('hora_informe_' + (i + 1))).join(''), '2230');
  assert.equal(Array.from({ length: 8 }, (_, i) => value('fecha_nacimiento_' + (i + 1))).join(''), '20031959');
  assert.equal(Array.from({ length: 8 }, (_, i) => value('inicio_tratamiento_' + (i + 1))).join(''), '01122026');
  assert.equal(value('confirmacion_ges_si'), 'X');
  assert.equal(value('sexo'), 'X');
  assert.equal(value('edad_anos'), 'X');
  assert.equal(value('paciente_apellido_paterno'), 'Ejemplo');
  assert.equal(value('paciente_apellido_materno'), 'Ficticio');
  assert.equal(value('paciente_nombres'), 'Paciente de Prueba');
  assert.equal(value('profesional_apellido_paterno'), 'Prueba');
  assert.equal(value('diagnostico_1'), d.diagnostico);
  const scale = 568 / 1226;
  const rects = Array.from({ length: 8 }, (_, i) =>
    form
      .getTextField('fecha_informe_' + (i + 1))
      .acroField.getWidgets()[0]
      .getRectangle(),
  );
  const xs = [562, 596, 644, 678, 729, 762, 794, 827];
  rects.forEach((r, i) => {
    assert.ok(Math.abs(r.x - (22 + (xs[i] + 5) * scale)) < 0.01);
    assert.ok(r.width < 24 * scale);
    assert.ok(r.y > 700);
  });
  assert.match(ipdFileName(d), /^IPD_2026-11-15_12_345_678-5_Ejemplo_Ficticio_Paciente_de_Prueba.pdf$/);
});

test('IPD: aplanado sin widgets ni referencias colgantes; todos los títulos caben y textos extensos van completos al anexo', async () => {
  const pdf = await PDFDocument.load(await buildIpdPdf(TEMPLATE, ready(), { now: NOW }));
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getForm().getFields().length, 0);
  assert.equal(pdf.getPage(0).node.get(PDFName.of('Annots')), undefined);
  // getForm agrega un AcroForm vacío: comprobar el original nuevamente.
  const original = await PDFDocument.load(await buildIpdPdf(TEMPLATE, { ...ready(), paciente_sexo: 'M', paciente_fnac: '' }));
  assert.equal(original.catalog.get(PDFName.of('AcroForm')), undefined);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const p of GES_PROBLEMAS) assert.ok(wrapText(p.titulo, font, 10, (800 * 568) / 1226).length <= 3, p.titulo);
  const long = 'Texto clínico completo sin recortar. '.repeat(400);
  const annex = await PDFDocument.load(
    await buildIpdPdf(TEMPLATE, { ...ready(), subgrupo: long, diagnostico: long, fundamentos: long, tratamiento: long }),
  );
  assert.ok(annex.getPageCount() > 3);
  assert.ok(annex.getPages().every((p) => p.getWidth() === 612 && p.getHeight() === 792));
  await assert.rejects(() => buildIpdPdf(TEMPLATE, { ...ready(), problema: '' }), /Selecciona/);
  await assert.rejects(() => buildIpdPdf(TEMPLATE, { ...ready(), paciente_nombres: '患者' }), /letras/);
  await assert.rejects(() => buildIpdPdf(TEMPLATE, { ...ready(), paciente_nombres: 'Prueba '.repeat(100) }), /no cabe/);
});
