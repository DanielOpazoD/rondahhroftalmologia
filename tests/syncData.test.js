import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { idbBackend } from '../src/storage/backends.js';
import { createRepo } from '../src/storage/repo.js';
import { createStore, memoryStorage } from '../src/storage/store.js';
import { readSpecialtyItems, writeSpecialtyItems, readPatientItems, writePatientItems, opaqueInSpecialty } from '../src/app/syncData.js';
import { makeMedico, makeOperativo } from '../src/core/catalog.js';
import { patientFromRecord } from '../src/core/patient.js';
import { minimalRecord } from './fixtures.js';

async function newStore() {
  const repo = createRepo(await idbBackend('syncdata', new IDBFactory()));
  await repo.init();
  return createStore(memoryStorage(), repo);
}

test('especialidad: lo escrito desde la sincronización se vuelve a leer igual (ida y vuelta)', async () => {
  const a = await newStore();
  const items = [
    { id: 'a1', updated: 20, kind: 'atencion', data: minimalRecord('a1', { paciente_nombre: 'Ana' }, { updated: 20 }) },
    { id: 'm_abcdefgh', updated: 5, kind: 'medico', data: makeMedico({ id: 'm_abcdefgh', nombre: 'Dra. Z', rol: 'medico' }, 5) },
    { id: 'm_bbbbbbbb', updated: 6, kind: 'medico', data: makeMedico({ id: 'm_bbbbbbbb', nombre: 'Dr. A', rol: 'tens' }, 6) },
    { id: 'o_x', updated: 7, kind: 'operativo', data: makeOperativo({ id: 'o_x', nombre: 'Op 1' }, 7) },
    { id: 'b_a1', updated: 20, kind: 'bitacora', data: { id: 'b_a1', atencionId: 'a1', updated: 20, entries: [{ id: 'e1', at: 20 }] } },
  ];
  writeSpecialtyItems(a, items, { z9: 30 });
  const back = readSpecialtyItems(a);
  assert.deepEqual(back.tombstones, { z9: 30 });
  assert.deepEqual(back.items.map((i) => [i.kind, i.id]).sort(), items.map((i) => [i.kind, i.id]).sort());
  assert.deepEqual(
    a.loadMedicos().map((m) => m.nombre),
    ['Dr. A', 'Dra. Z'],
    'perfiles ordenados por nombre',
  );
  // Las atenciones sin versión (borrador nunca guardado) no se sincronizan.
  a.upsertRecord(minimalRecord('sinver', {}, { updated: 0 }));
  assert.ok(!readSpecialtyItems(a).items.some((i) => i.id === 'sinver'));
});

test('pacientes: ida y vuelta en su espacio; perfiles con id opaco', async () => {
  const s = await newStore();
  const p = patientFromRecord(minimalRecord('r', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana' }), 10);
  writePatientItems(s, [
    { id: p.id, updated: 10, kind: 'paciente', data: p },
    { id: 'x', updated: 1, kind: 'otro', data: {} },
  ]);
  assert.deepEqual(
    readPatientItems(s).items.map((i) => i.id),
    [p.id],
  );
  assert.equal(opaqueInSpecialty('m_abcdefgh'), true);
  assert.equal(opaqueInSpecialty('a1'), false);
  assert.equal(opaqueInSpecialty('o_x'), false);
});
