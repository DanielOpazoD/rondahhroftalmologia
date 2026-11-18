/**
 * Respaldo de ida y vuelta: lo que los PC escribieron (cifrado) se respalda,
 * el almacén de sincronización se pierde, se restaura el respaldo del día y un
 * PC nuevo recupera exactamente lo mismo, sin revivir lo borrado. Además, un PC
 * que ya tenía los datos sigue sincronizando con el almacén restaurado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTeamKeys, tokenHash, importEncKey } from '../src/sync/crypto.js';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import { createSyncApi, syncOnce, createSyncCache } from '../src/sync/client.js';
import { syncMerge, stampChanges, syncFingerprint } from '../src/core/merge.js';
import { flatten } from '../src/core/fields.js';
import { dailyBackup, restoreBackup, listBackups } from '../src/sync/backup.js';

const keys = await deriveTeamKeys('K7QM3-XRT9P-ZAWD4-N8F2C', 1000);
const key = await importEncKey(keys.encKey);

/** Un servidor de sincronización sobre `store`, con su reloj. @param {ReturnType<typeof memoryBlobStore>} store */
function server(store) {
  let now = Date.now();
  const handler = createSyncHandler({ store, tokenHash: tokenHash(keys.token), now: () => (now += 1000) });
  return { fetchFn: async (/** @type {string} */ url, /** @type {RequestInit} */ init) => handler(new Request('https://x' + url, init)) };
}

/** Un PC con sus datos locales; sincroniza con el servidor que se le dé. @param {boolean} incremental */
function pc(incremental) {
  const st = { recs: /** @type {any[]} */ ([]), tomb: /** @type {Record<string, number>} */ ({}) };
  const cache = incremental ? createSyncCache() : undefined;
  return {
    st,
    /** @param {{fetchFn: typeof fetch}} srv */
    sync: (srv) =>
      syncOnce({
        api: createSyncApi({ token: keys.token, fetchFn: srv.fetchFn }),
        key,
        encKey: keys.encKey,
        mergeFn: syncMerge,
        fingerprint: syncFingerprint,
        cache,
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
}

/** Datos de un PC, comparables. @param {{st: {recs: any[]}}} p */
const snapshot = (p) => JSON.stringify(p.st.recs.map((r) => [r.id, [...flatten(r)].sort()]).sort());

test('respaldo de ida y vuelta: tras perder el servidor y restaurar, un PC nuevo recupera lo mismo y lo borrado sigue borrado', async () => {
  const t0 = Date.now() - 3600_000;
  const original = memoryBlobStore();
  const before = server(original);
  const A = pc(true);
  for (const [i, nombre] of ['Tuki Ana', 'Hotus Pedro', 'Rapu Rosa'].entries()) {
    A.st.recs.push({ id: 'r' + i, updated: t0 + i, created: t0 + i, ft: {}, f: { paciente_nombre: nombre }, checks: {}, proc: {} });
  }
  await A.sync(before);
  // Una edición y un borrado, ya sincronizados antes del respaldo.
  const prev = structuredClone(A.st.recs[0]);
  const edited = structuredClone(prev);
  edited.f.od_av = '20/40';
  edited.updated = t0 + 100;
  A.st.recs[0] = stampChanges(edited, prev, t0 + 100);
  A.st.recs = A.st.recs.filter((r) => r.id !== 'r2');
  A.st.tomb = { r2: t0 + 200 };
  await A.sync(before);

  // Respaldo diario y desastre: el almacén de sincronización se pierde entero.
  const backups = memoryBlobStore();
  await dailyBackup({ source: original, target: backups, now: Date.now() });
  const [day] = await listBackups(backups);
  const restored = memoryBlobStore();
  const r = await restoreBackup({ source: backups, target: restored, day });
  assert.ok(r.escritas > 0);
  const after = server(restored);

  // Un PC nuevo, sin nada local, recupera exactamente lo que tenía A.
  const N = pc(false);
  await N.sync(after);
  assert.equal(snapshot(N), snapshot(A));
  assert.equal(N.st.recs.find((x) => x.id === 'r0')?.f.od_av, '20/40', 'la edición volvió');
  assert.ok(!N.st.recs.some((x) => x.id === 'r2'), 'lo borrado no revive');

  // A (que ya tenía los datos y sincroniza en modo incremental) sigue con el almacén restaurado.
  const prevA = structuredClone(A.st.recs.find((x) => x.id === 'r1'));
  const nextA = structuredClone(prevA);
  nextA.f.plan = 'Control en 3 meses';
  nextA.updated = Date.now();
  A.st.recs = A.st.recs.map((x) => (x.id === 'r1' ? stampChanges(nextA, prevA, nextA.updated) : x));
  await A.sync(after);
  await N.sync(after);
  assert.equal(N.st.recs.find((x) => x.id === 'r1')?.f.plan, 'Control en 3 meses');
  assert.equal(snapshot(N), snapshot(A));
});
