import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryStorage, StorageError } from '../src/storage/store.js';
import { buildBackup, parseBackup, mergeBackup } from '../src/core/backup.js';
import { STORAGE_KEYS, DEFAULT_PROCS, DEFAULT_SETTINGS } from '../src/config/catalogs.js';
import { minimalRecord, PROCS } from './fixtures.js';

test('store: CRUD de atenciones con orden por fecha', () => {
  const store = createStore(memoryStorage());
  assert.deepEqual(store.loadRecords(), []);
  store.upsertRecord(minimalRecord('a', { fecha_atencion: '2026-01-01' }));
  store.upsertRecord(minimalRecord('b', { fecha_atencion: '2026-02-01' }));
  const updated = minimalRecord('a', { fecha_atencion: '2026-03-01', paciente_nombre: 'Editado' });
  assert.deepEqual(store.upsertRecord(updated).map((r) => r.id), ['a', 'b']);
  assert.equal(store.loadRecords()[0].f.paciente_nombre, 'Editado');
  assert.deepEqual(store.deleteRecord('a').map((r) => r.id), ['b']);
});

test('store: lee datos de la v1 con las mismas claves', () => {
  const mem = memoryStorage();
  mem.setItem(STORAGE_KEYS.records, JSON.stringify([{ id: 'old1', f: { paciente_nombre: 'Antiguo', fecha_atencion: '2025-05-01' }, checks: {}, proc: { fo: { eye: 'OD' } } }, { sinId: true }]));
  const recs = createStore(mem).loadRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].v, 2);
  assert.equal(recs[0].f.paciente_nombre, 'Antiguo');
});

test('store: valores por defecto, ajustes y clave', () => {
  const store = createStore(memoryStorage());
  assert.deepEqual(store.loadProcs(), DEFAULT_PROCS);
  assert.deepEqual(store.loadSettings(), DEFAULT_SETTINGS);
  store.saveSettings({ pdfFlatten: false });
  assert.equal(store.loadSettings().pdfFlatten, false);
  assert.equal(store.loadSettings().pdfFooter, true, 'mezcla con valores por defecto');
  assert.equal(store.loadSecret(), null);
  store.saveSecret('f'.repeat(64));
  assert.equal(store.loadSecret(), 'f'.repeat(64));
});

test('store: JSON corrupto no rompe y almacenamiento lleno lanza StorageError', () => {
  const mem = memoryStorage();
  mem.setItem(STORAGE_KEYS.records, '{no es json');
  assert.deepEqual(createStore(mem).loadRecords(), []);
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  assert.throws(() => createStore(full).saveRecords([]), StorageError);
});

test('backup: ida y vuelta, compatibilidad v1 y unión sin duplicar', () => {
  const local = { records: [minimalRecord('a', {}, { updated: 10 }), minimalRecord('b', {}, { updated: 10 })], procs: PROCS };
  const text = JSON.stringify(buildBackup({ ...local, anonSecret: 'c'.repeat(64) }));
  const parsed = parseBackup(text);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.anonSecret, 'c'.repeat(64));

  const v1 = JSON.stringify({ app: 'oftalmo-operativos', v: 1, procs: [{ id: 'nuevo', n: 'Proc nuevo' }], atenciones: [
    { id: 'a', f: { paciente_nombre: 'más nuevo' }, updated: 20 },
    { id: 'b', f: {}, updated: 5 },
    { id: 'c', f: {}, updated: 1 },
  ] });
  const m = mergeBackup(local, parseBackup(v1));
  assert.deepEqual([m.added, m.updated, m.unchanged], [1, 1, 1]);
  assert.equal(m.records.find((r) => r.id === 'a').f.paciente_nombre, 'más nuevo');
  assert.ok(m.procs.some((p) => p.id === 'nuevo'));

  assert.throws(() => parseBackup('nada'), /JSON/);
  assert.throws(() => parseBackup('{"x":1}'), /respaldo/);
  assert.throws(() => parseBackup('{"app":"otra","atenciones":[]}'), /otra aplicación/);
});
