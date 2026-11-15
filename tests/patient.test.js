import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patientIdFor,
  patientFromRecord,
  normalizePatient,
  missingPatients,
  attentionsOf,
  isAttended,
  PATIENT_FIELDS,
} from '../src/core/patient.js';
import { normalizeRecord } from '../src/core/record.js';
import { mergeRecords, stampChanges } from '../src/core/merge.js';
import { minimalRecord } from './fixtures.js';
import { buildBackup, parseBackup, mergeBackup } from '../src/core/backup.js';

test('id de paciente determinista: por RUT (sin importar formato) o por nombre', () => {
  const a = patientIdFor({ paciente_rut: '12.345.678-5', paciente_nombre: 'Ana' });
  assert.match(a, /^p_[0-9a-z]{10}$/);
  assert.equal(patientIdFor({ paciente_rut: '123456785', paciente_nombre: 'Otro nombre' }), a, 'el RUT manda');
  assert.equal(patientIdFor({ paciente_nombre: 'José  PÉREZ' }), patientIdFor({ paciente_nombre: 'jose perez' }));
  assert.notEqual(patientIdFor({ paciente_nombre: 'Ana' }), a);
  assert.equal(patientIdFor({}), null);
});

test('migración v4: cada atención antigua queda vinculada a su paciente', () => {
  const r = normalizeRecord({ id: 'x', v: 3, f: { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana' } });
  assert.equal(r.v, 4);
  assert.equal(r.pacienteId, patientIdFor({ paciente_rut: '12345678-5' }));
  assert.equal(normalizeRecord({ id: 'y', v: 3, f: {} }).pacienteId, undefined, 'sin datos no inventa paciente');
});

test('missingPatients crea las fichas faltantes (una por paciente, con los datos más recientes)', () => {
  const recs = [
    minimalRecord('a1', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana', paciente_fono: 'viejo' }, { updated: 10 }),
    minimalRecord('a2', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana Tuki', paciente_fono: '999' }, { updated: 20 }),
    minimalRecord('b1', { paciente_nombre: 'Sin Rut' }, { updated: 5 }),
  ];
  const created = missingPatients(recs, new Map());
  assert.equal(created.length, 2);
  const ana = created.find((p) => p.f.paciente_rut);
  assert.deepEqual(ana.f, { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana Tuki', paciente_fono: '999' });
  assert.deepEqual(missingPatients(recs, new Map(created.map((p) => [p.id, p]))), [], 'idempotente');
  assert.deepEqual(
    attentionsOf(recs, ana.id).map((r) => r.id),
    ['a2', 'a1'],
  );
});

test('preingreso pendiente vs atención con datos clínicos', () => {
  const pre = minimalRecord('p', {
    paciente_nombre: 'Ana',
    paciente_rut: '1-9',
    operativo: 'Op',
    medico_nombre: 'Dra.',
    paciente_edad: '40',
  });
  assert.equal(isAttended(pre), false);
  assert.equal(isAttended({ ...pre, f: { ...pre.f, od_pio: '14' } }), true);
  assert.equal(isAttended({ ...pre, checks: { diagnostico_rdp: true } }), true);
  assert.equal(isAttended({ ...pre, proc: { fo: { eye: 'AO' } } }), true);
});

test('la misma ficha editada en dos equipos se fusiona campo a campo', () => {
  const base = patientFromRecord(minimalRecord('a', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana' }), 10);
  const edit = (t, k, v) => {
    const n = structuredClone(base);
    n.f[k] = v;
    n.updated = t;
    return stampChanges(n, base, t);
  };
  const m = normalizePatient(mergeRecords(edit(20, 'paciente_fono', '555'), edit(30, 'paciente_fnac', '1960-01-02')));
  assert.equal(m.f.paciente_fono, '555');
  assert.equal(m.f.paciente_fnac, '1960-01-02');
  assert.deepEqual(Object.keys(m.f).sort(), [...PATIENT_FIELDS].filter((k) => k !== 'paciente_sexo').sort());
  assert.equal(normalizePatient({ id: 'a1', f: {} }), null, 'id de paciente debe empezar con p_');
});

test('respaldo: incluye las fichas y al importar se fusionan campo a campo', () => {
  const base = patientFromRecord(minimalRecord('a', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana' }), 10);
  const local = { ...base, f: { ...base.f, paciente_fono: '555' }, ft: { ...base.ft, 'f.paciente_fono': 20 }, updated: 20 };
  const remota = { ...base, f: { ...base.f, paciente_fnac: '1950-01-02' }, ft: { ...base.ft, 'f.paciente_fnac': 30 }, updated: 30 };
  const text = JSON.stringify(buildBackup({ records: [], procs: [], patients: [remota, { id: 'malo', f: {} }] }));
  const incoming = parseBackup(text);
  assert.equal(incoming.patients.length, 1, 'descarta fichas inválidas');
  const m = mergeBackup({ records: [], procs: [], patients: [local] }, incoming);
  assert.equal(m.patients.length, 1);
  assert.equal(m.patients[0].f.paciente_fono, '555');
  assert.equal(m.patients[0].f.paciente_fnac, '1950-01-02');
  assert.ok(m.patients[0].updated > 30);
  assert.deepEqual(parseBackup(JSON.stringify({ atenciones: [] })).patients, [], 'respaldos antiguos: sin fichas');
});
