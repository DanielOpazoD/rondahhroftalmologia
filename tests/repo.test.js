import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { idbBackend, localStorageBackend } from '../src/storage/backends.js';
import { createRepo } from '../src/storage/repo.js';
import { memoryStorage, readLegacyData, clearLegacyData } from '../src/storage/store.js';
import { STORAGE_KEYS as K, SCHEMA_VERSION } from '../src/config/catalogs.js';
import { minimalRecord } from './fixtures.js';
import { patientFromRecord } from '../src/core/patient.js';

const LS_KEYS = { atenciones: K.records, eliminadas: K.tombstones, bitacora: K.audit, pacientes: K.patients };

/** Motor que cuenta escrituras (para verificar que solo se escribe lo que cambia). */
function counting(backend) {
  const calls = { put: 0, delete: 0 }; // put = documentos escritos (sueltos o en lote)
  return {
    calls,
    backend: {
      ...backend,
      put: (c, d) => (calls.put++, backend.put(c, d)),
      putMany: (c, docs) => ((calls.put += docs.length), backend.putMany(c, docs)),
      delete: (c, id) => (calls.delete++, backend.delete(c, id)),
    },
  };
}

for (const kind of ['indexeddb', 'localstorage']) {
  const make = async (env) => (kind === 'indexeddb' ? idbBackend('prueba', env.idb) : localStorageBackend(env.storage, LS_KEYS));
  const env = () => ({ idb: new IDBFactory(), storage: memoryStorage() });

  test(`[${kind}] guarda, ordena y persiste entre aperturas`, async () => {
    const e = env();
    const repo = createRepo(await make(e));
    await repo.init();
    repo.upsertRecord(minimalRecord('a', { fecha_atencion: '2026-01-01' }));
    repo.upsertRecord(minimalRecord('b', { fecha_atencion: '2026-02-01' }));
    repo.upsertRecord(minimalRecord('a', { fecha_atencion: '2026-03-01', paciente_nombre: 'Editado' }));
    repo.addTombstone('z', 99);
    repo.deleteRecord('b');
    await repo.flush();

    const again = createRepo(await make(e));
    await again.init();
    assert.deepEqual(
      again.loadRecords().map((r) => [r.id, r.f.paciente_nombre]),
      [['a', 'Editado']],
    );
    assert.deepEqual(again.loadTombstones(), { z: 99 });
  });

  test(`[${kind}] bitácora: agrega, ordena y persiste`, async () => {
    const e = env();
    const repo = createRepo(await make(e));
    await repo.init();
    repo.addAuditEntry('a', { id: 'e1', at: 10, tipo: 'creada', equipo: 'Box 1', cambios: [] });
    repo.addAuditEntry('a', { id: 'e2', at: 20, tipo: 'editada', equipo: 'Box 2', cambios: [{ c: 'f.od_pio', d: '18' }] });
    await repo.flush();
    const again = createRepo(await make(e));
    await again.init();
    assert.deepEqual(
      again.auditFor('a').map((x) => x.id),
      ['e2', 'e1'],
    );
    assert.equal(again.loadAuditDocs()[0].id, 'b_a');
  });

  test(`[${kind}] pacientes: fichas propias, separadas de las atenciones, persisten`, async () => {
    const e = env();
    const repo = createRepo(await make(e));
    await repo.init();
    const ana = patientFromRecord(minimalRecord('a', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana' }), 10);
    const luis = patientFromRecord(minimalRecord('b', { paciente_nombre: 'Luis' }), 20);
    repo.upsertPatient(ana);
    repo.upsertPatient(luis);
    repo.upsertPatient({ ...ana, f: { ...ana.f, paciente_fono: '555' }, updated: 30 });
    assert.equal(repo.upsertPatient({ id: 'no-valido', f: {} }), null, 'rechaza ids que no son de paciente');
    await repo.flush();
    const again = createRepo(await make(e));
    await again.init();
    assert.deepEqual(again.loadRecords(), [], 'las fichas no son atenciones');
    assert.equal(again.loadPatients().length, 2);
    assert.equal(again.getPatient(ana.id).f.paciente_fono, '555');
    // savePatients (sincronización) agrega o reemplaza, nunca borra fichas.
    again.savePatients([{ ...again.getPatient(ana.id), f: { ...again.getPatient(ana.id).f, paciente_fono: '777' }, updated: 40 }]);
    await again.flush();
    const third = createRepo(await make(e));
    await third.init();
    assert.deepEqual(
      third.loadPatients().map((p) => p.f.paciente_nombre),
      ['Ana', 'Luis'],
    );
    assert.equal(third.getPatient(ana.id).f.paciente_fono, '777');
  });
}

test('[indexeddb] saveRecords escribe solo lo que cambió y borra lo que falta', async () => {
  const idb = new IDBFactory();
  const { backend, calls } = counting(await idbBackend('prueba', idb));
  const repo = createRepo(backend);
  await repo.init();
  const recs = Array.from({ length: 50 }, (_, i) => minimalRecord('r' + i, { paciente_nombre: 'P' + i }, { updated: 1 }));
  repo.saveRecords(recs);
  await repo.flush();
  assert.equal(calls.put, 50);
  const changed = recs.map((r) => (r.id === 'r7' ? { ...r, f: { ...r.f, plan: 'nuevo' }, updated: 2 } : r));
  repo.saveRecords(changed.filter((r) => r.id !== 'r9'));
  await repo.flush();
  assert.equal(calls.put, 51, 'solo se reescribe la atención modificada');
  assert.equal(calls.delete, 1, 'y se elimina la que ya no está');
  assert.equal(repo.loadRecords().length, 49);
});

test('migra los datos de localStorage de versiones anteriores a IndexedDB (una sola vez)', async () => {
  const storage = memoryStorage();
  storage.setItem(K.records, JSON.stringify([{ id: 'old1', f: { paciente_nombre: 'Antiguo' } }, { sinId: true }]));
  storage.setItem(K.tombstones, JSON.stringify({ old2: 5 }));
  const idb = new IDBFactory();
  const repo = createRepo(await idbBackend('prueba', idb));
  const r = await repo.init({ legacy: readLegacyData(storage), clearLegacy: () => clearLegacyData(storage) });
  assert.equal(r.migrated, 1);
  assert.equal(repo.loadRecords()[0].f.paciente_nombre, 'Antiguo');
  assert.equal(repo.loadRecords()[0].v, SCHEMA_VERSION);
  assert.deepEqual(repo.loadTombstones(), { old2: 5 });
  assert.equal(storage.getItem(K.records), null, 'libera el espacio antiguo');

  const second = createRepo(await idbBackend('prueba', idb));
  assert.equal((await second.init({ legacy: readLegacyData(storage) })).migrated, 0);
  assert.equal(second.loadRecords().length, 1);
});

test('atenciones de una versión FUTURA se conservan intactas y no se muestran', async () => {
  const repo = createRepo(await idbBackend('prueba', new IDBFactory()));
  await repo.init();
  const futura = { id: 'fut1', v: SCHEMA_VERSION + 1, updated: 50, campoNuevo: { x: 1 }, f: { paciente_nombre: 'Del futuro' } };
  repo.saveRecords([minimalRecord('a', { paciente_nombre: 'Actual' }), futura]);
  assert.deepEqual(
    repo.loadRecords().map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(repo.loadFutureRecords(), [futura], 'sin degradar ni perder campos');
  // Una nueva sincronización que la incluye no la altera ni la borra.
  repo.saveRecords([...repo.loadRecords(), ...repo.loadFutureRecords()]);
  assert.deepEqual(repo.loadFutureRecords()[0], futura);
});

test('un error de escritura se informa (no se pierde en silencio)', async () => {
  const errors = [];
  const broken = { ...localStorageBackend(memoryStorage(), LS_KEYS), put: () => Promise.reject(new Error('disco lleno')) };
  const repo = createRepo(broken, { onError: (e) => errors.push(e.message) });
  await repo.init();
  repo.upsertRecord(minimalRecord('a', { paciente_nombre: 'X' }));
  await repo.flush();
  assert.deepEqual(errors, ['disco lleno']);
});

test('motor localStorage: JSON corrupto se lee como vacío', async () => {
  const storage = memoryStorage();
  storage.setItem(K.records, '{roto');
  const repo = createRepo(localStorageBackend(storage, LS_KEYS));
  await repo.init();
  assert.deepEqual(repo.loadRecords(), []);
});

test('una escritura que falla no se da por guardada: se reintenta y no se pierde', async () => {
  const base = await idbBackend('fallas', new IDBFactory());
  let failNext = 0;
  let puts = 0;
  const flaky = {
    ...base,
    put: (c, d) => (puts++, failNext-- > 0 ? Promise.reject(Object.assign(new Error('disco'), { name: 'UnknownError' })) : base.put(c, d)),
    putMany: (c, docs) => (failNext-- > 0 ? Promise.reject(new Error('disco')) : base.putMany(c, docs)),
  };
  const errors = [];
  const repo = createRepo(flaky, { onError: (e) => errors.push(e), retries: 2, sleep: async () => {} });
  await repo.init();

  // Falla 2 veces y a la tercera funciona: reintento inmediato.
  failNext = 2;
  repo.upsertRecord(minimalRecord('a', { paciente_nombre: 'Ana' }));
  await repo.flush();
  assert.equal(errors.length, 0);
  assert.equal(repo.failedCount(), 0);

  // Falla más que los reintentos: se informa y queda PENDIENTE (no marcada como guardada).
  failNext = 10;
  repo.upsertRecord(minimalRecord('b', { paciente_nombre: 'Beto' }));
  await repo.flush();
  assert.equal(errors.length, 1);
  assert.equal(repo.failedCount(), 1);
  // Regresión: guardar el mismo contenido otra vez SÍ vuelve a intentar escribirlo.
  failNext = 0;
  const before = puts;
  repo.upsertRecord(minimalRecord('b', { paciente_nombre: 'Beto' }));
  assert.equal(puts, before + 1, 'se escribe en el acto (no quedó marcada como guardada)');
  await repo.flush();
  assert.equal(repo.failedCount(), 0);
  const again = createRepo(base);
  await again.init();
  assert.deepEqual(
    again
      .loadRecords()
      .map((r) => r.id)
      .sort(),
    ['a', 'b'],
    'ambas quedaron en disco',
  );
});

test('las escrituras pendientes se reintentan solas (flush / retryFailed)', async () => {
  const base = await idbBackend('fallas2', new IDBFactory());
  let down = true;
  const flaky = {
    ...base,
    put: (c, d) => (down ? Promise.reject(new Error('no')) : base.put(c, d)),
    putMany: (c, docs) => (down ? Promise.reject(new Error('no')) : base.putMany(c, docs)),
  };
  const repo = createRepo(flaky, { onError: () => {}, retries: 0, sleep: async () => {} });
  await repo.init();
  repo.upsertRecord(minimalRecord('c', { paciente_nombre: 'Cata' }));
  await repo.flush();
  assert.equal(repo.failedCount(), 1);
  down = false;
  await repo.flush(); // reintenta lo pendiente
  assert.equal(repo.failedCount(), 0);
  const again = createRepo(base);
  await again.init();
  assert.deepEqual(
    again.loadRecords().map((r) => r.id),
    ['c'],
  );
});
