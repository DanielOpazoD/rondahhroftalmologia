/**
 * Convergencia de la sincronización con varios equipos que sincronizan A LA VEZ.
 * Simula N "PC" contra el mismo servidor (en memoria) con órdenes aleatorios
 * reproducibles (semilla fija) y verifica que, tras quedar en reposo, todos
 * tienen exactamente los mismos datos y ninguna edición se pierde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTeamKeys, tokenHash, importEncKey } from '../src/sync/crypto.js';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import { createSyncApi, syncOnce } from '../src/sync/client.js';
import { syncMerge, stampChanges, flatten } from '../src/core/merge.js';
import { syncFingerprint } from '../src/core/merge.js';

/** Generador pseudoaleatorio reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

async function world(seed = 1) {
  const timing = rng(seed * 7919);
  const keys = await deriveTeamKeys('K7QM3-XRT9P-ZAWD4-N8F2C', 1000);
  const store = memoryBlobStore();
  const handler = createSyncHandler({ store, tokenHash: tokenHash(keys.token) });
  // Respuesta con un retardo aleatorio pequeño: permite que las sincronizaciones se entrelacen.
  const delay = () => new Promise((r) => setTimeout(r, Math.floor(timing() * 3)));
  const fetchFn = async (url, init) => {
    await delay();
    const res = await handler(new Request('https://x' + url, init));
    await delay();
    return res;
  };
  const key = await importEncKey(keys.encKey);
  const pc = (name) => {
    const st = { recs: [], tomb: {} };
    return {
      name,
      st,
      sync: () =>
        syncOnce({
          api: createSyncApi({ token: keys.token, fetchFn }),
          key,
          encKey: keys.encKey,
          mergeFn: syncMerge,
          fingerprint: syncFingerprint,
          readLocal: () => ({
            items: st.recs.map((r) => ({ id: r.id, updated: r.updated, kind: 'atencion', data: structuredClone(r) })),
            tombstones: { ...st.tomb },
          }),
          writeLocal: (items, t) => {
            st.recs = items.map((i) => ({ ...i.data, id: i.id, updated: i.updated }));
            st.tomb = t;
          },
        }),
    };
  };
  return { pc };
}

/** Edición local con sello de campo y versión nueva. */
function edit(p, id, t, field, value) {
  const i = p.st.recs.findIndex((r) => r.id === id);
  const before = structuredClone(p.st.recs[i]);
  const next = structuredClone(before);
  next.f[field] = value;
  next.updated = Math.max(t, (before.updated || 0) + 1);
  p.st.recs[i] = stampChanges(next, before, t);
}

const snapshot = (p) => JSON.stringify(p.st.recs.map((r) => [r.id, [...flatten(r)].sort()]).sort());

test('3 PC sincronizando a la vez no pierden ediciones (caso reproducido)', async () => {
  const { pc } = await world();
  const [A, B, C] = [pc('A'), pc('B'), pc('C')];
  const t0 = Date.now();
  A.st.recs.push({ id: 'p1', updated: t0, created: t0, ft: {}, f: { paciente_nombre: 'X' }, checks: {}, proc: {} });
  await A.sync();
  await B.sync();
  await C.sync();
  edit(A, 'p1', t0 + 10, 'od_pio', 'x-A');
  edit(B, 'p1', t0 + 20, 'od_av', 'y-B');
  edit(C, 'p1', t0 + 30, 'plan', 'z-C');
  await C.sync();
  await Promise.all([A.sync(), B.sync()]);
  for (let i = 0; i < 3; i++) await Promise.all([A.sync(), B.sync(), C.sync()]);
  for (const p of [A, B, C]) {
    const f = p.st.recs[0].f;
    assert.deepEqual([f.od_pio, f.od_av, f.plan], ['x-A', 'y-B', 'z-C'], `PC ${p.name}`);
  }
  assert.equal(snapshot(A), snapshot(B));
  assert.equal(snapshot(B), snapshot(C));
});

