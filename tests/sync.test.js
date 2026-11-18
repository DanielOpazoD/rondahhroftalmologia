import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePassphrase,
  normalizePassphrase,
  passphraseProblem,
  deriveTeamKeys,
  tokenHash,
  importEncKey,
  encryptPayload,
  decryptPayload,
  DecryptError,
} from '../src/sync/crypto.js';
import {
  localVersions,
  remoteVersions,
  planSync,
  applyPulled,
  PROTOCOL_VERSION,
  MIN_CLIENT_PROTOCOL,
  PROTOCOL_HEADER,
} from '../src/sync/protocol.js';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import {
  createSyncApi,
  syncOnce,
  SyncHttpError,
  serverId,
  createSyncCache,
  CURSOR_MARGIN_MS,
  resolveLocalId,
  listRemote,
} from '../src/sync/client.js';
import { CHANGE_LOG_DAYS, AUTH_LIMIT } from '../src/sync/server.js';
import { fullRecord, minimalRecord } from './fixtures.js';
import { patientFromRecord, normalizePatient } from '../src/core/patient.js';
import { makeMedico } from '../src/core/catalog.js';
import { syncMerge, syncFingerprint, stampChanges } from '../src/core/merge.js';

const PASS = 'K7QM3-XRT9P-ZAWD4-N8F2C';
/** Claves de versiones guardadas (sin el índice de cambios `/c/`). */
const versionKeys = (store) => [...store._map.keys()].filter((k) => k.split('/')[1] === 'r');

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
    const remote = remoteVersions([
      { id: 'a', u: 5 },
      { id: 'b', u: 20 },
      { id: 'c', u: 40 },
      { id: 'd', u: 1 },
      { id: 'd', u: 2 },
    ]);
    const plan = planSync(local, remote);
    assert.deepEqual(plan.push, ['a']);
    assert.deepEqual(plan.pull, [
      { id: 'b', u: 20 },
      { id: 'c', u: 40 },
      { id: 'd', u: 2 },
    ]);

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
    assert.deepEqual(
      r.items.find((x) => x.id === 'n'),
      { id: 'n', updated: 7, kind: 'medico', data: { nombre: 'Dra. Nueva', id: 'n', updated: 7 } },
    );
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
  /** `keyProven`: esta clave ya sincronizó antes en el PC; `state`: retoma el de otro PC (el mismo equipo). */
  const pc = ({ keyProven = false, state = { records: [], tombstones: {} } } = {}) => {
    return {
      state,
      sync: () =>
        syncOnce({
          api: createSyncApi({ token: keys.token, fetchFn, esp: 'oftalmologia' }),
          key,
          keyProven,
          readLocal: () => ({ items: toItems(structuredClone(state.records)), tombstones: { ...state.tombstones } }),
          mergeFn: syncMerge,
          writeLocal: (items, tombstones) =>
            Object.assign(state, { records: items.map((i) => ({ ...i.data, id: i.id, updated: i.updated })), tombstones }),
          batchSize: 2,
        }),
    };
  };
  return { keys, store, handler, fetchFn, pc, tick: (ms = 1000) => (clock += ms) };
}

/** Daña en el servidor la versión vigente de `id` (cifrado basura con formato válido). */
function damage(store, id) {
  const key = versionKeys(store).find((k) => k.split('/')[2] === id);
  const blob = JSON.parse(store._map.get(key));
  store._map.set(key, JSON.stringify({ ...blob, ct: Buffer.from('dato dañado '.repeat(4)).toString('base64') }));
}

