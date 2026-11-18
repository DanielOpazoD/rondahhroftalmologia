/**
 * Datos de cada PC cifrados con la clave personal (ADR 0016): motor y
 * almacenamiento cifrados, y la llave del PC con sus estuches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { idbBackend } from '../src/storage/backends.js';
import { createRepo } from '../src/storage/repo.js';
import { memoryStorage } from '../src/storage/store.js';
import { sealedBackend, sealedStorage, pcKeys, LockedError } from '../src/storage/sealed.js';
import { createPcVault } from '../src/storage/pcVault.js';

const D = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const RUT_ID = 'p_12345678'; // los ids de fichas salen del RUT
const ficha = { id: RUT_ID, tipo: 'paciente', f: { paciente_nombre: 'Ana Tepano', paciente_rut: '12.345.678-5' } };
const K1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const K2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const LOCAL_A = 'ab'.repeat(32);
const LOCAL_A2 = 'cd'.repeat(32);
const LOCAL_B = 'ef'.repeat(32);

/** Todo lo que quedó guardado, como texto (lo que vería quien copie el disco). */
async function rawText(inner) {
  const all = [];
  for (const col of ['atenciones', 'pacientes', 'bitacora', 'eliminadas', 'adjuntos', 'adjuntos_datos']) {
    all.push(...(await inner.getAll(col)));
  }
  return JSON.stringify(all, (_, v) => (v instanceof Uint8Array ? [...v] : v));
}

