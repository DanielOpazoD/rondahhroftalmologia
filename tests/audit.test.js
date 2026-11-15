import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { auditChanges, auditLabel, makeAuditEntry, mergeAuditDocs, shortValue } from '../src/core/audit.js';
import { migrate, FutureVersionError, isFutureVersion, STEPS } from '../src/core/migrations.js';
import { normalizeRecord } from '../src/core/record.js';
import { syncMerge, syncFingerprint } from '../src/core/merge.js';
import { buildBackup, parseBackup, mergeBackup } from '../src/core/backup.js';
import { SCHEMA_VERSION } from '../src/config/catalogs.js';
import { minimalRecord, PROCS } from './fixtures.js';

describe('bitácora', () => {
  test('auditChanges lista solo lo que cambió, con antes y después', () => {
    const a = minimalRecord(
      'x',
      { od_pio: '14', plan: 'A' },
      { checks: { diagnostico_rdp: true }, proc: { t_aplan: { eye: 'AO', od: '14' } } },
    );
    const b = minimalRecord('x', { od_pio: '18', plan: 'A', receta: 'Gotas' }, { checks: {}, proc: { t_aplan: { eye: 'AO', od: '15' } } });
    assert.deepEqual(auditChanges(a, b), [
      { c: 'checks.diagnostico_rdp', a: true },
      { c: 'f.od_pio', a: '14', d: '18' },
      { c: 'f.receta', d: 'Gotas' },
      { c: 'proc.t_aplan.od', a: '14', d: '15' },
    ]);
  });

  test('etiquetas legibles', () => {
    assert.equal(auditLabel('f.od_pio'), 'PIO OD');
    assert.equal(auditLabel('checks.diagnostico_glaucoma'), 'Dx Glaucoma');
    assert.equal(auditLabel('proc.t_aplan.oi', PROCS), 'T. Aplanática PIO OI');
    assert.equal(auditLabel('proc.fo.eye', PROCS), 'Fondo de ojo (FO) (ojo)');
    assert.equal(auditLabel('cat'), 'Catarata (ojo)');
    assert.equal(shortValue(''), 'vacío');
    assert.equal(shortValue(true), 'sí');
    assert.equal(shortValue('x'.repeat(60)).length, 40);
  });

  test('makeAuditEntry: creada / editada / sin cambios / eliminada', () => {
    const r = minimalRecord('x', { paciente_nombre: 'Ana' });
    const created = makeAuditEntry({ tipo: 'creada', after: r, at: 100, equipo: 'Box 1', equipoId: 'pc1', rand: () => 0.5 });
    assert.equal(created.tipo, 'creada');
    assert.ok(created.cambios.some((c) => c.c === 'f.paciente_nombre' && c.d === 'Ana'));
    assert.equal(makeAuditEntry({ tipo: 'editada', before: r, after: r, at: 101, equipo: 'Box 1', equipoId: 'pc1' }), null);
    const del = makeAuditEntry({ tipo: 'eliminada', at: 102, equipo: '', equipoId: 'pc1' });
    assert.deepEqual([del.tipo, del.cambios, del.equipo], ['eliminada', [], 'Equipo sin nombre']);
  });

  test('dos equipos agregan entradas a la vez: la unión conserva todas', () => {
    const base = { id: 'b_x', atencionId: 'x', updated: 1, entries: [{ id: 'e0', at: 1 }] };
    const pc1 = { ...base, updated: 5, entries: [...base.entries, { id: 'e1', at: 5 }] };
    const pc2 = { ...base, updated: 6, entries: [...base.entries, { id: 'e2', at: 6 }] };
    const m = mergeAuditDocs(pc1, pc2);
    assert.deepEqual(
      m.entries.map((e) => e.id),
      ['e0', 'e1', 'e2'],
    );
    assert.deepEqual(mergeAuditDocs(pc2, pc1).entries, m.entries, 'conmutativa');
    const viaSync = syncMerge('bitacora', pc1, pc2);
    assert.equal(viaSync.data.entries.length, 3);
    assert.equal(viaSync.sameAsRemote, false);
    assert.equal(syncFingerprint('bitacora', m), syncFingerprint('bitacora', mergeAuditDocs(pc2, pc1)));
  });
});

