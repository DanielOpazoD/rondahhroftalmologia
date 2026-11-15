import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePassphrase, normalizePassphrase, passphraseProblem, deriveTeamKeys, tokenHash, importEncKey, encryptPayload, decryptPayload, DecryptError,
} from '../src/sync/crypto.js';
import { localVersions, remoteVersions, planSync, applyPulled } from '../src/sync/protocol.js';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import { createSyncApi, syncOnce, SyncHttpError } from '../src/sync/client.js';
import { fullRecord, minimalRecord } from './fixtures.js';
import { syncMerge, stampChanges } from '../src/core/merge.js';

const PASS = 'K7QM3-XRT9P-ZAWD4-N8F2C';

describe('crypto', () => {
  test('contraseña generada y normalización', () => {
    const p = generatePassphrase();
    assert.match(p, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    assert.notEqual(generatePassphrase(), p);
    assert.equal(normalizePassphrase(' k7qm3 xrt9p-zawd4 n8f2c '), PASS);
    assert.equal(normalizePassphrase('  mi frase secreta larga  '), 'mi frase secreta larga');
    assert.ok(passphraseProblem('corta'));
    assert.ok(passphraseProblem('una frase elegida a mano bastante larga'), 'solo contraseñas generadas');
    assert.equal(passphraseProblem(PASS), null);
    assert.equal(passphraseProblem(' k7qm3 xrt9p zawd4 n8f2c '), null);
  });

  test('derivación determinista: misma contraseña => misma clave y token', async () => {
    const a = await deriveTeamKeys(PASS);
    const b = await deriveTeamKeys(PASS.toLowerCase());
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, await deriveTeamKeys('K7QM3-XRT9P-ZAWD4-N8F2D'));
    assert.match(tokenHash(a.token), /^[0-9a-f]{64}$/);
    assert.notEqual(a.encKey, a.token);
  });

  test('cifra/descifra; clave incorrecta o id/versión cambiados fallan', async () => {
    const key = await importEncKey((await deriveTeamKeys(PASS, 1000)).encKey);
    const other = await importEncKey((await deriveTeamKeys('otra contraseña muy larga', 1000)).encKey);
    const rec = fullRecord();
    const enc = await encryptPayload(key, rec.id, 5, { record: rec });
    assert.ok(!enc.ct.includes('Tepano'));
    assert.deepEqual((await decryptPayload(key, rec.id, 5, enc)).record.f.paciente_nombre, rec.f.paciente_nombre);
    await assert.rejects(decryptPayload(other, rec.id, 5, enc), DecryptError);
    await assert.rejects(decryptPayload(key, 'otroId', 5, enc), DecryptError, 'no se puede mover a otro id');
    await assert.rejects(decryptPayload(key, rec.id, 6, enc), DecryptError, 'no se puede cambiar la versión');
  });
});

describe('protocolo', () => {
  test('planSync y applyPulled con last-write-wins y lápidas', () => {
    const it = (id, updated, data = {}) => ({ id, updated, kind: 'atencion', data });
    const local = localVersions([it('a', 10), it('b', 10)], { c: 30 });
    const remote = remoteVersions([{ id: 'a', u: 5 }, { id: 'b', u: 20 }, { id: 'c', u: 40 }, { id: 'd', u: 1 }, { id: 'd', u: 2 }]);
    const plan = planSync(local, remote);
    assert.deepEqual(plan.push, ['a']);
    assert.deepEqual(plan.pull, [{ id: 'b', u: 20 }, { id: 'c', u: 40 }, { id: 'd', u: 2 }]);

    const r = applyPulled([it('a', 10), it('b', 10)], {}, [
      { id: 'b', u: 20, deleted: true },
      { id: 'a', u: 5, kind: 'atencion', data: { f: { paciente_nombre: 'viejo' } } }, // más antiguo: se ignora
      { id: 'n', u: 7, kind: 'medico', data: { nombre: 'Dra. Nueva' } },
      { id: 'bad id!', u: 7, data: {} },
      { id: 'sin', u: 9 }, // sin datos: se ignora
    ]);
    assert.deepEqual(r.items.map((x) => x.id).sort(), ['a', 'n']);
    assert.deepEqual(r.tombstones, { b: 20 });
    assert.deepEqual([r.added, r.updated, r.deleted], [1, 0, 1]);
    assert.deepEqual(r.items.find((x) => x.id === 'n'), { id: 'n', updated: 7, kind: 'medico', data: { nombre: 'Dra. Nueva', id: 'n', updated: 7 } });
  });
});

/* ---------------------------------------------------- servidor + clientes */

