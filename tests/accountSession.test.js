import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTeamKeys, tokenHash } from '../src/sync/crypto.js';
import { memoryBlobStore, createSyncHandler } from '../src/sync/server.js';
import { createAccounts } from '../src/sync/accounts.js';
import { createAccountsApi } from '../src/sync/accountsApi.js';
import { createAccountSession } from '../src/sync/accountSession.js';
import { createStore, memoryStorage } from '../src/storage/store.js';
import { credentialsFor } from '../src/sync/accountCrypto.js';

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
    // `down`: el servidor responde con ese estado de error (el PC sí tiene conexión).
    const net = { online: true, down: 0, calls: [] };
    const fetchFn = async (url, init) => {
      net.calls.push(url);
      if (!net.online) throw new TypeError('Failed to fetch');
      if (net.down) return new Response(JSON.stringify({ error: 'Servidor caído', code: 'interno' }), { status: net.down });
      return accounts.handler(new Request(`https://x${url}`, init));
    };
    const store = createStore(memoryStorage(), {});
    let tab = null;
    const needLogin = [];
    const seen = { changed: 0, renewed: 0 };
    const session = createAccountSession({
      api: createAccountsApi({ fetchFn }),
      store,
      session: { get: () => tab, set: (v) => (tab = v) },
      now: () => clock.t,
      online: () => net.online,
      iterations: ITER,
      hooks: { needLogin: (m) => needLogin.push(m), changed: () => seen.changed++, renewed: () => seen.renewed++ },
    });
    return { store, session, net, needLogin, seen, reloadTab: () => tab, setTab: (v) => (tab = v) };
  };
  return { keys, clock, blobs, sync, pc, accounts };
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

/** PC con las cuentas activadas y la persona ya dentro con su clave personal. */
async function signedIn() {
  const w = await world();
  const A = w.pc();
  A.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token });
  await A.session.activate({ rut: RUT, nombre: 'Dra. Admin', rol: 'medico' });
  await A.session.login(RUT, '17752753');
  await A.session.changePassword('Ojo2026');
  A.net.calls.length = 0;
  return { w, A };
}

/** Espera a que se cumpla una condición (acciones que el código lanza sin esperar). */
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'la condición no se cumplió a tiempo');
}

test('sesión: RUT inválido o clave vacía se rechazan sin consultar al servidor', async () => {
  const w = await world();
  const A = w.pc();
  await assert.rejects(A.session.login('17.752.753-1', 'Ojo2026'), /dígito verificador/);
  await assert.rejects(A.session.login(RUT, ''), /Escribe tu clave/);
  assert.deepEqual(A.net.calls, []);
});

test('sesión: si el servidor responde con error (no es falta de conexión), no se entra con lo guardado en el PC', async () => {
  const { A } = await signedIn();
  await A.session.logout();
  A.net.down = 503;
  await assert.rejects(A.session.login(RUT, 'Ojo2026'), /Servidor caído/);
  assert.equal(A.session.user, null);
  assert.equal(A.reloadTab(), null);
});

test('sesión: cambiar la clave exige sesión en línea; cambiar «mi clave» verifica la actual en el servidor', async () => {
  const w = await world();
  const N = w.pc();
  await assert.rejects(N.session.changePassword('Nueva22'), /conexión/);
  await assert.rejects(N.session.changeMyPassword('Ojo2026', 'Nueva22'), /No hay sesión/);

  const { A, w: w2 } = await signedIn();
  // La regla «distinta de la actual» se revisa aquí: el servidor recibe la clave ya derivada con otra sal.
  const calls = A.net.calls.length;
  await assert.rejects(A.session.changeMyPassword('Ojo2026', 'Ojo2026'), /distinta de la actual/);
  assert.equal(A.net.calls.length, calls, 'se rechaza sin ir al servidor');
  await assert.rejects(A.session.changeMyPassword('Mala123', 'Nueva22'), /clave actual/);
  await A.session.changeMyPassword('Ojo2026', 'Nueva22');
  const B = w2.pc();
  await assert.rejects(B.session.login(RUT, 'Ojo2026'), /incorrectos/);
  assert.equal((await B.session.login(RUT, 'Nueva22')).status, 'ok');
  // Lo guardado para entrar sin conexión también quedó con la clave nueva.
  await A.session.logout();
  A.net.online = false;
  await assert.rejects(A.session.login(RUT, 'Ojo2026'), /incorrectos/);
  assert.equal((await A.session.login(RUT, 'Nueva22')).status, 'offline');
});

