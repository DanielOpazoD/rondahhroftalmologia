import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSave, buildAdmission, relinkRecord, patientUpdateFromRecord, nonEmpty } from '../src/app/attentions.js';
import { patientFromRecord, patientIdFor, isAttended } from '../src/core/patient.js';
import { mergeRecords } from '../src/core/merge.js';
import { minimalRecord, PROCS } from './fixtures.js';

const NOW = 1_800_000_000_000;

test('prepareSave: atención nueva recibe id, fecha de creación, vínculo y nombres de procedimientos', () => {
  const draft = minimalRecord(null, { paciente_nombre: 'Ana', paciente_rut: '12.345.678-5' });
  draft.proc = { fo: { eye: 'AO' } };
  const rec = prepareSave({ rec: draft, patients: [], procs: PROCS, now: NOW });
  assert.match(rec.id, /^a/);
  assert.equal(rec.created, NOW);
  assert.equal(rec.updated, NOW);
  assert.equal(rec.pacienteId, patientIdFor({ paciente_rut: '12.345.678-5' }));
  assert.equal(rec.procNames.fo, PROCS.find((p) => p.id === 'fo').n);
});

test('prepareSave: fusiona con lo que otro equipo guardó mientras se editaba', () => {
  const stored = minimalRecord('x1', { paciente_nombre: 'Ana', od_pio: '18' }, { updated: NOW - 10 });
  stored.ft = { 'f.paciente_nombre': NOW - 100, 'f.od_pio': NOW - 10 };
  const draft = {
    ...structuredClone(stored),
    f: { paciente_nombre: 'Ana', plan: 'Control' },
    ft: { 'f.paciente_nombre': NOW - 100, 'f.plan': NOW - 5 },
  };
  const rec = prepareSave({ rec: draft, stored, patients: [], procs: PROCS, now: NOW });
  assert.equal(rec.f.od_pio, '18', 'lo del otro equipo se conserva');
  assert.equal(rec.f.plan, 'Control');
  assert.ok(rec.updated > stored.updated);
});

test('prepareSave: agregar el RUT pasa la atención a la ficha de ese RUT, con el cambio FECHADO', () => {
  // Regresión: el vínculo cambiaba sin fecha y la fusión entre equipos podía elegir la ficha anterior.
  const rutPatient = patientFromRecord(minimalRecord('z', { paciente_nombre: 'Rosa T.', paciente_rut: '12.345.678-5' }), 10);
  const nameId = patientIdFor({ paciente_nombre: 'Rosa' });
  const stored = minimalRecord('x2', { paciente_nombre: 'Rosa' }, { updated: NOW - 50 });
  Object.assign(stored, { pacienteId: nameId, ft: { 'f.paciente_nombre': NOW - 50, pacienteId: NOW - 50 } });
  const draft = { ...structuredClone(stored), f: { ...stored.f, paciente_rut: '123456785' } };
  const rec = prepareSave({ rec: draft, stored, patients: [rutPatient], procs: PROCS, now: NOW });
  assert.equal(rec.pacienteId, rutPatient.id);
  assert.equal(rec.ft.pacienteId, rec.updated);
  // Otro equipo con la versión anterior: la fusión respeta el cambio fechado, en cualquier orden.
  for (const m of [mergeRecords(rec, stored), mergeRecords(stored, rec)]) assert.equal(m.pacienteId, rutPatient.id);
});

test('buildAdmission: preingreso con datos de la ficha, por atender y con fechas por campo', () => {
  const master = patientFromRecord(
    minimalRecord('m', { paciente_rut: '12.345.678-5', paciente_nombre: 'Rosa', paciente_fono: '555', paciente_fnac: '1950-03-01' }),
    10,
  );
  const rec = buildAdmission({
    fields: nonEmpty({ paciente_rut: '12.345.678-5', paciente_nombre: '', paciente_sexo: 'F' }),
    fecha: '2026-11-15',
    operativo: 'Op',
    master,
    pacienteId: master.id,
    now: NOW,
  });
  assert.equal(rec.f.paciente_nombre, 'Rosa', 'completa desde la ficha');
  assert.equal(rec.f.paciente_fono, '555');
  assert.equal(rec.f.paciente_sexo, 'F');
  assert.equal(rec.f.paciente_edad, '76');
  assert.equal(rec.f.operativo, 'Op');
  assert.equal(rec.pacienteId, master.id);
  assert.equal(isAttended(rec), false);
  assert.equal(rec.ft['f.paciente_sexo'], NOW);
});

test('relinkRecord: fecha el vínculo y una atención antigua sin fechas conserva las de sus campos', () => {
  const old = minimalRecord('o', { paciente_nombre: 'Ana', od_pio: '15' }, { updated: 500 });
  delete old.ft;
  const r = relinkRecord(old, 'p_nuevo00001', 1000);
  assert.equal(r.pacienteId, 'p_nuevo00001');
  assert.equal(r.ft.pacienteId, 1000);
  assert.equal(r.ft['f.od_pio'], 500, 'no queda en 0');
  assert.equal(r.updated, 1000);
});

test('patientUpdateFromRecord: crea, fusiona por campo y no reescribe si nada cambió', () => {
  const rec = minimalRecord('r', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana', paciente_fono: '111' }, { updated: 100 });
  rec.pacienteId = patientIdFor(rec.f);
  rec.ft = { 'f.paciente_nombre': 100, 'f.paciente_fono': 100, 'f.paciente_rut': 100 };
  const created = patientUpdateFromRecord(rec, null, 100);
  assert.equal(created.f.paciente_fono, '111');
  assert.equal(patientUpdateFromRecord(rec, created, 200), null, 'sin cambios: no se escribe');
  const newer = { ...structuredClone(created), f: { ...created.f, paciente_fono: '999' }, ft: { ...created.ft, 'f.paciente_fono': 300 } };
  assert.equal(patientUpdateFromRecord(rec, newer, 400), null, 'un dato más nuevo de la ficha no se pisa con uno viejo');
  assert.equal(patientUpdateFromRecord({ ...rec, pacienteId: undefined }, null, 1), null);
});
