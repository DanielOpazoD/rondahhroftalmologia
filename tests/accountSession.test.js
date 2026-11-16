import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTeamKeys, tokenHash } from '../src/sync/crypto.js';
import { memoryBlobStore, createSyncHandler } from '../src/sync/server.js';
import { createAccounts } from '../src/sync/accounts.js';
import { createAccountsApi } from '../src/sync/accountsApi.js';
import { createAccountSession } from '../src/sync/accountSession.js';
import { createStore, memoryStorage } from '../src/storage/store.js';

const PASS = 'K7QM3-XRT9P-ZAWD4-N8F2C';
const RUT = '17.752.753-K';
const ITER = 100_000;

/**
 * Un servidor real en memoria y PCs que hablan con él (sin red): cada PC tiene
 * su almacenamiento, su sesión de pestaña y un interruptor de conexión.
 */
async function world() {
  const keys = await deriveTeamKeys(PASS);
  const clock = { t: Date.UTC(2026, 10, 15, 12) };
  const blobs = memoryBlobStore();
  const accounts = createAccounts({ store: blobs, secret: tokenHash(keys.token), now: () => clock.t });
  const sync = createSyncHandler({ store: blobs, tokenHash: tokenHash(keys.token), accounts, now: () => clock.t, authLimit: false });
  const pc = () => {
    const net = { online: true };
    const fetchFn = async (url, init) => {
      if (!net.online) throw new TypeError('Failed to fetch');
      return accounts.handler(new Request(`https://x${url}`, init));
    };
    const store = createStore(memoryStorage(), {});
    let tab = null;
    const needLogin = [];
    const session = createAccountSession({
      api: createAccountsApi({ fetchFn }),
      store,
      session: { get: () => tab, set: (v) => (tab = v) },
      now: () => clock.t,
      online: () => net.online,
      iterations: ITER,
      hooks: { needLogin: (m) => needLogin.push(m) },
    });
    return { store, session, net, needLogin, reloadTab: () => tab };
  };
  return { keys, clock, blobs, sync, pc };
}

test('sesión: activar, primer ingreso con cambio de clave, y la clave del equipo queda para sincronizar', async () => {
  const w = await world();
  const A = w.pc();
  A.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token });
  await A.session.activate({ rut: RUT, nombre: 'Dra. Admin', rol: 'medico' });
  assert.equal(A.session.on, true);

  // Un PC nuevo entra con el RUT sin dígito verificador: debe crear su clave.
  const B = w.pc();
  await assert.rejects(B.session.login(RUT, '17752754'), /incorrectos/);
  const r = await B.session.login('17752753-k', '17752753');
  assert.deepEqual(r, { status: 'change', nombre: 'Dra. Admin' });
  assert.equal(B.reloadTab(), null, 'sin clave nueva, la sesión de la pestaña no se guarda');
  await B.session.changePassword('Ojo2026');
  assert.ok(B.reloadTab()?.token);
  assert.equal(B.store.loadSyncConfig().encKey, w.keys.encKey, 'la clave del equipo llegó al PC');
  assert.equal(B.store.loadSyncConfig().mode, 'cuenta');
  assert.equal(B.session.user.admin, true);
  // La clave nueva sirve; la inicial ya no.
  const C = w.pc();
  await assert.rejects(C.session.login(RUT, '17752753'), /incorrectos/);
  assert.equal((await C.session.login(RUT, 'Ojo2026')).status, 'ok');
});

test('sesión: sin conexión entra con lo guardado en el PC; al volver, renueva sin pedir la clave', async () => {
  const w = await world();
  const A = w.pc();
  A.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token });
  await A.session.activate({ rut: RUT, nombre: 'Dra. Admin', rol: 'medico' });
  await A.session.login(RUT, '17752753');
  await A.session.changePassword('Ojo2026');
  await A.session.logout();
  assert.equal(A.session.user, null);

  // PC sin conexión: entra con lo guardado; una clave incorrecta no.
  A.net.online = false;
  await assert.rejects(A.session.login(RUT, 'Mala123'), /incorrectos/);
  assert.deepEqual(await A.session.login(RUT, 'Ojo2026'), { status: 'offline', nombre: 'Dra. Admin' });
  assert.equal(A.session.token(), null);
  A.session.event('ficha.ver', 'p_x');
  assert.equal(A.store.loadAccountEvents()[1].off, true, 'el evento queda marcado como sin conexión');
  // Un PC donde nunca entró no puede sin conexión.
  const N = w.pc();
  N.net.online = false;
  await assert.rejects(N.session.login(RUT, 'Ojo2026'), /primera vez/);

  // Vuelve la conexión: renueva la sesión y envía los eventos pendientes.
  A.net.online = true;
  assert.ok(await A.session.ensureToken());
  assert.equal(await A.session.flushEvents(), 2); // inicio sin conexión + ficha
  assert.deepEqual(A.store.loadAccountEvents(), []);
});

test('sesión: desbloquear con la clave, recuperar la pestaña y cuenta desactivada', async () => {
  const w = await world();
  const A = w.pc();
  A.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token });
  await A.session.activate({ rut: RUT, nombre: 'Dra. Admin', rol: 'medico' });
  await A.session.login(RUT, '17752753');
  await A.session.changePassword('Ojo2026');
  assert.equal(await A.session.verifyPassword('Mala123'), false);
  assert.equal(await A.session.verifyPassword('Ojo2026'), true);
  // Recargar la pestaña: la sesión se recupera.
  const tab = A.reloadTab();
  const A2 = createAccountSession({
    api: createAccountsApi({ fetchFn: async () => new Response('{}') }),
    store: A.store,
    session: { get: () => tab, set: () => {} },
    now: () => w.clock.t,
  });
  assert.equal(A2.restore(), true);
  assert.equal(A2.user.nombre, 'Dra. Admin');
  // Cuenta desactivada: se borra lo guardado para entrar sin conexión y se pide entrar.
  A.session.handleAuthError('cuenta_desactivada');
  assert.equal(A.session.user, null);
  assert.deepEqual(A.store.loadLocalAccounts(), {});
  assert.match(A.needLogin.at(-1), /desactivada/);
});

test('sesión: componentes del nombre sobreviven al cifrado, recarga y entrada sin conexión', async () => {
  const w = await world();
  const A = w.pc();
  const names = { apellido_paterno: 'Prueba', apellido_materno: 'Ficticio', nombres: 'Profesional' };
  A.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token });
  await A.session.activate({ rut: RUT, nombre: 'Nombre anterior', rol: 'medico', ...names });
  const B = w.pc();
  await B.session.login(RUT, '17752753');
  await B.session.changePassword('Ojo2026');
  assert.equal(B.session.user.nombre, 'Prueba Ficticio Profesional');
  for (const [k, v] of Object.entries(names)) assert.equal(B.session.user[k], v);
  const copy = createAccountSession({
    store: B.store,
    api: createAccountsApi(),
    session: { get: () => B.reloadTab(), set: () => {} },
    now: () => w.clock.t,
  });
  assert.equal(copy.restore(), true);
  assert.equal(copy.user.apellido_materno, 'Ficticio');
  await B.session.logout();
  B.net.online = false;
  await B.session.login(RUT, 'Ojo2026');
  assert.equal(B.session.user.nombres, 'Profesional');
});