test('sesión: la pestaña no se recupera si falta, venció, no tiene token o es de una cuenta que no está en el PC', async () => {
  const { A, w } = await signedIn();
  const tab = A.reloadTab();
  const restoreWith = (saved) => {
    const s = createAccountSession({
      api: createAccountsApi({ fetchFn: async () => new Response('{}') }),
      store: A.store,
      session: { get: () => saved, set: () => {} },
      now: () => w.clock.t,
    });
    return [s.restore(), s.user];
  };
  assert.deepEqual(restoreWith(null), [false, null]);
  assert.deepEqual(restoreWith({ ...tab, uid: 'u0000000000000000' }), [false, null]);
  assert.deepEqual(restoreWith({ ...tab, exp: w.clock.t }), [false, null]);
  assert.deepEqual(restoreWith({ ...tab, token: 42 }), [false, null]);
  assert.equal(restoreWith(tab)[0], true, 'control: la pestaña válida sí se recupera');
});

test('sesión: salir sin poder avisar al servidor igual cierra la sesión en el PC', async () => {
  const { A } = await signedIn();
  A.net.online = false;
  await A.session.logout('inactividad');
  assert.equal(A.session.user, null);
  assert.equal(A.session.token(), null);
  assert.equal(A.reloadTab(), null);
  // Una sesión que empezó sin conexión: el fin queda en la cola del registro de accesos.
  await A.session.login(RUT, 'Ojo2026');
  await A.session.logout();
  assert.deepEqual(
    A.store.loadAccountEvents().map((e) => [e.ev, e.off]),
    [
      ['sesion.inicio_local', true],
      ['sesion.fin_local', true],
    ],
  );
});

test('sesión: ensureToken usa el token vigente sin red y, sin sesión, no intenta renovar', async () => {
  const { A } = await signedIn();
  const tok = A.session.token();
  assert.ok(tok);
  assert.equal(await A.session.ensureToken(), tok);
  assert.equal(await A.session.requireToken(), tok);
  assert.deepEqual(A.net.calls, [], 'token vigente: no consulta al servidor');
  const N = (await world()).pc();
  assert.equal(await N.session.ensureToken(), null);
  await assert.rejects(N.session.requireToken(), /conexión a internet/);
  N.session.markOn();
  await N.session.logout();
  assert.deepEqual(N.store.loadAccountEvents(), [], 'salir sin nadie dentro no registra nada');
  assert.deepEqual(N.net.calls, []);
});

test('sesión: al vencer, se renueva sola (y avisa); sin conexión devuelve null sin pedir entrar', async () => {
  const { A, w } = await signedIn();
  const old = A.session.token();
  w.clock.t += 13 * 3600_000;
  assert.equal(A.session.token(), null, 'vencida');
  A.net.online = false;
  assert.equal(await A.session.ensureToken(), null);
  assert.deepEqual(A.needLogin, [], 'sin conexión no se molesta a la persona');
  A.net.online = true;
  const fresh = await A.session.ensureToken();
  assert.ok(fresh && fresh !== old);
  assert.equal(A.seen.changed, 1);
  assert.equal(A.reloadTab().token, fresh, 'la pestaña guarda el token nuevo');
});

test('sesión: si un administrador restableció la clave, renovar no entra y pide volver a entrar', async () => {
  const { A, w } = await signedIn();
  // Otra cuenta administradora restablece la clave de A (con la API real).
  const uid = A.session.user.id;
  const admin = await w.accounts.handler(
    new Request('https://x/api/cuentas/preparar', {
      method: 'POST',
      headers: { authorization: `Bearer ${A.session.token()}` },
      body: JSON.stringify({ id: uid, existente: true }),
    }),
  );
  const { complemento } = await admin.json();
  const c = await credentialsFor({ password: '17752753', teamKeyB64: w.keys.encKey, uid, complemento, iterations: ITER });
  const res = await w.accounts.handler(
    new Request('https://x/api/cuentas/restablecer', {
      method: 'POST',
      headers: { authorization: `Bearer ${A.session.token()}` },
      body: JSON.stringify({ id: uid, ...c }),
    }),
  );
  assert.equal(res.status, 200);
  // El acceso en memoria es el de la clave anterior: la renovación falla (credenciales) y se pide entrar.
  w.clock.t += 13 * 3600_000;
  assert.equal(await A.session.ensureToken(), null);
  assert.match(A.needLogin.at(-1), /terminó/);
  assert.equal(A.session.user, null);
});

