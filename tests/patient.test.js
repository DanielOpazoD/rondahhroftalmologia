import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patientIdFor,
  patientFromRecord,
  normalizePatient,
  missingPatients,
  attentionsOf,
  isAttended,
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
  assert.equal(r.v, 5);
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
  assert.deepEqual(Object.keys(m.f).sort(), ['paciente_rut', 'paciente_nombre', 'paciente_fono', 'paciente_fnac'].sort());
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

test('ficha eliminada (creada por error): viaja campo a campo, sale de duplicados y una atención la restaura', async () => {
  const { deletePatient, restorePatient, isDeletedPatient, DELETED_FIELD } = await import('../src/core/patient.js');
  const { patientUpdateFromRecord } = await import('../src/app/attentions.js');
  const T = 1_800_000_000_000;
  const p = normalizePatient({
    id: 'p_a',
    created: T,
    updated: T,
    f: { paciente_nombre: 'Juan Pérez', paciente_rut: '11.111.111-1' },
    ft: { 'f.paciente_nombre': T },
  });
  const twin = normalizePatient({ id: 'p_b', created: T, updated: T, f: { paciente_nombre: 'Juan Pérez' } });
  assert.equal(findDuplicatePairs([p, twin]).length, 1);
  const d = deletePatient(p, T + 10);
  assert.ok(isDeletedPatient(d));
  assert.equal(d.f.paciente_nombre, 'Juan Pérez', 'los datos no se borran (la ficha es común a las especialidades)');
  assert.equal(findDuplicatePairs([d, twin]).length, 0, 'una ficha eliminada no se propone como duplicado');
  // Otro equipo que aún tiene la versión anterior: la eliminación gana al fusionar.
  assert.ok(isDeletedPatient(normalizePatient(mergeRecords(p, d))));
  assert.ok(isDeletedPatient(normalizePatient(mergeRecords(d, p))));
  // Una marca inválida (manipulada) se descarta.
  assert.equal(isDeletedPatient(normalizePatient({ ...p, f: { ...p.f, [DELETED_FIELD]: '<script>' } })), false);
  // Restaurar: gana a la eliminación al fusionar, en cualquier orden.
  const r = restorePatient(d, T + 20);
  assert.equal(isDeletedPatient(r), false);
  assert.equal(isDeletedPatient(normalizePatient(mergeRecords(d, r))), false);
  assert.equal(isDeletedPatient(normalizePatient(mergeRecords(r, d))), false);
  // Guardar una atención que usa la ficha eliminada la restaura.
  const rec = {
    id: 'a1',
    pacienteId: 'p_a',
    created: T + 30,
    updated: T + 30,
    f: { paciente_nombre: 'Juan Pérez' },
    ft: { 'f.paciente_nombre': T + 30 },
  };
  const next = patientUpdateFromRecord(rec, d, T + 31);
  assert.equal(isDeletedPatient(normalizePatient(next)), false);
  assert.equal(isDeletedPatient(normalizePatient(mergeRecords(d, next))), false);
});

test('fichas dañadas o mal formadas: se rechazan o se limpian sin romper', async () => {
  const { renormalizePatient } = await import('../src/core/patient.js');
  for (const raw of [null, 'p_x', { id: 'a_123' }, { id: 'p_ con espacio' }, { id: 'p_' + 'x'.repeat(70) }]) {
    assert.equal(normalizePatient(raw), null, JSON.stringify(raw)?.slice(0, 30));
  }
  assert.throws(() => renormalizePatient({ id: 'no-es-ficha' }), /id inválido/, 'un error del código no pasa en silencio');
  for (const f of [undefined, 'texto', 42]) {
    const p = normalizePatient({ id: 'p_x', updated: 5, f });
    assert.deepEqual(p.f, {}, `f = ${f}`);
    assert.equal(p.created, 5, 'sin fecha de creación usa la de actualización');
  }
  // Textos de una versión más nueva se conservan; los inseguros, vacíos o enormes no.
  const p = normalizePatient({
    id: 'p_x',
    f: { ...JSON.parse('{"__proto__": "z"}'), paciente_nombre: 'Ana', campo_nuevo: 'sí', vacio: '  ', numero: 5, enorme: 'x'.repeat(2001) },
    ft: { 'f.paciente_nombre': 3, 'f.malo': 'ayer', 'otra.ruta': 4 },
  });
  assert.equal(p.f.campo_nuevo, 'sí');
  for (const k of ['vacio', 'numero', 'enorme', '__proto__']) assert.equal(Object.hasOwn(p.f, k), false, k);
  assert.equal(Object.getPrototypeOf(p.f), Object.prototype);
  assert.deepEqual(p.ft, { 'f.paciente_nombre': 3 }, 'solo fechas f.<campo> numéricas');
});

