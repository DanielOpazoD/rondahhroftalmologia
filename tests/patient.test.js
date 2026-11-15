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
  resolvePatientId,
  canonicalPatientId,
  findDuplicatePairs,
  mergePatients,
  isCanonicalPatient,
} from '../src/core/patient.js';
import { syncMerge } from '../src/core/merge.js';
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

/* ------------------------------------------------- identidad y duplicados */

const ficha = (id, f, at = 10) =>
  normalizePatient({ id, created: at, updated: at, f, ft: Object.fromEntries(Object.keys(f).map((k) => ['f.' + k, at])) });

test('resolvePatientId: se encuentra al paciente por su RUT aunque su ficha naciera solo con nombre', () => {
  const porNombre = ficha(patientIdFor({ paciente_nombre: 'Rosa Pakarati' }), {
    paciente_nombre: 'Rosa Pakarati',
    paciente_rut: '12.345.678-5',
  });
  const pats = [porNombre];
  // Otro equipo la ingresa por RUT (otro formato): misma ficha, no una nueva.
  assert.equal(resolvePatientId({ paciente_rut: '123456785' }, pats), porNombre.id);
  // Una atención vinculada a su ficha sigue en ella al agregarle un RUT nuevo.
  assert.equal(resolvePatientId({ paciente_rut: '10.000.013-K', paciente_nombre: 'X' }, pats, porNombre.id), porNombre.id);
  // Sin coincidencias: id derivado (ficha nueva).
  assert.equal(resolvePatientId({ paciente_rut: '10.000.013-K' }, pats), patientIdFor({ paciente_rut: '10.000.013-K' }));
  assert.equal(resolvePatientId({}, pats), null);
});

test('uniones: se sigue la cadena, y uniones cruzadas de dos equipos no pierden la ficha', () => {
  const a = ficha('p_aaaaaaaaaa', { paciente_nombre: 'A', fusionado_en: 'p_bbbbbbbbbb' });
  const b = ficha('p_bbbbbbbbbb', { paciente_nombre: 'B', fusionado_en: 'p_cccccccccc' });
  const c = ficha('p_cccccccccc', { paciente_nombre: 'C' });
  assert.equal(canonicalPatientId([a, b, c], 'p_aaaaaaaaaa'), 'p_cccccccccc');
  // Equipo 1 une X→Y y equipo 2 une Y→X al mismo tiempo: gana el id menor en ambos.
  const x = ficha('p_xxxxxxxxx1', { paciente_nombre: 'X', fusionado_en: 'p_xxxxxxxxx2' });
  const y = ficha('p_xxxxxxxxx2', { paciente_nombre: 'X', fusionado_en: 'p_xxxxxxxxx1' });
  assert.equal(canonicalPatientId([x, y], x.id), x.id);
  assert.equal(canonicalPatientId([x, y], y.id), x.id);
  assert.deepEqual(
    [x, y].filter((p) => isCanonicalPatient([x, y], p)).map((p) => p.id),
    [x.id],
  );
  assert.equal(resolvePatientId({ paciente_nombre: 'A' }, [a, b, c], a.id), c.id);
});

test('findDuplicatePairs: mismo RUT (seguro) o mismo nombre sin datos que los distingan', () => {
  const r1 = ficha('p_r000000001', { paciente_nombre: 'Ana Tuki', paciente_rut: '12.345.678-5' });
  const r2 = ficha('p_r000000002', { paciente_nombre: 'ANA TUKI H.', paciente_rut: '123456785' });
  const n1 = ficha('p_n000000001', { paciente_nombre: 'José Pérez' });
  const n2 = ficha('p_n000000002', { paciente_nombre: 'jose perez', paciente_rut: '10.000.013-K' });
  // Homónimos con RUT distintos o fechas de nacimiento distintas: no son duplicados.
  const h1 = ficha('p_h000000001', { paciente_nombre: 'Juan Hito', paciente_rut: '12.345.678-5' });
  const h2 = ficha('p_h000000002', { paciente_nombre: 'Juan Hito', paciente_rut: '10.000.013-K' });
  const f1 = ficha('p_f000000001', { paciente_nombre: 'Eva Nui', paciente_fnac: '1950-01-01' });
  const f2 = ficha('p_f000000002', { paciente_nombre: 'Eva Nui', paciente_fnac: '1960-01-01' });
  const unida = ficha('p_u000000001', { paciente_nombre: 'José Pérez', fusionado_en: n1.id });
  const pairs = findDuplicatePairs([r1, r2, n1, n2, f1, f2, unida]);
  assert.deepEqual(
    pairs.map((p) => [p.a.id, p.b.id, p.motivo]),
    [
      [r1.id, r2.id, 'rut'],
      [n1.id, n2.id, 'nombre'],
    ],
  );
  assert.deepEqual(findDuplicatePairs([h1, h2]), [], 'mismo nombre y RUT distintos: personas distintas');
  assert.deepEqual(findDuplicatePairs([n1, n2], new Set([n1.id + '|' + n2.id])), [], 'descartado por el usuario');
});

test('mergePatients: completa los datos vacíos, marca la absorbida y no une RUT distintos', () => {
  const keep = ficha('p_k000000001', { paciente_nombre: 'José Pérez', paciente_rut: '10.000.013-K' }, 10);
  const drop = ficha('p_d000000001', { paciente_nombre: 'Jose Perez', paciente_fono: '555', paciente_fnac: '1950-02-03' }, 20);
  const { keep: k, drop: d } = mergePatients(keep, drop, 100);
  assert.equal(k.f.paciente_nombre, 'José Pérez', 'lo de la ficha que se conserva no se pisa');
  assert.equal(k.f.paciente_fono, '555');
  assert.equal(k.f.paciente_fnac, '1950-02-03');
  assert.equal(d.f.fusionado_en, keep.id);
  assert.equal(canonicalPatientId([k, d], d.id), k.id);
  // La marca de unión viaja por la sincronización como un campo más.
  const otroEquipo = { ...drop, f: { ...drop.f, paciente_fono: '777' }, ft: { ...drop.ft, 'f.paciente_fono': 50 }, updated: 50 };
  const m = normalizePatient(syncMerge('paciente', otroEquipo, d).data);
  assert.equal(m.f.fusionado_en, keep.id);
  assert.equal(m.f.paciente_fono, '777');
  const otro = ficha('p_o000000001', { paciente_nombre: 'José Pérez', paciente_rut: '12.345.678-5' });
  assert.throws(() => mergePatients(keep, otro, 100), /RUT distintos/);
  assert.equal(normalizePatient({ id: 'p_k000000001', f: { fusionado_en: 'p_k000000001' } }).f.fusionado_en, undefined, 'no consigo misma');
});
