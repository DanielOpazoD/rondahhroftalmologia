import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clinicalFormValues, rememberClinicalForm } from '../src/core/clinicalForms.js';
import { blankRecord, normalizeRecord } from '../src/core/record.js';
import { mergeRecords, syncFingerprint, syncMerge } from '../src/core/merge.js';
import { buildBackup, parseBackup, mergeBackup } from '../src/core/backup.js';
import { createRepo } from '../src/storage/repo.js';
import { auditLabel } from '../src/core/audit.js';
import { isAttended } from '../src/core/patient.js';

const defaults = { paciente_nombre: 'Paciente Ficticio', fecha: '2026-11-15', diagnostico: '', tratamiento: '' };
const record = () =>
  normalizeRecord({
    ...blankRecord(),
    id: 'a_prueba',
    created: 10,
    updated: 10,
    f: { paciente_nombre: 'Paciente Ficticio', fecha_atencion: '2026-11-15' },
  });

test('formularios: propone datos sin modificar la ficha; guarda cada tipo separado y conserva vacíos expresos', () => {
  const base = record(),
    before = structuredClone(base);
  assert.deepEqual(clinicalFormValues(base, 'ges', defaults), defaults);
  const edited = { ...defaults, paciente_nombre: '', diagnostico: 'Diagnóstico manual' };
  let saved = rememberClinicalForm(base, 'ges', defaults, edited, 100);
  assert.deepEqual(base, before);
  assert.equal(saved.f.paciente_nombre, 'Paciente Ficticio');
  assert.equal(saved.ft['f.form_ges_paciente_nombre'], 100);
  assert.deepEqual(clinicalFormValues(saved, 'ges', defaults), edited);
  assert.deepEqual(clinicalFormValues(saved, 'ipd', defaults), defaults);
  assert.deepEqual(clinicalFormValues(saved, 'receta', defaults), defaults);
  const same = rememberClinicalForm(saved, 'ges', edited, edited, 200);
  assert.equal(same, saved, 'no reescribe ni cambia fechas si nada se editó');
  saved = rememberClinicalForm(saved, 'ges', edited, { ...edited, diagnostico: '' }, 200);
  const merged = normalizeRecord(mergeRecords(saved, record()));
  assert.equal(merged.f.form_ges_diagnostico, undefined, 'la fusión omite textos vacíos');
  assert.equal(clinicalFormValues(merged, 'ges', { ...defaults, diagnostico: 'Nueva propuesta' }).diagnostico, '');
  assert.equal(clinicalFormValues(merged, 'ges', { ...defaults, paciente_nombre: 'Otra propuesta' }).paciente_nombre, '');
  assert.deepEqual(clinicalFormValues(record(), 'ges', defaults), defaults, 'otra atención parte de cero');
});

test('formularios: dos equipos editan campos distintos desde cero y ninguno reemplaza la clínica del otro por sus propuestas', () => {
  const base = record();
  const a = rememberClinicalForm(base, 'ipd', defaults, { ...defaults, diagnostico: 'Diagnóstico A' }, 100);
  const b = rememberClinicalForm(base, 'ipd', defaults, { ...defaults, tratamiento: 'Tratamiento B' }, 200);
  for (const combined of [mergeRecords(a, b), mergeRecords(b, a), syncMerge('atencion', a, b).data]) {
    const values = clinicalFormValues(normalizeRecord(combined), 'ipd', defaults);
    assert.equal(values.diagnostico, 'Diagnóstico A');
    assert.equal(values.tratamiento, 'Tratamiento B');
  }
  const fresh = normalizeRecord(mergeRecords(a, b));
  const localUpdate = rememberClinicalForm(fresh, 'ipd', defaults, { ...defaults, fecha: '2026-11-16' }, 300);
  assert.equal(localUpdate.f.form_ipd_diagnostico, 'Diagnóstico A', 'no arrastra el texto viejo de una ventana');
  assert.equal(localUpdate.f.form_ipd_tratamiento, 'Tratamiento B');
  assert.notEqual(syncFingerprint('atencion', base), syncFingerprint('atencion', a));
});

test('formularios: migración v5, respaldo, unión y repositorio preservan el borrador, sus sellos y los campos vaciados', async () => {
  const old = { ...record(), v: 5 };
  let saved = rememberClinicalForm(normalizeRecord(old), 'receta', defaults, { ...defaults, diagnostico: 'Texto de prueba' }, 100);
  saved = rememberClinicalForm(saved, 'receta', { ...defaults, diagnostico: 'Texto de prueba' }, { ...defaults, diagnostico: '' }, 200);
  assert.equal(saved.v, 6);
  const backup = parseBackup(JSON.stringify(buildBackup({ records: [saved], procs: [] })));
  const restored = mergeBackup({ records: [], procs: [] }, backup).records[0];
  assert.equal(restored.ft['f.form_receta_diagnostico'], 200);
  const collections = new Map();
  const backend = {
    name: 'prueba',
    getAll: async (col) => structuredClone([...(collections.get(col)?.values() || [])]),
    put: async (col, value) => {
      if (!collections.has(col)) collections.set(col, new Map());
      collections.get(col).set(value.id, structuredClone(value));
    },
    putMany: async (col, values) => {
      for (const value of values) await backend.put(col, value);
    },
    get: async () => undefined,
    keys: async () => [],
    delete: async () => {},
    clear: async () => {},
  };
  const repo = createRepo(backend);
  await repo.init();
  repo.upsertRecord(restored);
  await repo.flush();
  const next = createRepo(backend);
  await next.init();
  assert.deepEqual(clinicalFormValues(next.getRecord(saved.id), 'receta', defaults), defaults);
  assert.equal(next.getRecord(saved.id).ft['f.form_receta_diagnostico'], 200);
});

test('formularios: ignora campos extra o claves que no pertenecen al formulario', () => {
  const base = record();
  const saved = rememberClinicalForm(
    base,
    'ges',
    { ...defaults, ['x'.repeat(70)]: '' },
    { ...defaults, intruso: 'no guardar', ['x'.repeat(70)]: 'no guardar' },
    100,
  );
  assert.equal(saved.f.form_ges_intruso, undefined);
  assert.equal(saved.f['form_ges_' + 'x'.repeat(70)], undefined);
  assert.equal(auditLabel('f.form_receta_lejos_od'), 'Receta de lentes · Lejos OD');
  assert.equal(auditLabel('f.form_ipd_diagnostico'), 'IPD · Diagnostico');
  assert.equal(auditLabel('f.form_ges_paciente_rut'), 'GES · RUT');
});

test('formularios: guardar identificación o fecha no marca como atendido; registrar clínica sí', () => {
  const base = record();
  const seed = rememberClinicalForm(base, 'ipd', defaults, defaults, 100);
  assert.equal(isAttended(seed), false);
  const ipd = rememberClinicalForm(seed, 'ipd', defaults, { ...defaults, diagnostico: 'Diagnóstico de prueba' }, 200);
  assert.equal(isAttended(ipd), true);
  const ges = rememberClinicalForm(base, 'ges', { patologia: '' }, { patologia: 'Patología de prueba' }, 200);
  assert.equal(isAttended(ges), true);
  const receta = rememberClinicalForm(base, 'receta', { lejos_od: '' }, { lejos_od: '-1,00' }, 200);
  assert.equal(isAttended(receta), true);
});