async function setup() {
  const keys = await deriveTeamKeys(PASS, 1000);
  const store = memoryBlobStore();
  let clock = Date.now();
  const handler = createSyncHandler({ store, tokenHash: tokenHash(keys.token), now: () => clock });
  const fetchFn = (url, init) => handler(new Request('https://x.test' + url, init));
  const toItems = (records) => records.map((r) => ({ id: r.id, updated: r.updated, kind: 'atencion', data: r }));
  const key = await importEncKey(keys.encKey);
  /** Un "PC": estado local en memoria. */
  const pc = () => {
    const state = { records: [], tombstones: {} };
    return {
      state,
      sync: () =>
        syncOnce({
          api: createSyncApi({ token: keys.token, fetchFn, esp: 'oftalmologia' }),
          key,
          readLocal: () => ({ items: toItems(structuredClone(state.records)), tombstones: { ...state.tombstones } }),
          mergeFn: syncMerge,
          writeLocal: (items, tombstones) => Object.assign(state, { records: items.map((i) => ({ ...i.data, id: i.id, updated: i.updated })), tombstones }),
          batchSize: 2,
        }),
    };
  };
  return { keys, store, handler, fetchFn, pc, tick: (ms = 1000) => (clock += ms) };
}

describe('servidor', () => {
  test('rechaza sin configuración, sin token o con token incorrecto', async () => {
    const { keys, fetchFn } = await setup();
    const noConfig = createSyncHandler({ store: memoryBlobStore(), tokenHash: '' });
    assert.equal((await noConfig(new Request('https://x/api/sync/list'))).status, 503);
    await assert.rejects(createSyncApi({ token: 'malo', fetchFn }).list(), (e) => e instanceof SyncHttpError && e.status === 401);
    assert.deepEqual(await createSyncApi({ token: keys.token, fetchFn }).list(), { items: [] });
  });

  test('valida entradas', async () => {
    const { keys, fetchFn } = await setup();
    const post = (path, body) => fetchFn('/api/sync/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + keys.token }, body });
    assert.equal((await post('put', '{no json')).status, 400);
    assert.equal((await post('put', JSON.stringify({ items: [{ id: '../x', u: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AA==' }] }))).status, 400);
    assert.equal((await post('put', JSON.stringify({ items: [{ id: 'a', u: 1, iv: 'corto', ct: 'AA==' }] }))).status, 400);
    assert.equal((await post('put', JSON.stringify({ items: Array(201).fill({ id: 'a', u: 1 }) }))).status, 400);
    assert.equal((await post('borrar', JSON.stringify({ items: [] }))).status, 404);
  });

  test('guarda solo versión vigente y no acepta versiones viejas', async () => {
    const { keys, fetchFn, store } = await setup();
    const api = createSyncApi({ token: keys.token, fetchFn });
    const iv = 'AAAAAAAAAAAAAAAA';
    assert.deepEqual(await api.put([{ id: 'a', u: 10, iv, ct: 'AQ==' }]), { saved: ['a'], skipped: [] });
    assert.deepEqual(await api.put([{ id: 'a', u: 20, iv, ct: 'Ag==' }]), { saved: ['a'], skipped: [] });
    assert.deepEqual(await api.put([{ id: 'a', u: 15, iv, ct: 'Aw==' }]), { saved: [], skipped: ['a'] });
    assert.deepEqual([...store._map.keys()], ['oftalmologia/r/a/20']);
    assert.deepEqual((await api.get([{ id: 'a', u: 10 }])).items, [{ id: 'a', u: 10, missing: true }]);
  });
});

describe('convergencia de varios PC', () => {
  test('4 PC crean, editan y eliminan; todos terminan iguales y el servidor no ve datos', async () => {
    const { pc, store, tick } = await setup();
    const pcs = [pc(), pc(), pc(), pc()];
    const t0 = Date.now();

    // Cada PC registra sus pacientes.
    pcs.forEach((p, i) => {
      for (let j = 0; j < 3; j++) p.state.records.push(minimalRecord(`pc${i}_${j}`, { paciente_nombre: `Paciente Secreto ${i}${j}`, paciente_rut: '12.345.678-5' }, { updated: t0 + i * 10 + j }));
    });
    for (const p of pcs) await p.sync();
    for (const p of pcs) await p.sync();
    for (const p of pcs) assert.equal(p.state.records.length, 12);

    // PC0 edita una atención del PC1; PC2 elimina una propia; PC3 edita la misma que PC0, pero después.
    tick();
    const edit = (p, id, name, u) => {
      const r = p.state.records.find((x) => x.id === id);
      r.f.paciente_nombre = name;
      r.updated = u;
    };
    edit(pcs[0], 'pc1_0', 'Editado por PC0', t0 + 1000);
    edit(pcs[3], 'pc1_0', 'Editado por PC3 (después)', t0 + 2000);
    pcs[2].state.records = pcs[2].state.records.filter((r) => r.id !== 'pc2_1');
    pcs[2].state.tombstones.pc2_1 = t0 + 1500;

    for (let round = 0; round < 2; round++) for (const p of pcs) await p.sync();

    const snapshot = (p) => JSON.stringify(p.state.records.map((r) => [r.id, r.updated, r.f.paciente_nombre]).sort());
    for (const p of pcs) {
      assert.equal(p.state.records.length, 11);
      assert.equal(snapshot(p), snapshot(pcs[0]));
      assert.equal(p.state.records.find((r) => r.id === 'pc1_0').f.paciente_nombre, 'Editado por PC3 (después)');
      assert.ok(!p.state.records.some((r) => r.id === 'pc2_1'));
    }

    // Lo que guarda el servidor no contiene nombres ni RUT.
    const serverText = [...store._map.entries()].join('\n');
    assert.ok(!/Paciente|Secreto|Editado|12\.345|345678/.test(serverText));
    assert.equal(store._map.size, 12, '11 atenciones + 1 eliminación, una versión cada una');
    assert.ok([...store._map.keys()].every((k) => k.startsWith('oftalmologia/r/')), 'separado por especialidad');

    // Sincronizar de nuevo no cambia nada.
    const again = await pcs[1].sync();
    assert.deepEqual(again, { pushed: 0, skipped: 0, merged: 0, added: 0, updated: 0, deleted: 0, needsPush: false });
  });

  test('un PC con otra contraseña no puede leer ni escribir', async () => {
    const { fetchFn } = await setup();
    const wrong = await deriveTeamKeys('una contraseña distinta y larga', 1000);
    await assert.rejects(
      syncOnce({ api: createSyncApi({ token: wrong.token, fetchFn }), key: await importEncKey(wrong.encKey), readLocal: () => ({ items: [], tombstones: {} }), writeLocal() {} }),
      (e) => e.status === 401,
    );
  });
});

describe('especialidades', () => {
  test('cada especialidad tiene su espacio y puede tener su propia contraseña', async () => {
    const ofta = await deriveTeamKeys(PASS, 1000);
    const otra = await deriveTeamKeys('Q2W3E-R4T5Y-6Y7U8-P9Q0Z', 1000);
    const store = memoryBlobStore();
    const handler = createSyncHandler({ store, tokenHash: (esp) => (esp === 'otorrino' ? tokenHash(otra.token) : tokenHash(ofta.token)) });
    const fetchFn = (url, init) => handler(new Request('https://x.test' + url, init));
    const iv = 'AAAAAAAAAAAAAAAA';
    await createSyncApi({ token: ofta.token, esp: 'oftalmologia', fetchFn }).put([{ id: 'a', u: 1, iv, ct: 'AQ==' }]);
    await createSyncApi({ token: otra.token, esp: 'otorrino', fetchFn }).put([{ id: 'b', u: 1, iv, ct: 'AQ==' }]);
    assert.deepEqual((await createSyncApi({ token: ofta.token, esp: 'oftalmologia', fetchFn }).list()).items, [{ id: 'a', u: 1 }]);
    assert.deepEqual((await createSyncApi({ token: otra.token, esp: 'otorrino', fetchFn }).list()).items, [{ id: 'b', u: 1 }]);
    await assert.rejects(createSyncApi({ token: ofta.token, esp: 'otorrino', fetchFn }).list(), (e) => e.status === 401);
    const bad = await fetchFn('/api/sync/list?esp=../x', { headers: { authorization: 'Bearer ' + ofta.token } });
    assert.equal(bad.status, 400);
  });

  test('lee el formato de la v2.1 ({record}) como atención', async () => {
    const { keys, fetchFn } = await setup();
    const key = await importEncKey(keys.encKey);
    const api = createSyncApi({ token: keys.token, fetchFn });
    const rec = minimalRecord('viejo1', { paciente_nombre: 'Formato antiguo' }, { updated: 5 });
    await api.put([{ id: rec.id, u: 5, ...(await encryptPayload(key, rec.id, 5, { record: rec })) }]);
    let got;
    await syncOnce({ api, key, readLocal: () => ({ items: [], tombstones: {} }), writeLocal: (items) => (got = items) });
    assert.equal(got[0].kind, 'atencion');
    assert.equal(got[0].data.f.paciente_nombre, 'Formato antiguo');
  });
});

describe('mismo paciente editado en dos PC a la vez', () => {
  /** Edición local: cambia campos, los sella y sube la versión. */
  const editLocal = (pc, id, t, fn) => {
    const i = pc.state.records.findIndex((r) => r.id === id);
    const before = structuredClone(pc.state.records[i]);
    const next = structuredClone(before);
    fn(next);
    next.updated = t;
    pc.state.records[i] = stampChanges(next, before, t);
  };

  for (const order of ['PC1 sincroniza primero', 'PC2 sincroniza primero']) {
    test(`campos distintos se conservan (${order})`, async () => {
      const { pc } = await setup();
      const pc1 = pc();
      const pc2 = pc();
      const t0 = Date.now();
      pc1.state.records.push(minimalRecord('pac1', { paciente_nombre: 'Ana Tuki', paciente_rut: '12.345.678-5' }, { updated: t0, ft: {} }));
      await pc1.sync();
      await pc2.sync(); // ambos tienen la atención

      // Sin sincronizar entre medio: PC1 anota la PIO, PC2 el diagnóstico y un procedimiento.
      editLocal(pc1, 'pac1', t0 + 100, (r) => {
        r.f.od_pio = '18';
        r.proc.t_aplan = { eye: 'AO', od: '18', oi: '17' };
      });
      editLocal(pc2, 'pac1', t0 + 200, (r) => {
        r.checks.diagnostico_glaucoma = true;
        r.proc.campimetria = { eye: 'AO' };
      });

      const [first, second] = order.startsWith('PC1') ? [pc1, pc2] : [pc2, pc1];
      await first.sync();
      await second.sync();
      await first.sync();
      await second.sync();

      for (const p of [pc1, pc2]) {
        const r = p.state.records.find((x) => x.id === 'pac1');
        assert.equal(r.f.od_pio, '18', 'PIO de PC1');
        assert.deepEqual(r.proc.t_aplan, { eye: 'AO', od: '18', oi: '17' });
        assert.equal(r.checks.diagnostico_glaucoma, true, 'diagnóstico de PC2');
        assert.deepEqual(r.proc.campimetria, { eye: 'AO' });
      }
      assert.deepEqual(
        JSON.stringify(pc1.state.records.find((x) => x.id === 'pac1').f),
        JSON.stringify(pc2.state.records.find((x) => x.id === 'pac1').f),
      );
    });
  }

  test('el mismo campo en ambos: queda la edición más reciente', async () => {
    const { pc } = await setup();
    const pc1 = pc();
    const pc2 = pc();
    const t0 = Date.now();
    pc1.state.records.push(minimalRecord('pac2', { paciente_nombre: 'Juan' }, { updated: t0, ft: {} }));
    await pc1.sync();
    await pc2.sync();
    editLocal(pc1, 'pac2', t0 + 300, (r) => (r.f.od_pio = '21'));
    editLocal(pc2, 'pac2', t0 + 100, (r) => (r.f.od_pio = '15'));
    for (let i = 0; i < 2; i++) {
      await pc2.sync();
      await pc1.sync();
    }
    for (const p of [pc1, pc2]) assert.equal(p.state.records.find((x) => x.id === 'pac2').f.od_pio, '21');
  });
});

describe('huella de contenido', () => {
  test('atada al id y a la versión: el servidor no puede comparar registros ni versiones', async () => {
    const { contentHash } = await import('../src/sync/client.js');
    const { encKey } = await deriveTeamKeys(PASS, 1000);
    const same = 'mismo contenido';
    const h = contentHash(encKey, 'a', 10, 'atencion', same);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(contentHash(encKey, 'a', 10, 'atencion', same), h, 'determinista para el mismo id y versión');
    assert.notEqual(contentHash(encKey, 'b', 10, 'atencion', same), h, 'otro registro, mismo contenido → otra huella');
    assert.notEqual(contentHash(encKey, 'a', 11, 'atencion', same), h, 'otra versión, mismo contenido → otra huella');
    assert.notEqual(contentHash(encKey, 'x', 1, 'eliminado', ''), contentHash(encKey, 'y', 1, 'eliminado', ''), 'eliminaciones no reconocibles');
    const other = (await deriveTeamKeys('Q2W3E-R4T5Y-6Y7U8-P9Q0Z', 1000)).encKey;
    assert.notEqual(contentHash(other, 'a', 10, 'atencion', same), h, 'depende de la clave del equipo');
  });
});
