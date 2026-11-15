/**
 * Pruebas de referencia ("golden"): congelan las SALIDAS que usa el hospital
 * (nota para Eloísa, hojas Excel, exportación seudonimizada y campos del PDF).
 * Cualquier cambio en ellas, aunque sea un carácter, hace fallar la prueba.
 *
 * Si un cambio de salida es intencional: UPDATE_GOLDEN=1 npm test  y revisar el diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { buildNote } from '../src/specialties/oftalmologia/nota.js';
import { statsWorkbook } from '../src/specialties/oftalmologia/reportes.js';
import {} from '../src/core/pseudonym.js';
import { anonymizeRecords, anonymizedJson, anonymizedSheets } from '../src/specialties/oftalmologia/seudonimizacion.js';
import { buildAttentionPdf, pdfFileName } from '../src/specialties/oftalmologia/pdf.js';
import { fullRecord, minimalRecord, PROCS } from './fixtures.js';

// Zona horaria fija (Rapa Nui) para que las horas impresas sean iguales en todo equipo y en la CI.
process.env.TZ = 'Pacific/Easter';
const NOW = new Date(Date.UTC(2026, 10, 14, 15, 30));
const dir = new URL('./golden/', import.meta.url);

function golden(name, value) {
  const file = new URL(name, dir);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, 'utf8'), `La salida "${name}" cambió`);
}

const sample = () => [
  fullRecord(),
  minimalRecord(
    'b',
    {
      paciente_nombre: 'Juan Pérez',
      paciente_rut: '12.345.678-5',
      paciente_edad: '54',
      paciente_sexo: 'M',
      operativo: 'Operativo Prueba Nov 2026',
      od_pio: '22',
    },
    { checks: { diagnostico_glaucoma: true }, proc: { c_tension: { eye: 'AO', od: '22', oi: '24' } } },
  ),
  minimalRecord(
    'c',
    { paciente_nombre: 'Niña Prueba', paciente_edad: '8', paciente_sexo: 'F', fecha_atencion: '2026-11-15' },
    { checks: { diagnostico_miopia: true }, proc: { autorref: { eye: 'AO' } } },
  ),
];

test('nota para Eloísa', () => {
  golden('nota.txt', buildNote(fullRecord(), PROCS, { pie: '(Registro en hoja de contingencia por caída de plataforma)' }));
});

test('Excel de estadística (todas las hojas)', () => {
  golden('estadistica.json', statsWorkbook(sample(), PROCS, { operativo: '' }, NOW));
});

test('exportación seudonimizada (JSON y Excel)', () => {
  const res = anonymizeRecords(sample(), PROCS, { secret: 'c'.repeat(64) });
  golden('seudonimizado.json', anonymizedJson(res, NOW));
  golden('seudonimizado_excel.json', anonymizedSheets(res, PROCS, NOW));
});

test('PDF: nombre de archivo, páginas, campos y casillas', async () => {
  const tpl = readFileSync(new URL('../src/specialties/oftalmologia/plantilla.pdf', import.meta.url));
  const out = {};
  for (const rec of sample()) {
    const r = await buildAttentionPdf(tpl, rec, PROCS, { flatten: false, now: NOW });
    const form = (await PDFDocument.load(r.bytes)).getForm();
    const fields = {};
    for (const f of form.getFields()) {
      const name = f.getName();
      if (f.constructor.name === 'PDFTextField') {
        const t = form.getTextField(name).getText();
        if (t) fields[name] = t;
      } else if (f.constructor.name === 'PDFCheckBox' && form.getCheckBox(name).isChecked()) fields[name] = true;
    }
    out[rec.id] = { archivo: pdfFileName(rec), paginas: r.pages, hojaComplementaria: r.overflow, campos: fields };
  }
  golden('pdf.json', out);
});