test('sesión: renovar una cuenta que aún debe cambiar su clave no entra y lo avisa', async () => {
  const w = await world();
  const A = w.pc();
  A.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token });
  await A.session.activate({ rut: RUT, nombre: 'Dra. Admin', rol: 'medico' });
  assert.equal((await A.session.login(RUT, '17752753')).status, 'change');
  w.clock.t += 13 * 3600_000;
  assert.equal(await A.session.ensureToken(), null);
  assert.match(A.needLogin.at(-1), /restablecida/);
});

test('sesión: avisos del servidor — cambiar clave, sesión vencida (renueva sin molestar), credenciales, desconocidos', async () => {
  const { A, w } = await signedIn();
  A.session.handleAuthError('debe_cambiar_clave');
  assert.match(A.needLogin.at(-1), /crea tu clave/);
  A.session.handleAuthError('otro_codigo');
  assert.equal(A.needLogin.length, 1, 'un código desconocido no hace nada');
  assert.ok(A.session.user);

  // Sesión vencida en el servidor: se renueva en segundo plano con el acceso en memoria.
  w.clock.t += 13 * 3600_000;
  A.session.handleAuthError('sesion_invalida');
  await until(() => A.seen.renewed === 1);
  assert.ok(A.session.token());
  assert.equal(A.needLogin.length, 1);

  // Si la renovación falla, se pide entrar.
  w.clock.t += 13 * 3600_000;
  A.net.down = 500;
  A.session.handleAuthError('sesion_invalida');
  await until(() => A.needLogin.length === 2);
  assert.match(A.needLogin.at(-1), /terminó/);
  assert.equal(A.session.user, null);
});

test('sesión: «credenciales» no reintenta con el acceso en memoria; sin persona, pide entrar y marca las cuentas activas', async () => {
  const { A } = await signedIn();
  A.session.handleAuthError('credenciales');
  assert.equal(A.session.user, null);
  assert.match(A.needLogin.at(-1), /terminó/);
  assert.deepEqual(A.net.calls, [], 'no intentó renovar');

  // Un PC con la contraseña del equipo (sin cuentas conocidas) recibe el aviso.
  const w = await world();
  const P = w.pc();
  assert.equal(P.session.on, false);
  P.session.handleAuthError('cuentas_inactivas');
  assert.equal(P.session.on, true);
  assert.equal(P.store.loadAccountsOn(), true, 'queda guardado');
  assert.match(P.needLogin.at(-1), /entra con tu RUT/);
});

test('sesión: verificar la clave sin sesión o con clave vacía es falso', async () => {
  const w = await world();
  assert.equal(await w.pc().session.verifyPassword('Ojo2026'), false);
  const { A } = await signedIn();
  assert.equal(await A.session.verifyPassword(''), false);
});

test('registro de accesos: sin cuentas activadas o sin persona no se anota nada', async () => {
  const w = await world();
  const P = w.pc();
  P.session.event('ficha.ver', 'p_x');
  assert.deepEqual(P.store.loadAccountEvents(), [], 'cuentas no activadas');
  P.session.markOn();
  P.session.event('ficha.ver', 'p_x');
  assert.deepEqual(P.store.loadAccountEvents(), [], 'nadie dentro');
  const { A } = await signedIn();
  A.session.event('exportar.excel', undefined, { n: 3 });
  const [e] = A.store.loadAccountEvents();
  assert.deepEqual(e, { ev: 'exportar.excel', n: 3, at: e.at }, 'sin obj ni marca de sin conexión');
});

test('registro de accesos: los eventos quedan en el PC si no hay conexión, si no hay nada o si el servidor falla', async () => {
  const { A, w } = await signedIn();
  assert.equal(await A.session.flushEvents(), 0, 'nada pendiente');
  A.session.event('ficha.ver', 'p_1');
  A.net.down = 500;
  assert.equal(await A.session.flushEvents(), 0);
  assert.equal(A.store.loadAccountEvents().length, 1, 'se reintentará');
  A.net.down = 0;
  w.clock.t += 13 * 3600_000;
  A.net.online = false;
  A.net.calls.length = 0;
  assert.equal(await A.session.flushEvents(), 0);
  assert.deepEqual(A.net.calls, [], 'sin conexión ni siquiera intenta renovar');
  A.net.online = true;
  assert.equal(await A.session.flushEvents(), 1);
  assert.deepEqual(A.store.loadAccountEvents(), []);
});