test('motor cifrado: guarda ilegible (ni nombre, ni RUT, ni el id que sale del RUT) y lee lo mismo', async () => {
  const inner = await idbBackend('s' + Math.random(), new IDBFactory());
  const s = sealedBackend(inner);
  assert.equal(s.state, 'clear');
  await s.open(await pcKeys(D));
  assert.equal(s.state, 'open');
  await s.backend.put('pacientes', ficha);
  await s.backend.put('adjuntos_datos', { id: 'j1', bytes: new Uint8Array([1, 2, 3, 250]) });
  const text = await rawText(inner);
  for (const secret of ['Tepano', '12.345.678', RUT_ID]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(await s.backend.getAll('pacientes'), [ficha]);
  assert.deepEqual(await s.backend.get('pacientes', RUT_ID), ficha);
  assert.deepEqual([...(await s.backend.get('adjuntos_datos', 'j1')).bytes], [1, 2, 3, 250]);
  assert.deepEqual(await s.backend.keys('adjuntos_datos'), ['j1'], 'los contenidos de adjuntos conservan su id (aleatorio)');
  await s.backend.delete('pacientes', RUT_ID);
  assert.deepEqual(await s.backend.getAll('pacientes'), []);
  // Con otra llave no se puede leer.
  const wrong = sealedBackend(inner);
  await wrong.open(await pcKeys(OTHER));
  await assert.rejects(wrong.backend.get('adjuntos_datos', 'j1'));
});

test('motor cifrado: cerrado no lee ni escribe; al abrir cifra lo que quedó legible sin pisar lo más nuevo', async () => {
  const inner = await idbBackend('s' + Math.random(), new IDBFactory());
  // Datos de antes de la llave (o de otra pestaña que aún no sabía de ella).
  await inner.put('pacientes', ficha);
  await inner.put('atenciones', { id: 'a1', f: { paciente_nombre: 'Vieja' } });
  await inner.put('adjuntos_datos', { id: 'j1', bytes: new Uint8Array([5]) });
  const keys = await pcKeys(D);
  // Una versión cifrada más nueva de a1 ya existe (la escribió una pestaña abierta).
  const first = sealedBackend(inner);
  await first.open(keys);
  await inner.put('atenciones', { id: 'a1', f: { paciente_nombre: 'Vieja' } });
  await first.backend.put('atenciones', { id: 'a1', f: { paciente_nombre: 'Nueva' } });

  const s = sealedBackend(inner, { locked: true });
  assert.equal(s.state, 'locked');
  await assert.rejects(s.backend.getAll('pacientes'), LockedError);
  await s.backend.put('pacientes', { ...ficha, f: {} }); // cerrado: se descarta, no pisa
  await s.backend.delete('pacientes', RUT_ID);
  await s.open(keys);
  assert.deepEqual(await s.backend.getAll('pacientes'), [ficha]);
  assert.deepEqual(await s.backend.getAll('atenciones'), [{ id: 'a1', f: { paciente_nombre: 'Nueva' } }], 'lo legible no pisa lo cifrado');
  assert.deepEqual([...(await s.backend.get('adjuntos_datos', 'j1')).bytes], [5]);
  const text = await rawText(inner);
  for (const secret of ['Tepano', 'Vieja', RUT_ID]) assert.equal(text.includes(secret), false, secret);
});

test('motor cifrado: un repositorio completo funciona igual encima', async () => {
  const name = 's' + Math.random();
  const factory = new IDBFactory();
  const keys = await pcKeys(D);
  const s = sealedBackend(await idbBackend(name, factory));
  await s.open(keys);
  const repo = createRepo(s.backend);
  await repo.init();
  repo.upsertRecord({ id: 'a1', created: 1, updated: 1, f: { paciente_nombre: 'Ana Tepano', fecha_atencion: '2026-11-17' } });
  await repo.flush();
  const again = sealedBackend(await idbBackend(name, factory), { locked: true });
  await again.open(keys);
  const repo2 = createRepo(again.backend);
  await repo2.init();
  assert.equal(repo2.loadRecords()[0].f.paciente_nombre, 'Ana Tepano');
});

test('almacenamiento cifrado: claves sensibles ilegibles en el disco; cerrado, nada se lee ni se pisa', async () => {
  const base = memoryStorage();
  base.setItem('oft_sync_v1', '{"encKey":"K-del-equipo"}');
  base.setItem('oft_ajustes_v1', '{"tema":"claro"}');
  const keys = await pcKeys(D);
  const s = sealedStorage(base, ['oft_sync_v1', 'oft_borrador_v1']);
  assert.equal(s.storage.getItem('oft_sync_v1'), '{"encKey":"K-del-equipo"}', 'sin llave, todo pasa igual');
  await s.open(keys);
  assert.match(base.getItem('oft_sync_v1'), /^enc1:/, 'lo legible quedó cifrado al abrir');
  assert.equal(s.storage.getItem('oft_sync_v1'), '{"encKey":"K-del-equipo"}');
  s.storage.setItem('oft_borrador_v1', '{"f":{"paciente_nombre":"Ana"}}');
  s.storage.setItem('oft_borrador_v1', '{"f":{"paciente_nombre":"Ana Tepano"}}');
  await s.flush();
  assert.equal(base.getItem('oft_borrador_v1').includes('Ana'), false);
  assert.equal(base.getItem('oft_ajustes_v1'), '{"tema":"claro"}', 'lo no sensible sigue legible');

  // Al recargar: cerrado hasta entrar. No se lee, y lo que se escriba se descarta.
  const locked = sealedStorage(base, ['oft_sync_v1', 'oft_borrador_v1'], { locked: true });
  assert.equal(locked.state, 'locked');
  assert.equal(locked.storage.getItem('oft_sync_v1'), null);
  locked.storage.setItem('oft_borrador_v1', '{}');
  assert.match(base.getItem('oft_borrador_v1'), /^enc1:/, 'no se pisó lo cifrado');
  await locked.open(keys);
  assert.equal(locked.storage.getItem('oft_borrador_v1'), '{"f":{"paciente_nombre":"Ana Tepano"}}', 'queda la última escritura');
  locked.storage.removeItem('oft_borrador_v1');
  assert.equal(base.getItem('oft_borrador_v1'), null);

  // Un valor dañado se informa y se trata como ausente (no impide entrar).
  base.setItem('oft_sync_v1', 'enc1:AAAA:BBBB');
  const errors = [];
  const damaged = sealedStorage(base, ['oft_sync_v1'], { locked: true, onError: (e) => errors.push(e) });
  await damaged.open(keys);
  assert.equal(damaged.storage.getItem('oft_sync_v1'), null);
  assert.equal(errors.length, 1);
});

test('llave del PC: se crea al entrar con conexión, se abre con la clave personal o la del equipo, y nunca queda legible', async () => {
  const base = memoryStorage();
  const opened = [];
  const make = () =>
    createPcVault({
      storage: base,
      name: 'oft_llave_pc_v1',
      targets: [{ open: async (k) => opened.push(k) }],
      onOpen: ({ first }) => opened.push(first),
    });

  const v1 = make();
  assert.equal(v1.state, 'clear');
  await v1.unlockOnline({ teamKeyB64: K1, uid: 'uA', local: LOCAL_A });
  assert.equal(v1.state, 'open');
  assert.equal(opened.at(-1), true, 'primera vez: hay que cifrar lo existente');
  const file = base.getItem('oft_llave_pc_v1');
  assert.ok(file && !file.includes(btoa(String.fromCharCode(...D))));

  // Al recargar: cerrada. Sin conexión abre con la clave correcta de quien ya entró aquí.
  const v2 = make();
  assert.equal(v2.state, 'locked');
  assert.equal(await v2.unlockOffline({ uid: 'uA', local: LOCAL_B }), 'wrong');
  assert.equal(v2.state, 'locked');
  assert.equal(await v2.unlockOffline({ uid: 'uB', local: LOCAL_B }), 'missing', 'quien nunca entró aquí necesita conexión');
  assert.equal(await v2.unlockOffline({ uid: 'uA', local: LOCAL_A }), 'ok');
  const keyA = opened.at(-2);

  // Otra persona entra con conexión: la abre con el estuche del equipo y queda con el suyo.
  const v3 = make();
  await v3.unlockOnline({ teamKeyB64: K1, uid: 'uB', local: LOCAL_B });
  const v4 = make();
  assert.equal(await v4.unlockOffline({ uid: 'uB', local: LOCAL_B }), 'ok');
  assert.deepEqual(opened.at(-2).mac, keyA.mac, 'es la misma llave del PC');

  // Cambio de clave: el estuche anterior deja de servir.
  await v4.rewrap({ uid: 'uB', local: LOCAL_A2 });
  assert.equal(await make().unlockOffline({ uid: 'uB', local: LOCAL_B }), 'wrong');
  assert.equal(await make().unlockOffline({ uid: 'uB', local: LOCAL_A2 }), 'ok');

  // Clave restablecida por el administrador (el estuche no sirve): con conexión la abre el equipo.
  await make().unlockOnline({ teamKeyB64: K1, uid: 'uA', local: LOCAL_B });
  assert.equal(await make().unlockOffline({ uid: 'uA', local: LOCAL_B }), 'ok');

  // Nueva clave del equipo: abre con la cuenta y renueva el estuche del equipo.
  await make().unlockOnline({ teamKeyB64: K2, uid: 'uA', local: LOCAL_B });
  await make().unlockOnline({ teamKeyB64: K2, uid: 'uC', local: LOCAL_A });
  // Cuenta desactivada o quitada de este PC: su estuche se borra y ya no abre sin conexión.
  make().forget({ uid: 'uC' });
  assert.equal(await make().unlockOffline({ uid: 'uC', local: LOCAL_A }), 'missing');
  make().forget({ keep: ['uA'] });
  assert.equal(await make().unlockOffline({ uid: 'uB', local: LOCAL_A2 }), 'missing');
  assert.equal(await make().unlockOffline({ uid: 'uA', local: LOCAL_B }), 'ok', 'las demás siguen');
  // Si nada la abre, se avisa (no se crea otra llave encima de los datos).
  await assert.rejects(make().unlockOnline({ teamKeyB64: K1, uid: 'uZ', local: LOCAL_A }), /No se pudieron abrir/);
});

test('motor cifrado: lo que se guarda o borra durante la primera conversión no se pisa ni revive', async () => {
  const inner = await idbBackend('s' + Math.random(), new IDBFactory());
  await inner.putMany('atenciones', [
    { id: 'a1', f: { plan: 'viejo' } },
    { id: 'a2', f: { plan: 'se borra' } },
    { id: 'a3', f: { plan: 'sin cambios' } },
  ]);
  const s = sealedBackend(inner);
  const converting = s.open(await pcKeys(D)); // la app sigue funcionando mientras tanto
  await s.backend.put('atenciones', { id: 'a1', f: { plan: 'nuevo' } });
  await s.backend.delete('atenciones', 'a2');
  assert.equal(await converting, 3);
  const all = await s.backend.getAll('atenciones');
  assert.deepEqual(all.map((d) => d.f.plan).sort(), ['nuevo', 'sin cambios']);
  assert.equal((await rawText(inner)).includes('viejo'), false);
});
