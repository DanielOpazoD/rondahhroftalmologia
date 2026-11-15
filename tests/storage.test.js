import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryStorage, StorageError } from '../src/storage/store.js';
import { buildBackup, parseBackup, mergeBackup } from '../src/core/backup.js';
import { DEFAULT_SETTINGS } from '../src/config/catalogs.js';
import { DEFAULT_PROCS } from '../src/specialties/oftalmologia/config.js';
import { minimalRecord, PROCS } from './fixtures.js';

test('store: valores por defecto, ajustes y clave', () => {
  const store = createStore(memoryStorage(), null);
  assert.deepEqual(store.loadProcs(), DEFAULT_PROCS);
  assert.deepEqual(store.loadSettings(), DEFAULT_SETTINGS);
  store.saveSettings({ pdfFlatten: false });
  assert.equal(store.loadSettings().pdfFlatten, false);
  assert.equal(store.loadSettings().pdfFooter, true, 'mezcla con valores por defecto');
  assert.equal(store.loadSecret(), null);
  store.saveSecret('f'.repeat(64));
  assert.equal(store.loadSecret(), 'f'.repeat(64));
});

test('backup: ida y vuelta, compatibilidad v1 y unión sin duplicar', () => {
  const local = { records: [minimalRecord('a', {}, { updated: 10 }), minimalRecord('b', {}, { updated: 10 })], procs: PROCS };
  const text = JSON.stringify(buildBackup({ ...local, anonSecret: 'c'.repeat(64) }));
  const parsed = parseBackup(text);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.anonSecret, 'c'.repeat(64));

  const v1 = JSON.stringify({
    app: 'oftalmo-operativos',
    v: 1,
    procs: [{ id: 'nuevo', n: 'Proc nuevo' }],
    atenciones: [
      { id: 'a', f: { paciente_nombre: 'más nuevo' }, updated: 20 },
      { id: 'b', f: {}, updated: 5 },
      { id: 'c', f: {}, updated: 1 },
    ],
  });
  const m = mergeBackup(local, parseBackup(v1));
  assert.deepEqual([m.added, m.updated, m.unchanged], [1, 1, 1]);
  assert.equal(m.records.find((r) => r.id === 'a').f.paciente_nombre, 'más nuevo');
  assert.ok(m.procs.some((p) => p.id === 'nuevo'));

  // Respaldo manipulado: ids con HTML se descartan; procedimientos se sanean.
  const evil = parseBackup(
    JSON.stringify({
      atenciones: [
        { id: 'x" onmouseover="alert(1)', f: {} },
        { id: 'ok_1', f: {} },
      ],
      procs: [
        { id: '"><img>', n: 'Malo' },
        { id: 'p1', n: ' Bueno ', pio: 'sí', extra: '<b>' },
      ],
    }),
  );
  assert.deepEqual(
    evil.records.map((r) => r.id),
    ['ok_1'],
  );
  assert.deepEqual(evil.procs, [{ id: 'p1', n: 'Bueno', pio: 1 }]);

  assert.throws(() => parseBackup('nada'), /JSON/);
  assert.throws(() => parseBackup('{"x":1}'), /respaldo/);
  assert.throws(() => parseBackup('{"app":"otra","atenciones":[]}'), /otra aplicación/);
});

test('store: almacenamiento lleno lanza StorageError (ajustes)', () => {
  const full = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem() {},
  };
  assert.throws(() => createStore(full, null).saveSettings({}), StorageError);
});