test('ficha recibida con f que no es objeto (respaldo o sincronización manipulados) se normaliza sin romper', () => {
  for (const f of [null, 'texto', 42, true]) assert.deepEqual(normalizePatient({ id: 'p_x', updated: 5, f })?.f, {}, String(f));
});

test('patientFromRecord: respeta el vínculo de la atención; sin datos del paciente no inventa ficha', () => {
  const rec = minimalRecord('a1', { paciente_nombre: 'Ana', paciente_rut: '12.345.678-5' });
  assert.equal(patientFromRecord({ ...rec, pacienteId: 'p_vinculada' }, 10).id, 'p_vinculada');
  const p = patientFromRecord(rec, 10);
  assert.equal(p.id, patientIdFor(rec.f));
  assert.deepEqual(p.ft, { 'f.paciente_nombre': 10, 'f.paciente_rut': 10 }, 'cada dato fechado con la edición que lo aportó');
  assert.equal(patientFromRecord(minimalRecord('a2', { plan: 'Control' }), 10), null);
});

test('patientLabel: nombre, o RUT, o «(sin nombre)»', async () => {
  const { patientLabel } = await import('../src/core/patient.js');
  assert.equal(patientLabel({ f: { paciente_nombre: 'Ana Tuki', paciente_rut: '1-9' } }), 'Ana Tuki');
  assert.equal(patientLabel({ f: { paciente_rut: '1-9' } }), '1-9');
  assert.equal(patientLabel({ f: {} }), '(sin nombre)');
  assert.equal(patientLabel(null), '(sin nombre)');
});

test('missingPatients: gana la atención más reciente aunque llegue primero; acepta fichas como objeto', () => {
  const recs = [
    minimalRecord('a2', { paciente_rut: '12.345.678-5', paciente_fono: 'nuevo' }, { updated: 20 }),
    minimalRecord('a1', { paciente_rut: '12.345.678-5', paciente_fono: 'viejo' }, { updated: 10 }),
    minimalRecord('a0', { paciente_rut: '12.345.678-5', paciente_fono: 'sin fecha' }, { updated: 0, created: 0 }),
    minimalRecord('s', { plan: 'Sin paciente' }),
  ];
  const [p] = missingPatients(recs, {});
  assert.equal(p.f.paciente_fono, 'nuevo');
  assert.equal(p.updated, 20);
  assert.deepEqual(missingPatients(recs, { [p.id]: p }), [], 'objeto por id, igual que un Map');
  // Sin `updated`, cuenta la fecha de creación.
  const onlyCreated = minimalRecord('c', { paciente_nombre: 'Eva' }, { updated: 0, created: 7 });
  assert.equal(missingPatients([onlyCreated], new Map())[0].updated, 7);
});