describe('migraciones', () => {
  test('lleva v1 a la versión actual paso a paso', () => {
    const r = migrate({ id: 'a', f: {} });
    assert.equal(r.v, SCHEMA_VERSION);
    assert.equal(r.especialidad, 'oftalmologia');
    for (let v = 1; v < SCHEMA_VERSION; v++) assert.equal(typeof STEPS[v], 'function', `falta el paso v${v}`);
  });

  test('una versión futura no se degrada: se rechaza', () => {
    const futura = { id: 'a', v: SCHEMA_VERSION + 1, nuevo: true };
    assert.ok(isFutureVersion(futura));
    assert.throws(() => migrate(futura), FutureVersionError);
    assert.throws(() => normalizeRecord(futura), FutureVersionError);
    assert.equal(syncMerge('atencion', futura, minimalRecord('a')), null, 'no se fusiona con lógica antigua');
  });
});

describe('respaldo v3', () => {
  test('incluye bitácora y versiones futuras; al importar fusiona campo a campo', () => {
    const local = minimalRecord(
      'a',
      { paciente_nombre: 'Ana', od_pio: '14' },
      { updated: 10, ft: { 'f.od_pio': 10, 'f.paciente_nombre': 1 } },
    );
    const otro = minimalRecord(
      'a',
      { paciente_nombre: 'Ana', od_pio: '14', plan: 'Lentes' },
      { updated: 8, ft: { 'f.plan': 8, 'f.paciente_nombre': 1, 'f.od_pio': 2 } },
    );
    const futura = { id: 'fut', v: SCHEMA_VERSION + 1, updated: 3 };
    const doc = { id: 'b_a', atencionId: 'a', updated: 8, entries: [{ id: 'e1', at: 8, tipo: 'editada' }] };
    const text = JSON.stringify(buildBackup({ records: [otro], futureRecords: [futura], procs: PROCS, auditDocs: [doc] }));
    const incoming = parseBackup(text);
    assert.equal(incoming.records.length, 1);
    assert.deepEqual(incoming.futureRecords, [futura]);
    assert.equal(incoming.auditDocs.length, 1);

    const m = mergeBackup({ records: [local], procs: PROCS, auditDocs: [{ ...doc, entries: [{ id: 'e0', at: 5 }] }] }, incoming);
    const a = m.records.find((r) => r.id === 'a');
    assert.equal(a.f.od_pio, '14');
    assert.equal(a.f.plan, 'Lentes', 'antes una versión más antigua del respaldo se descartaba entera; ahora aporta sus campos');
    assert.equal(m.updated, 1);
    assert.deepEqual(
      m.auditDocs[0].entries.map((e) => e.id),
      ['e0', 'e1'],
    );
    assert.deepEqual(m.futureRecords, [futura]);
  });
});

describe('respaldo manipulado', () => {
  test('una atención "futura" no reemplaza a una actual sin autorización, y se rechazan versiones implausibles', () => {
    const actual = minimalRecord('a', { paciente_nombre: 'Real' }, { updated: 10 });
    const falsa = { id: 'a', v: SCHEMA_VERSION + 1, updated: 99, f: { paciente_nombre: 'Falsa' } };
    const absurda = { id: 'b', v: 999, updated: 1 };
    const incoming = parseBackup(JSON.stringify({ atenciones: [falsa, absurda], procs: [] }));
    assert.deepEqual(
      incoming.futureRecords.map((r) => r.id),
      ['a'],
      'v999 se descarta',
    );
    const m = mergeBackup({ records: [actual], procs: [] }, incoming);
    assert.deepEqual(m.futureConflicts, ['a']);
    assert.equal(m.records[0].f.paciente_nombre, 'Real', 'por defecto se mantiene la actual');
    assert.deepEqual(m.futureRecords, []);
    const forced = mergeBackup({ records: [actual], procs: [] }, incoming, { allowFutureOverride: true });
    assert.deepEqual(forced.records, []);
    assert.equal(forced.futureRecords[0].f.paciente_nombre, 'Falsa');
  });
});