describe('datos dañados', () => {
  test('un dato que no se descifra se aparta y la sincronización sigue con lo demás', async () => {
    const { store, pc, tick } = await setup();
    const A = pc();
    const r1 = { ...minimalRecord(), id: 'a1', updated: 1000, f: { paciente_nombre: 'Uno' } };
    const r2 = { ...minimalRecord(), id: 'a2', updated: 1000, f: { paciente_nombre: 'Dos' } };
    A.state.records = [r1, r2];
    await A.sync();
    damage(store, 'a1');
    tick();
    // Un PC que ya sincronizó con esta clave: el dato dañado no detiene nada.
    const B = pc({ keyProven: true });
    const rb = await B.sync();
    assert.deepEqual(rb.damaged, ['a1']);
    assert.deepEqual(
      B.state.records.map((r) => r.id),
      ['a2'],
      'lo demás llega igual',
    );
    // Y sigue funcionando en las siguientes (sin subir nada encima de lo dañado).
    B.state.records.push({ ...minimalRecord(), id: 'b1', updated: 2000 });
    const again = await B.sync();
    assert.deepEqual(again.damaged, ['a1']);
    assert.equal(again.pushed, 1);
    assert.equal(versionKeys(store).filter((k) => k.split('/')[2] === 'a1').length, 1);
  });

  test('si nada se descifra y la clave nunca funcionó en este PC, es la clave: se detiene con el error', async () => {
    const { store, pc } = await setup();
    const A = pc();
    A.state.records = [{ ...minimalRecord(), id: 'a1', updated: 1000 }];
    await A.sync();
    damage(store, 'a1');
    await assert.rejects(pc().sync(), DecryptError);
    // Un dato dañado que este PC no tiene no se borra del servidor (podría ser de una versión más nueva).
    await pc({ keyProven: true }).sync();
    assert.equal(versionKeys(store).filter((k) => k.split('/')[2] === 'a1').length, 1);
  });
});

