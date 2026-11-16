import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStats,
  filterRecords,
  ageGroup,
  ageGroupLabels,
  operativosOf,
  describeFilter,
} from '../src/specialties/oftalmologia/estadistica.js';
import { statsWorkbook } from '../src/specialties/oftalmologia/reportes.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { fullRecord, minimalRecord, PROCS } from './fixtures.js';
import { readZipWithPython, sheetCells } from './helpers.js';

const sample = () => [
  fullRecord(),
  // mismo paciente (RUT sin puntos), otro día
  minimalRecord(
    'b',
    {
      paciente_rut: '11111111-1',
      paciente_edad: '67',
      paciente_sexo: 'F',
      operativo: 'Operativo Prueba Nov 2026',
      fecha_atencion: '2026-11-15',
    },
    { proc: { fo: { eye: 'OD' } }, checks: { diagnostico_glaucoma: true } },
  ),
  minimalRecord(
    'c',
    {
      paciente_nombre: 'Pedro Hotus',
      paciente_edad: '8',
      paciente_sexo: 'M',
      operativo: 'Ronda Dic',
      fecha_atencion: '2026-12-01',
      interconsulta: 'IC',
    },
    { checks: { diagnostico_miopia: true } },
  ),
  minimalRecord('d', { paciente_nombre: 'Sin Edad', fecha_atencion: '2026-12-02' }),
];

test('ageGroup y etiquetas', () => {
  assert.equal(ageGroup(0), '0-14');
  assert.equal(ageGroup(14), '0-14');
  assert.equal(ageGroup(15), '15-19');
  assert.equal(ageGroup(64), '45-64');
  assert.equal(ageGroup(80), '80+');
  assert.equal(ageGroup(null), 'Sin dato');
  assert.deepEqual(ageGroupLabels(), ['0-14', '15-19', '20-44', '45-64', '65-79', '80+', 'Sin dato']);
});

test('filterRecords por operativo y rango inclusivo', () => {
  const all = sample();
  assert.equal(filterRecords(all, { operativo: 'Ronda Dic' }).length, 1);
  assert.equal(filterRecords(all, { desde: '2026-11-15', hasta: '2026-12-01' }).length, 2);
  assert.equal(filterRecords(all, {}).length, 4);
  assert.deepEqual(operativosOf(all), ['Operativo Prueba Nov 2026', 'Ronda Dic']);
  assert.equal(describeFilter({ operativo: 'X', desde: '2026-01-01' }), 'X · 2026-01-01 a …');
});

test('computeStats: pacientes distintos, procedimientos por ojo, dx, sexo, edad', () => {
  const S = computeStats(sample(), PROCS);
  assert.equal(S.n, 4);
  assert.equal(S.pacientes, 3, 'mismo RUT con y sin puntos cuenta una vez');
  assert.deepEqual(S.proc['Fondo de ojo (FO)'], { pac: 2, od: 2, oi: 1, ojos: 3 });
  assert.deepEqual(S.proc['T. Neumática'], { pac: 1, od: 1, oi: 0, ojos: 1 });
  assert.equal(S.procTotal, 7); // incluye la BMC del registro completo
  assert.equal(S.ojos, 10);
  assert.equal(S.dx.Catarata, 1);
  assert.equal(S.dx['Otros diagnósticos'], 1);
  assert.deepEqual(S.sexo, { F: 2, M: 1, O: 0, 'Sin dato': 1 });
  assert.equal(S.edadSexo['65-79'].F, 2);
  assert.equal(S.edadSexo['0-14'].M, 1);
  assert.equal(S.edadSexo['Sin dato']['Sin dato'], 1);
  assert.equal(S.edad.mediana, 67);
  assert.equal(S.gest.ic, 2);
  assert.deepEqual(
    S.porDia.map((d) => d.fecha),
    ['2026-11-14', '2026-11-15', '2026-12-01', '2026-12-02'],
  );
  assert.equal(computeStats([], PROCS).edad.promedio, null);
});

test('statsWorkbook arma las 5 hojas y produce un .xlsx válido', () => {
  const recs = sample();
  const sheets = statsWorkbook(recs, PROCS, { operativo: '' }, new Date(2026, 10, 20));
  assert.deepEqual(
    sheets.map((s) => s.name),
    ['Resumen', 'Atenciones', 'Prestaciones', 'Por día', 'Edad y sexo'],
  );
  const at = sheets[1];
  assert.equal(at.rows.length, 5);
  const head = at.rows[0];
  assert.ok(head.includes('Dx Catarata') && head.includes('T. Aplanática'));
  const row = at.rows[1];
  assert.equal(row[head.indexOf('T. Aplanática')], 'AO');
  assert.equal(row[head.indexOf('PIO OD')], '14 Apl');
  assert.equal(row[head.indexOf('Dx Catarata')], 1);
  assert.equal(row[head.indexOf('Catarata ojo')], 'OD');
  assert.equal(sheets[2].rows.length, 1 + 7, 'una fila por procedimiento');
  assert.equal(row[head.indexOf('AVcc OD')], '20/60');

  const files = readZipWithPython(buildXlsx(sheets));
  const resumen = sheetCells(files['xl/worksheets/sheet1.xml']);
  assert.ok(Object.values(resumen).includes('Pacientes distintos'));
});