test('bitácora: registra quién (perfil) además del equipo', () => {
  const r = minimalRecord('a', { paciente_nombre: 'Ana' }, { updated: 100 });
  const e = makeAuditEntry({ tipo: 'creada', after: r, at: 100, equipo: 'Box 1', equipoId: 'pc1', autor: 'Dra. Pérez', autorId: 'm_x' });
  assert.equal(e.autor, 'Dra. Pérez');
  assert.equal(e.autorId, 'm_x');
  assert.equal('autor' in makeAuditEntry({ tipo: 'creada', after: r, at: 100, equipo: 'Box 1', equipoId: 'pc1' }), false);
});

test('respaldo: la bitácora que recibe entradas nuevas sube de versión (para sincronizarse)', () => {
  const local = { id: 'b_a', atencionId: 'a', updated: 10, entries: [{ id: 'e1', at: 10 }] };
  const otro = {
    id: 'b_a',
    atencionId: 'a',
    updated: 10,
    entries: [
      { id: 'e0', at: 7 },
      { id: 'e1', at: 10 },
    ],
  };
  const m = mergeBackup({ records: [], procs: [], auditDocs: [local] }, { records: [], procs: [], auditDocs: [otro] });
  assert.deepEqual(
    m.auditDocs[0].entries.map((e) => e.id),
    ['e0', 'e1'],
  );
  assert.ok(m.auditDocs[0].updated > 10);
  const igual = mergeBackup({ records: [], procs: [], auditDocs: [otro] }, { records: [], procs: [], auditDocs: [local] });
  assert.equal(igual.auditDocs[0].updated, 10, 'sin entradas nuevas no cambia');
});

test('bitácora con guardado automático: las ediciones seguidas de la misma persona se juntan', async () => {
  const { appendAuditEntry, COALESCE_MS } = await import('../src/core/audit.js');
  const e = (id, at, cambios, extra = {}) => ({
    id,
    at,
    tipo: 'editada',
    equipo: 'Box 1',
    equipoId: 'pc1',
    autorId: 'm_a',
    cambios,
    ...extra,
  });
  let list = [{ id: 'c', at: 1, tipo: 'creada', equipo: 'Box 1', equipoId: 'pc1', cambios: [] }];
  list = appendAuditEntry(list, e('e1', 100, [{ c: 'f.od_pio', a: '14', d: '1' }]));
  list = appendAuditEntry(
    list,
    e('e2', 200, [
      { c: 'f.od_pio', a: '1', d: '18' },
      { c: 'f.plan', d: 'Control' },
    ]),
  );
  assert.equal(list.length, 2, 'la creación no se junta; las dos ediciones sí');
  assert.equal(list[1].id, 'e1');
  assert.equal(list[1].hasta, 200);
  assert.deepEqual(list[1].cambios, [
    { c: 'f.od_pio', a: '14', d: '18' },
    { c: 'f.plan', d: 'Control' },
  ]);
  // Volver al valor original: deja de ser un cambio.
  list = appendAuditEntry(list, e('e3', 300, [{ c: 'f.od_pio', a: '18', d: '14' }]));
  assert.deepEqual(list[1].cambios, [{ c: 'f.plan', d: 'Control' }]);
  // Otra persona, otro equipo o pasado el plazo: entrada nueva.
  assert.equal(appendAuditEntry(list, e('x', 310, [{ c: 'f.a', d: '1' }], { autorId: 'm_b' })).length, 3);
  assert.equal(appendAuditEntry(list, e('x', 310, [{ c: 'f.a', d: '1' }], { equipoId: 'pc2' })).length, 3);
  assert.equal(appendAuditEntry(list, e('x', 300 + COALESCE_MS + 1, [{ c: 'f.a', d: '1' }])).length, 3);
});

test('bitácora: al sincronizar una entrada que se fue juntando, gana su versión más completa', () => {
  const v1 = { id: 'e1', at: 100, tipo: 'editada', equipo: 'B', equipoId: 'pc1', cambios: [{ c: 'f.a', d: '1' }] };
  const v2 = { ...v1, hasta: 200, cambios: [{ c: 'f.a', d: '2' }] };
  for (const [a, b] of [
    [v1, v2],
    [v2, v1],
  ]) {
    const m = mergeAuditDocs(
      { id: 'b_x', atencionId: 'x', updated: 1, entries: [a] },
      { id: 'b_x', atencionId: 'x', updated: 2, entries: [b] },
    );
    assert.deepEqual(m.entries, [v2]);
  }
});