describe('servidor', () => {
  test('rechaza sin configuración, sin token o con token incorrecto', async () => {
    const { keys, fetchFn } = await setup();
    const noConfig = createSyncHandler({ store: memoryBlobStore(), tokenHash: '' });
    assert.equal((await noConfig(new Request('https://x/api/sync/list'))).status, 503);
    await assert.rejects(createSyncApi({ token: 'malo', fetchFn }).list(), (e) => e instanceof SyncHttpError && e.status === 401);
    assert.deepEqual((await createSyncApi({ token: keys.token, fetchFn }).list()).items, []);
  });

  test('valida entradas', async () => {
    const { keys, fetchFn } = await setup();
    const post = (path, body) => fetchFn('/api/sync/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + keys.token }, body });
    assert.equal((await post('put', '{no json')).status, 400);
    assert.equal((await post('put', JSON.stringify({ items: [{ id: '../x', u: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AA==' }] }))).status, 400);
    assert.equal((await post('put', JSON.stringify({ items: [{ id: 'a', u: 1, iv: 'corto', ct: 'AA==' }] }))).status, 400);
    assert.equal((await post('put', JSON.stringify({ items: Array(201).fill({ id: 'a', u: 1 }) }))).status, 400);
    assert.equal((await post('borrar', JSON.stringify({ items: [] }))).status, 404);
    // El id y la huella tienen que ser texto: antes un elemento sin id se guardaba como `r/undefined/1`.
    const ok = { u: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJD' };
    for (const bad of [{}, { id: 123 }, { id: ['b'] }, { id: 'b', h: 12 }]) {
      const r = await post('put', JSON.stringify({ items: [{ ...ok, ...bad }] }));
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  test('guarda solo versión vigente y no acepta versiones viejas', async () => {
    const { keys, fetchFn, store } = await setup();
    const api = createSyncApi({ token: keys.token, fetchFn });
    const iv = 'AAAAAAAAAAAAAAAA';
    assert.deepEqual(await api.put([{ id: 'a', u: 10, iv, ct: 'AQ==' }]), { saved: ['a'], skipped: [] });
    assert.deepEqual(await api.put([{ id: 'a', u: 20, iv, ct: 'Ag==' }]), { saved: ['a'], skipped: [] });
    assert.deepEqual(await api.put([{ id: 'a', u: 15, iv, ct: 'Aw==' }]), { saved: [], skipped: ['a'] });
    assert.deepEqual(versionKeys(store), ['oftalmologia/r/a/20']);
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
      for (let j = 0; j < 3; j++) {
        p.state.records.push(
          minimalRecord(
            `pc${i}_${j}`,
            { paciente_nombre: `Paciente Secreto ${i}${j}`, paciente_rut: '12.345.678-5' },
            { updated: t0 + i * 10 + j },
          ),
        );
      }
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
    assert.equal(versionKeys(store).length, 12, '11 atenciones + 1 eliminación, una versión cada una');
    assert.ok(
      versionKeys(store).every((k) => k.startsWith('oftalmologia/r/')),
      'separado por especialidad',
    );

    // Sincronizar de nuevo no cambia nada.
    const again = await pcs[1].sync();
    assert.deepEqual(again, { pushed: 0, skipped: 0, merged: 0, added: 0, updated: 0, deleted: 0, needsPush: false, damaged: [] });
  });

  test('un PC con otra contraseña no puede leer ni escribir', async () => {
    const { fetchFn } = await setup();
    const wrong = await deriveTeamKeys('una contraseña distinta y larga', 1000);
    await assert.rejects(
      syncOnce({
        api: createSyncApi({ token: wrong.token, fetchFn }),
        key: await importEncKey(wrong.encKey),
        readLocal: () => ({ items: [], tombstones: {} }),
        writeLocal() {},
      }),
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
    assert.notEqual(
      contentHash(encKey, 'x', 1, 'eliminado', ''),
      contentHash(encKey, 'y', 1, 'eliminado', ''),
      'eliminaciones no reconocibles',
    );
    const other = (await deriveTeamKeys('Q2W3E-R4T5Y-6Y7U8-P9Q0Z', 1000)).encKey;
    assert.notEqual(contentHash(other, 'a', 10, 'atencion', same), h, 'depende de la clave del equipo');
  });
});

describe('fichas de pacientes (espacio común)', () => {
  test('dos equipos editan distintos datos de la misma ficha: se conservan ambos y no se mezclan con atenciones', async () => {
    const { keys, fetchFn, store } = await setup();
    const key = await importEncKey(keys.encKey);
    const base = patientFromRecord(minimalRecord('a', { paciente_rut: '12.345.678-5', paciente_nombre: 'Rosa Secreta' }), 1000);
    /** Un equipo que sincroniza solo fichas en el espacio 'pacientes'. */
    const pc = () => {
      const state = { patients: [structuredClone(base)] };
      return {
        state,
        edit(k, v, t) {
          const prev = state.patients[0];
          const next = structuredClone(prev);
          next.f[k] = v;
          next.updated = t;
          state.patients = [stampChanges(next, prev, t)];
        },
        sync: () =>
          syncOnce({
            api: createSyncApi({ token: keys.token, fetchFn, esp: 'pacientes' }),
            key,
            encKey: keys.encKey,
            fingerprint: syncFingerprint,
            opaqueIds: true,
            readLocal: () => ({
              items: state.patients.map((p) => ({ id: p.id, updated: p.updated, kind: 'paciente', data: structuredClone(p) })),
              tombstones: {},
            }),
            mergeFn: syncMerge,
            writeLocal: (items) => {
              state.patients = items.map((i) => normalizePatient({ ...i.data, id: i.id, updated: i.updated }));
            },
          }),
      };
    };
    const [admision, box] = [pc(), pc()];
    await admision.sync();
    admision.edit('paciente_fono', '555 1234', 2000);
    box.edit('paciente_fnac', '1950-03-01', 2500);
    for (const p of [admision, box, admision, box]) await p.sync();
    for (const p of [admision, box]) {
      assert.equal(p.state.patients.length, 1);
      assert.equal(p.state.patients[0].f.paciente_fono, '555 1234');
      assert.equal(p.state.patients[0].f.paciente_fnac, '1950-03-01');
    }
    assert.deepEqual(admision.state.patients, box.state.patients);
    const keysOnServer = versionKeys(store);
    assert.equal(keysOnServer.length, 1);
    assert.match(keysOnServer[0], /^pacientes\/r\/h_[0-9a-f]{32}\//, 'solo en el espacio común, con id opaco');
    // El id local (huella del RUT, adivinable probando RUTs) nunca llega al servidor.
    assert.ok(!keysOnServer[0].includes(base.id), 'el servidor no ve el id derivado del RUT');
    assert.equal(keysOnServer[0].split('/')[2], serverId(keys.encKey, base.id));
    const raw = JSON.stringify([...store._map.values()]);
    assert.ok(!raw.includes('Rosa') && !raw.includes('12.345.678'), 'el servidor no ve nombre ni RUT');
  });

  test('id opaco: se ignoran elementos cuyo id no corresponde a su contenido', async () => {
    const { keys, fetchFn } = await setup();
    const key = await importEncKey(keys.encKey);
    const api = createSyncApi({ token: keys.token, fetchFn, esp: 'pacientes' });
    const ana = patientFromRecord(minimalRecord('a', { paciente_rut: '12.345.678-5', paciente_nombre: 'Ana' }), 1000);
    const luis = patientFromRecord(minimalRecord('b', { paciente_nombre: 'Luis' }), 1000);
    const put = async (id, lid, data) =>
      api.put([{ id, u: 1000, ...(await encryptPayload(key, id, 1000, { kind: 'paciente', data, lid })) }]);
    await put(serverId(keys.encKey, luis.id), ana.id, ana); // reubicado: el id opaco es de otro paciente
    await put(ana.id, ana.id, ana); // id en claro (no opaco)
    await put('h_' + 'f'.repeat(32), undefined, luis); // sin id local
    const state = { patients: [] };
    await syncOnce({
      api,
      key,
      encKey: keys.encKey,
      fingerprint: syncFingerprint,
      opaqueIds: true,
      mergeFn: syncMerge,
      readLocal: () => ({ items: [], tombstones: {} }),
      writeLocal: (items) => (state.patients = items),
    });
    assert.deepEqual(state.patients, []);
  });

  test('migración: médicos subidos con id en claro pasan a id opaco y lo antiguo se borra', async () => {
    const { keys, fetchFn, store } = await setup();
    const key = await importEncKey(keys.encKey);
    const api = createSyncApi({ token: keys.token, fetchFn, esp: 'oftalmologia' });
    const med = makeMedico({ nombre: 'Dra. Antigua', rut: '12.345.678-5' }, 1000);
    const nuevo = makeMedico({ nombre: 'Dr. Local', rut: '10.000.013-K' }, 2000);
    const atencion = minimalRecord('aten1', { paciente_nombre: 'X' }, { updated: 1000 });
    // Así subía la 2.9.1: id en claro (huella del RUT), sin `lid`.
    for (const [id, kind, data] of [
      [med.id, 'medico', med],
      [atencion.id, 'atencion', atencion],
    ]) {
      await api.put([{ id, u: 1000, ...(await encryptPayload(key, id, 1000, { kind, data })) }]);
    }
    const state = { items: [{ id: nuevo.id, updated: 2000, kind: 'medico', data: nuevo }], tombstones: {} };
    const sync = () =>
      syncOnce({
        api,
        key,
        encKey: keys.encKey,
        fingerprint: syncFingerprint,
        mergeFn: syncMerge,
        opaqueIds: (id) => id.startsWith('m_'),
        readLocal: () => structuredClone(state),
        writeLocal: (items, tombstones) => Object.assign(state, { items, tombstones }),
      });
    await sync();
    const ids = () =>
      versionKeys(store)
        .map((k) => k.split('/')[2])
        .sort();
    assert.deepEqual(
      ids(),
      [atencion.id, serverId(keys.encKey, med.id), serverId(keys.encKey, nuevo.id)].sort(),
      'sin ids de médico en claro',
    );
    assert.deepEqual(state.items.map((i) => i.id).sort(), [atencion.id, med.id, nuevo.id].sort(), 'localmente conserva sus ids');
    assert.equal(state.items.find((i) => i.id === med.id).data.nombre, 'Dra. Antigua');
    // Otro equipo recibe todo con sus ids locales.
    const other = { items: [], tombstones: {} };
    await syncOnce({
      api,
      key,
      encKey: keys.encKey,
      fingerprint: syncFingerprint,
      mergeFn: syncMerge,
      opaqueIds: (id) => id.startsWith('m_'),
      readLocal: () => structuredClone(other),
      writeLocal: (items, tombstones) => Object.assign(other, { items, tombstones }),
    });
    assert.deepEqual(other.items.map((i) => [i.id, i.data.id]).sort(), state.items.map((i) => [i.id, i.id]).sort());

    // Un equipo aún sin actualizar vuelve a subir al médico en claro, con un cambio más nuevo:
    // se incorpora a la versión opaca antes de borrar lo antiguo.
    const editado = { ...med, rut: '12.345.678-5', nombre: 'Dra. Antigua Editada', updated: 5000 };
    await api.put([{ id: med.id, u: 5000, ...(await encryptPayload(key, med.id, 5000, { kind: 'medico', data: editado })) }]);
    await sync();
    assert.equal(state.items.find((i) => i.id === med.id).data.nombre, 'Dra. Antigua Editada');
    assert.ok(!ids().includes(med.id), 'lo antiguo se borró tras fusionarlo');
  });
});

describe('purge', () => {
  test('solo borra ids antiguos en claro (nunca atenciones ni ids opacos)', async () => {
    const { keys, fetchFn, store } = await setup();
    const api = createSyncApi({ token: keys.token, fetchFn });
    const iv = 'AAAAAAAAAAAAAAAA';
    await api.put([
      { id: 'm_abcdefgh', u: 10, iv, ct: 'AQ==' },
      { id: 'aten1', u: 10, iv, ct: 'AQ==' },
    ]);
    for (const ids of [['aten1'], ['h_' + 'a'.repeat(32)], ['m_abc'], ['../x']]) {
      await assert.rejects(api.purge(ids), (e) => e instanceof SyncHttpError && e.status === 400);
    }
    assert.deepEqual(await api.purge(['m_abcdefgh', 'p_0123456789']), { purged: ['m_abcdefgh'] });
    assert.deepEqual(versionKeys(store), ['oftalmologia/r/aten1/10']);
    await assert.rejects(createSyncApi({ token: 'malo', fetchFn }).purge(['m_abcdefgh']), (e) => e.status === 401);
  });
});

describe('sincronización incremental (años de datos)', () => {
  /** Servidor con reloj controlable y registro de lo que responde `list`. */
  async function incWorld() {
    const keys = await deriveTeamKeys(PASS, 1000);
    const key = await importEncKey(keys.encKey);
    const store = memoryBlobStore();
    const clock = { t: Date.now() };
    const lists = [];
    const handler = createSyncHandler({ store, tokenHash: tokenHash(keys.token), now: () => clock.t });
    const fetchFn = async (url, init) => {
      const res = await handler(new Request('https://x.test' + url, init));
      if (url.includes('/list')) lists.push({ url, body: await res.clone().json() });
      return res;
    };
    const pc = (records = []) => {
      const state = { items: records.map((r) => ({ id: r.id, updated: r.updated, kind: 'atencion', data: r })), tombstones: {} };
      const calls = { fingerprint: 0 };
      const cache = createSyncCache();
      return {
        state,
        calls,
        cache,
        sync: () =>
          syncOnce({
            api: createSyncApi({ token: keys.token, fetchFn }),
            key,
            encKey: keys.encKey,
            mergeFn: syncMerge,
            fingerprint: (k, d) => (calls.fingerprint++, syncFingerprint(k, d)),
            cache,
            readLocal: () => structuredClone(state),
            writeLocal: (items, tombstones) => Object.assign(state, { items, tombstones }),
          }),
      };
    };
    return { store, clock, lists, pc };
  }

  test('tras la primera, solo se piden los cambios y no se recalculan huellas', async () => {
    const { clock, lists, pc } = await incWorld();
    const t0 = clock.t;
    const recs = Array.from({ length: 300 }, (_, i) => minimalRecord('r' + i, { paciente_nombre: 'P' + i }, { updated: t0 - 1000 + i }));
    const A = pc(recs);
    const B = pc();
    await A.sync();
    clock.t += 3600_000;
    await B.sync();
    assert.equal(B.state.items.length, 300);
    assert.equal(lists.at(-1).body.full, true, 'la primera es completa');
    clock.t += 3600_000;
    await A.sync(); // sincronización periódica: el cursor avanza
    // Una hora después, sin cambios: lista vacía y ninguna huella recalculada.
    clock.t += 3600_000;
    A.calls.fingerprint = 0;
    await A.sync();
    assert.match(lists.at(-1).url, /since=/);
    assert.equal(lists.at(-1).body.full, false);
    assert.deepEqual(lists.at(-1).body.items, []);
    assert.equal(A.calls.fingerprint, 0);
    // B edita una atención: A recibe SOLO ese cambio.
    const e = B.state.items.find((i) => i.id === 'r7');
    e.updated = e.data.updated = clock.t;
    e.data.f.od_pio = '22';
    e.data.ft = { ...e.data.ft, 'f.od_pio': clock.t };
    await B.sync();
    clock.t += 60_000;
    await A.sync();
    assert.deepEqual(
      lists.at(-1).body.items.map((i) => i.id),
      ['r7'],
    );
    assert.equal(A.state.items.find((i) => i.id === 'r7').data.f.od_pio, '22');
  });

  test('cursor demasiado antiguo: lista completa; el índice viejo se limpia', async () => {
    const { store, clock, lists, pc } = await incWorld();
    const A = pc([minimalRecord('a', {}, { updated: clock.t - 1 })]);
    await A.sync();
    const marks = () => [...store._map.keys()].filter((k) => k.includes('/c/'));
    assert.equal(marks().length, 1, 'cada versión deja una marca en el índice de cambios');
    clock.t += (CHANGE_LOG_DAYS + 5) * 24 * 3600_000;
    A.cache.fullAt = clock.t; // fuerza el intento incremental con un cursor viejo
    await A.sync();
    assert.equal(lists.at(-1).body.full, true);
    assert.deepEqual(marks(), [], 'marcas de más de 30 días borradas');
    assert.ok(CURSOR_MARGIN_MS >= 5 * 60_000);
  });

  test('un cambio local sin versión nueva se corrige en la siguiente lista completa (huellas re-verificadas)', async () => {
    const { clock, pc } = await incWorld();
    const doc = { id: 'b_x', atencionId: 'x', updated: clock.t - 5, entries: [{ id: 'e1', at: 10, tipo: 'creada', cambios: [] }] };
    const A = pc();
    const B = pc();
    A.state.items = [{ id: 'b_x', updated: doc.updated, kind: 'bitacora', data: structuredClone(doc) }];
    for (const p of [A, B, A, B]) {
      clock.t += 60_000;
      await p.sync();
    }
    // A recibe una entrada por fuera de la sincronización, sin subir la versión.
    A.state.items[0].data.entries.unshift({ id: 'e2', at: 7, tipo: 'editada', cambios: [] });
    clock.t += 60_000;
    await A.sync();
    // Pasados 30 minutos, la lista completa vuelve a comprobar las huellas.
    A.cache.fullAt = 0;
    for (const p of [A, B]) {
      clock.t += 60_000;
      await p.sync();
    }
    assert.deepEqual(B.state.items[0].data.entries.map((e) => e.id).sort(), ['e1', 'e2']);
  });
});

describe('red poco confiable', () => {
  const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  test('errores transitorios se reintentan con retroceso; los demás no', async () => {
    const waits = [];
    const sleep = async (ms) => void waits.push(ms);
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return new Response('{}', { status: 502 });
      return okJson({ items: [], now: 1, full: true });
    };
    const api = createSyncApi({ token: 't', fetchFn: flaky, sleep });
    assert.deepEqual((await api.list()).items, []);
    assert.equal(n, 3);
    assert.equal(waits.length, 2);
    assert.ok(waits[0] >= 500 && waits[1] >= 1000, 'retroceso exponencial');

    // 401 (contraseña incorrecta) no se reintenta.
    let m = 0;
    const denied = async () => (m++, new Response(JSON.stringify({ error: 'no' }), { status: 401 }));
    await assert.rejects(createSyncApi({ token: 't', fetchFn: denied, sleep }).list(), (e) => e.status === 401);
    assert.equal(m, 1);

    // Agotados los reintentos, se informa el error.
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(createSyncApi({ token: 't', fetchFn: down, sleep, retries: 1 }).list(), (e) => e.status === 0);
  });

  test('una solicitud que no responde se corta por tiempo', async () => {
    const hang = (_url, init) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    const api = createSyncApi({ token: 't', fetchFn: hang, timeoutMs: 30, retries: 0 });
    await assert.rejects(api.list(), (e) => e instanceof SyncHttpError && e.status === 0 && /a tiempo/.test(e.message));
  });

  test('sincronización completa con un servidor que falla a ratos: converge igual', async () => {
    const { keys, handler } = await setup();
    let calls = 0;
    const flakyFetch = async (url, init) => {
      calls++;
      if (calls % 3 === 0) throw new TypeError('fetch failed'); // 1 de cada 3 solicitudes falla
      return handler(new Request('https://x.test' + url, init));
    };
    const key = await importEncKey(keys.encKey);
    const mk = (records) => {
      const st = { items: records.map((r) => ({ id: r.id, updated: r.updated, kind: 'atencion', data: r })), tombstones: {} };
      return {
        st,
        sync: () =>
          syncOnce({
            api: createSyncApi({ token: keys.token, fetchFn: flakyFetch, sleep: async () => {} }),
            key,
            encKey: keys.encKey,
            mergeFn: syncMerge,
            fingerprint: syncFingerprint,
            readLocal: () => structuredClone(st),
            writeLocal: (items, tombstones) => Object.assign(st, { items, tombstones }),
            batchSize: 3,
          }),
      };
    };
    const A = mk(Array.from({ length: 8 }, (_, i) => minimalRecord('a' + i, { paciente_nombre: 'A' + i }, { updated: 100 + i })));
    const B = mk([]);
    for (const p of [A, B, A, B]) await p.sync();
    assert.equal(B.st.items.length, 8);
  });
});

describe('versión de protocolo', () => {
  test('el servidor la declara, acepta clientes al día y antiguos sin cabecera, y rechaza los muy antiguos con 426', async () => {
    const { keys, fetchFn } = await setup();
    const req = (headers) => fetchFn('/api/sync/list', { headers: { authorization: 'Bearer ' + keys.token, ...headers } });
    const current = await req({ [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });
    assert.equal(current.status, 200);
    assert.equal(current.headers.get(PROTOCOL_HEADER), String(PROTOCOL_VERSION));
    assert.equal((await req({})).status, 200, 'clientes anteriores a la 2.12 (sin cabecera) siguen funcionando');
    const old = await req({ [PROTOCOL_HEADER]: String(MIN_CLIENT_PROTOCOL - 1) });
    assert.equal(old.status, 426);
    assert.match((await old.json()).error, /Recarga la página/);
    assert.equal((await req({ [PROTOCOL_HEADER]: 'basura' })).status, 426);
  });

  test('el cliente la envía y recuerda la del servidor', async () => {
    const { keys, fetchFn } = await setup();
    let sent;
    const spy = (url, init) => ((sent = init.headers[PROTOCOL_HEADER]), fetchFn(url, init));
    const api = createSyncApi({ token: keys.token, fetchFn: spy });
    await api.list();
    assert.equal(sent, String(PROTOCOL_VERSION));
    assert.equal(api.serverProtocol, PROTOCOL_VERSION);
  });
});

describe('servidor robusto', () => {
  test('errores con código estable, 405 con Allow, 413 por tamaño, id de solicitud y registro sin datos', async () => {
    const keys = await deriveTeamKeys(PASS, 1000);
    const logs = [];
    const handler = createSyncHandler({ store: memoryBlobStore(), tokenHash: tokenHash(keys.token), log: (e) => logs.push(e) });
    const call = (path, init = {}) =>
      handler(
        new Request('https://x.test/api/sync/' + path, { ...init, headers: { authorization: 'Bearer ' + keys.token, ...init.headers } }),
      );
    const code = async (r) => (await r.json()).code;

    const wrong = await call('list', { method: 'POST', body: '{}' });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'GET');
    assert.equal(await code(wrong), 'metodo');
    assert.equal(await code(await call('borrar', { method: 'POST', body: '{}' })), 'ruta');
    assert.equal(await code(await call('put', { method: 'POST', body: '{no json' })), 'json_invalido');
    const big = await call('put', { method: 'POST', body: 'x'.repeat(5_600_000) });
    assert.equal(big.status, 413);
    assert.equal(await code(big), 'demasiado_grande');
    const denied = await handler(new Request('https://x.test/api/sync/list', { headers: { authorization: 'Bearer malo' } }));
    assert.equal(await code(denied), 'token_invalido');

    const ok = await call('list');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('x-request-id'), /^[0-9a-f-]{16,}$/);
    assert.notEqual(ok.headers.get('x-request-id'), denied.headers.get('x-request-id'));
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');

    assert.equal(logs.length, 6);
    assert.deepEqual(Object.keys(logs.at(-1)).sort(), ['action', 'esp', 'ms', 'reqId', 'status']);
    assert.equal(logs.find((l) => l.status === 413).code, 'demasiado_grande');
    assert.ok(!JSON.stringify(logs).includes(keys.token), 'el registro no contiene el token');
  });
});

describe('límite de intentos fallidos', () => {
  test('tras 20 fallos desde una red: 429 por 15 min; la contraseña correcta nunca se bloquea', async () => {
    const keys = await deriveTeamKeys(PASS, 1000);
    const store = memoryBlobStore();
    const clock = { t: Date.now() };
    const handler = createSyncHandler({ store, tokenHash: tokenHash(keys.token), now: () => clock.t });
    const req = (token, ip = '200.1.2.3') =>
      handler(
        new Request('https://x.test/api/sync/list', { headers: { authorization: 'Bearer ' + token, 'x-nf-client-connection-ip': ip } }),
      );
    for (let i = 0; i < AUTH_LIMIT.maxFails - 1; i++) assert.equal((await req('malo')).status, 401);
    const blocked = await req('malo');
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'demasiados_intentos');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await req('malo')).status, 429, 'sigue bloqueada');
    assert.equal((await req(keys.token)).status, 200, 'la contraseña correcta pasa desde la misma red');
    assert.equal((await req('malo', '201.9.9.9')).status, 401, 'otra red no está bloqueada');
    // La IP no se guarda en claro.
    assert.ok(![...store._map.keys()].some((k) => k.includes('200.1.2.3')));
    assert.ok(!JSON.stringify([...store._map.values()]).includes('200.1.2.3'));
    // Pasado el bloqueo, vuelve a 401 (y cuenta de nuevo).
    clock.t += AUTH_LIMIT.blockMs + 1;
    assert.equal((await req('malo')).status, 401);
  });

  test('fallos simultáneos desde una red: todos cuentan (antes se pisaban y quedaba uno)', async () => {
    const keys = await deriveTeamKeys(PASS, 1000);
    const store = memoryBlobStore();
    for (const m of ['get', 'setJSON', 'list', 'delete']) {
      const f = store[m].bind(store);
      store[m] = async (...args) => (await new Promise((r) => setTimeout(r, 2)), f(...args));
    }
    const handler = createSyncHandler({ store, tokenHash: tokenHash(keys.token) });
    const req = (token) => handler(new Request('https://x.test/api/sync/list', { headers: { authorization: `Bearer ${token}` } }));
    await Promise.all(Array.from({ length: AUTH_LIMIT.maxFails * 3 }, () => req('malo')));
    assert.equal((await req('malo')).status, 429);
    assert.equal((await req(keys.token)).status, 200, 'la contraseña correcta nunca se bloquea');
  });

  test('los fallos espaciados (fuera de la ventana) no bloquean', async () => {
    const keys = await deriveTeamKeys(PASS, 1000);
    const clock = { t: Date.now() };
    const handler = createSyncHandler({ store: memoryBlobStore(), tokenHash: tokenHash(keys.token), now: () => clock.t });
    for (let i = 0; i < AUTH_LIMIT.maxFails * 2; i++) {
      clock.t += AUTH_LIMIT.windowMs / 10;
      const r = await handler(new Request('https://x.test/api/sync/list', { headers: { authorization: 'Bearer malo' } }));
      assert.equal(r.status, 401);
    }
  });
});

test('resolveLocalId: el id local debe corresponder al id del servidor (no se puede reubicar)', () => {
  const wire = (/** @type {string} */ lid) => 'w_' + lid;
  // Normal: el contenido trae su id local y corresponde al del servidor.
  assert.deepEqual(resolveLocalId({ lid: 'a1' }, 'w_a1', wire, false), { id: 'w_a1', lid: 'a1' });
  // Contenido de otro elemento (id del servidor distinto): se descarta.
  assert.equal(resolveLocalId({ lid: 'a1' }, 'w_b2', wire, false), null);
  // id local que no es texto: se descarta.
  assert.equal(resolveLocalId({ lid: 7 }, 'w_a1', wire, false), null);
  // Migración desde ids en claro: sin `lid` en el contenido; el id nuevo se deriva.
  assert.deepEqual(resolveLocalId({}, 'a1', wire, true), { id: 'w_a1', lid: 'a1' });
  assert.equal(resolveLocalId({ lid: 'a1' }, 'a1', wire, true), null);
});

test('listRemote: si la copia local desaparece mientras se pide lo cambiado, pide la lista completa', async () => {
  const cache = createSyncCache();
  const full = {
    items: [
      { id: 'a', u: 1 },
      { id: 'b', u: 1 },
    ],
    now: 1000,
    full: true,
  };
  // 1. Primera vez: lista completa.
  const api1 = { list: async () => full };
  assert.equal((await listRemote(/** @type {any} */ (api1), cache, 2000)).size, 2);
  // 2. Incremental, pero otra sincronización descarta la copia mientras se espera la respuesta.
  /** @type {(number | undefined)[]} */
  const asked = [];
  const api2 = {
    list: async (/** @type {number | undefined} */ since) => {
      asked.push(since);
      if (since === undefined) return { ...full, now: 3000 };
      cache.snapshot = null;
      return { items: [{ id: 'b', u: 2 }], now: 3000, full: false };
    },
  };
  const got = await listRemote(/** @type {any} */ (api2), cache, 2500);
  // Sin el arreglo, la respuesta parcial (solo «b») quedaba como si fuera todo lo del servidor.
  assert.equal(asked.length, 2);
  assert.equal(asked[1], undefined);
  assert.deepEqual([...got.keys()].sort(), ['a', 'b']);
});