test('attentionsOf: misma fecha de atención → la creada después primero; luego la editada después', () => {
  const pid = 'p_x';
  const r = (id, fecha, created, updated) => ({ id, pacienteId: pid, f: fecha ? { fecha_atencion: fecha } : undefined, created, updated });
  const recs = [
    r('vieja', '2025-01-01', 1, 1),
    r('sin_fecha', undefined, 9, 9),
    r('tarde', '2026-05-01', 5, 5),
    r('temprano', '2026-05-01', 3, 3),
    r('editada', '2026-05-01', 3, 8),
    r('sin_tiempos', '2026-05-01'),
    r('sin_creacion', '2026-05-01', undefined, 4),
    { id: 'otro', pacienteId: 'p_y', f: { fecha_atencion: '2027-01-01' } },
  ];
  assert.deepEqual(
    attentionsOf(recs, pid).map((x) => x.id),
    ['tarde', 'editada', 'temprano', 'sin_creacion', 'sin_tiempos', 'vieja', 'sin_fecha'],
  );
});

test('isAttended: catarata o procedimientos cuentan como atención; campos nulos no', () => {
  assert.equal(isAttended({}), false);
  assert.equal(isAttended({ f: { plan: null, paciente_nombre: 'Ana' } }), false);
  assert.equal(isAttended({ cat: 'OD' }), true);
  assert.equal(isAttended({ proc: { fo: { eye: 'AO' } } }), true);
});

test('resolvePatientId: una ficha por nombre que ya se unió a otra resuelve a la vigente', () => {
  const pid = patientIdFor({ paciente_nombre: 'Rosa Pakarati' });
  const vigente = ficha('p_vigente001', { paciente_nombre: 'Rosa Pakarati', paciente_rut: '12.345.678-5' });
  const unida = ficha(pid, { paciente_nombre: 'Rosa Pakarati', fusionado_en: vigente.id });
  assert.equal(resolvePatientId({ paciente_nombre: 'rosa pakarati' }, [unida, vigente]), vigente.id);
  assert.equal(resolvePatientId({ paciente_nombre: 'Rosa Pakarati' }, null), pid, 'sin fichas: id derivado');
});

test('findDuplicatePairs: el par sale ordenado por id sin importar el orden de las fichas', () => {
  const z = ficha('p_zzzzzzzzz1', { paciente_nombre: 'Ana', paciente_rut: '12.345.678-5' });
  const a = ficha('p_aaaaaaaaa1', { paciente_nombre: 'Ana', paciente_rut: '123456785' });
  for (const list of [
    [z, a],
    [a, z],
  ]) {
    assert.deepEqual(
      findDuplicatePairs(list).map((p) => [p.a.id, p.b.id, p.motivo]),
      [[a.id, z.id, 'rut']],
      'un solo par (por RUT, no repetido por nombre)',
    );
  }
});

test('eliminar, restaurar y unir siempre suben la versión, aunque el reloj del equipo vaya atrasado', async () => {
  const { deletePatient, restorePatient } = await import('../src/core/patient.js');
  const p = ficha('p_aaaaaaaaa1', { paciente_nombre: 'Ana' }, 1000);
  const d = deletePatient(p, 500);
  assert.equal(d.updated, 1001);
  const r = restorePatient(d, 400);
  assert.equal(r.updated, 1002);
  assert.equal(restorePatient(r, 2000), r, 'restaurar una ficha no eliminada no la cambia');
  const sinFecha = normalizePatient({ id: 'p_bbbbbbbbb1', f: { paciente_nombre: 'Ana' } });
  assert.equal(deletePatient(sinFecha, 50).updated, 50);
  const { keep, drop } = mergePatients(p, sinFecha, 10);
  assert.deepEqual([keep.updated, drop.updated], [1001, 10]);
  // Fichas sin fecha (versión 0): toman la hora de la operación.
  assert.equal(mergePatients(sinFecha, p, 10).keep.updated, 10);
  const borradaSinFecha = normalizePatient({ id: 'p_ccccccccc1', f: { eliminada_en: '2026-01-01T00:00:00Z' } });
  assert.equal(restorePatient(borradaSinFecha, 30).updated, 30);
  assert.throws(() => mergePatients(p, p, 10), /misma ficha/);
});