// SEMILLAS=200 npm test  -> prueba de estrés con más escenarios.
const SEEDS =
  Number(process.env.SEMILLAS || 0) > 0
    ? Array.from({ length: Number(process.env.SEMILLAS) }, (_, i) => i + 1)
    : [1, 2, 3, 7, 42, 99, 123, 2026];
for (const seed of SEEDS) {
  test(`convergencia aleatoria: 4 PC, 3 pacientes, sincronizaciones concurrentes (semilla ${seed})`, async () => {
    const rand = rng(seed);
    const { pc } = await world(seed);
    const pcs = ['A', 'B', 'C', 'D'].map(pc);
    const t0 = Date.now();
    for (const id of ['p1', 'p2', 'p3']) {
      pcs[0].st.recs.push({ id, updated: t0, created: t0, ft: {}, f: { paciente_nombre: id }, checks: {}, proc: {} });
    }
    await pcs[0].sync();
    await Promise.all(pcs.map((p) => p.sync()));

    // Cada PC edita SUS campos (no hay conflictos de campo): todo debe conservarse.
    const expected = {};
    let t = t0;
    for (let round = 0; round < 15; round++) {
      // Varios PC editan entre sincronizaciones (ediciones concurrentes reales).
      for (const p of pcs.filter(() => rand() < 0.5)) {
        const id = ['p1', 'p2', 'p3'][Math.floor(rand() * 3)];
        const field = `campo_${p.name}_${Math.floor(rand() * 3)}`;
        const value = `${p.name}-${round}`;
        edit(p, id, (t += 1 + Math.floor(rand() * 5)), field, value);
        expected[`${id}.${field}`] = value; // la última escritura de ese PC en ese campo
      }
      // Un subconjunto aleatorio sincroniza a la vez.
      const group = pcs.filter(() => rand() < 0.6);
      if (group.length) await Promise.all(group.map((q) => q.sync()));
    }
    // Reposo: todos sincronizan hasta estabilizarse.
    for (let i = 0; i < 4; i++) await Promise.all(pcs.map((p) => p.sync()));
    for (let i = 0; i < 2; i++) for (const p of pcs) await p.sync();

    for (const p of pcs) {
      assert.equal(snapshot(p), snapshot(pcs[0]), `PC ${p.name} distinto de A`);
      for (const [path, value] of Object.entries(expected)) {
        const [id, field] = path.split('.');
        assert.equal(p.st.recs.find((r) => r.id === id).f[field], value, `PC ${p.name} perdió ${path}`);
      }
    }
  });
}

for (const seed of [5, 11, 31, 77]) {
  test(`conflictos en los mismos campos: todos acuerdan la edición más reciente (semilla ${seed})`, async () => {
    const rand = rng(seed);
    const { pc } = await world(seed);
    const pcs = ['A', 'B', 'C', 'D'].map(pc);
    const t0 = Date.now();
    pcs[0].st.recs.push({ id: 'p1', updated: t0, created: t0, ft: {}, f: { paciente_nombre: 'p1' }, checks: {}, proc: {} });
    await pcs[0].sync();
    await Promise.all(pcs.map((p) => p.sync()));
    const latest = {};
    let t = t0;
    for (let round = 0; round < 12; round++) {
      for (const p of pcs.filter(() => rand() < 0.5)) {
        const field = ['od_pio', 'oi_pio', 'plan'][Math.floor(rand() * 3)];
        const value = `${p.name}-${round}`;
        edit(p, 'p1', (t += 1 + Math.floor(rand() * 3)), field, value);
        latest[field] = value; // t crece: esta es la edición más reciente de ese campo
      }
      const group = pcs.filter(() => rand() < 0.6);
      if (group.length) await Promise.all(group.map((q) => q.sync()));
    }
    for (let i = 0; i < 4; i++) await Promise.all(pcs.map((p) => p.sync()));
    for (let i = 0; i < 2; i++) for (const p of pcs) await p.sync();
    for (const p of pcs) {
      assert.equal(snapshot(p), snapshot(pcs[0]), `PC ${p.name} distinto de A`);
      for (const [field, value] of Object.entries(latest)) assert.equal(p.st.recs[0].f[field], value, `PC ${p.name}: ${field}`);
    }
  });
}