test('activar las cuentas exige un PC con la contraseña del equipo', async () => {
  const w = await world();
  const P = w.pc();
  await assert.rejects(P.session.activate({ rut: RUT, nombre: 'X', rol: 'medico' }), /contraseña del equipo/);
  P.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token, mode: 'cuenta' });
  await assert.rejects(P.session.activate({ rut: RUT, nombre: 'X', rol: 'medico' }), /contraseña del equipo/);
  assert.equal(P.session.on, false);
});

test('sesión: con los datos del PC cifrados, entrar abre la llave, recargar pide la clave y cambiarla rehace el estuche', async () => {
  const w = await world();
  const A = w.pc();
  A.store.saveSyncConfig({ encKey: w.keys.encKey, token: w.keys.token });
  await A.session.activate({ rut: RUT, nombre: 'Dra. Admin', rol: 'medico' });
  await A.session.login(RUT, '17752753');
  await A.session.changePassword('Ojo2026');
  // Un PC con su llave (ADR 0016), simulada: registra lo que la sesión le pide.
  const calls = [];
  const vault = {
    state: 'locked',
    unlockOnline: async (o) => {
      calls.push(['online', o.uid, o.teamKeyB64 === w.keys.encKey]);
      vault.state = 'open';
    },
    unlockOffline: async (o) => (calls.push(['offline', o.uid]), vault.answer),
    rewrap: async (o) => calls.push(['rewrap', o.uid]),
    forget: (o) => calls.push(['forget', o.uid ?? o.keep]),
  };
  const B = w.pc();
  let tab = null;
  const net = { online: true };
  const fetchFn = async (url, init) => {
    if (!net.online) throw new TypeError('Failed to fetch');
    if (net.deactivated && url.includes('entrar')) {
      return new Response(JSON.stringify({ error: 'Cuenta desactivada', code: 'cuenta_desactivada' }), { status: 403 });
    }
    return w.accounts.handler(new Request(`https://x${url}`, init));
  };
  const session = createAccountSession({
    api: createAccountsApi({ fetchFn }),
    store: B.store,
    session: { get: () => tab, set: (v) => (tab = v) },
    now: () => w.clock.t,
    iterations: ITER,
    vault,
  });
  assert.equal((await session.login(RUT, 'Ojo2026')).status, 'ok');
  assert.deepEqual(calls.shift(), ['online', session.user.id, true], 'se abre con la clave del equipo, antes de guardar nada');
  assert.deepEqual(calls.shift(), ['forget', [session.user.id]], 'quedan solo los estuches de cuentas de este PC');
  // Recargar: con la llave cerrada, la sesión de la pestaña no basta.
  vault.state = 'locked';
  assert.equal(session.restore(), false);
  // Sin conexión, la clave se comprueba abriendo el estuche.
  await session.logout();
  net.online = false;
  vault.answer = 'wrong';
  await assert.rejects(session.login(RUT, 'Ojo2026'), /incorrectos/);
  vault.answer = 'missing';
  await assert.rejects(session.login(RUT, 'Ojo2026'), /entra una vez con conexión/);
  vault.answer = 'ok';
  assert.equal((await session.login(RUT, 'Ojo2026')).status, 'offline');
  // Cambiar la clave rehace el estuche de la cuenta.
  net.online = true;
  vault.state = 'open';
  await session.logout();
  await session.login(RUT, 'Ojo2026');
  calls.length = 0;
  await session.changeMyPassword('Ojo2026', 'Nueva22');
  assert.deepEqual(calls.at(-1), ['rewrap', session.user.id]);
  // Cuenta desactivada: en la sesión o al intentar entrar, se olvida su estuche.
  const uid = session.user.id;
  calls.length = 0;
  session.handleAuthError('cuenta_desactivada');
  assert.deepEqual(calls, [['forget', uid]]);
  // Vuelve a entrar en este PC; después la desactivan y lo intenta de nuevo.
  await session.login(RUT, 'Nueva22');
  await session.logout();
  calls.length = 0;
  net.deactivated = true;
  await assert.rejects(session.login(RUT, 'Nueva22'));
  assert.deepEqual(calls, [['forget', uid]]);
});
