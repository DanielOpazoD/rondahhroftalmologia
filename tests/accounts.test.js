import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTeamKeys, tokenHash, importEncKey, encryptPayload } from '../src/sync/crypto.js';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import { createAccounts } from '../src/sync/accounts.js';
import { credentialsFor, deriveAccountSecrets, unwrapTeamKey, encryptProfile, decryptProfile } from '../src/sync/accountCrypto.js';
import {
  passwordProblem,
  rutBody,
  initialPassword,
  accountRut,
  newUserId,
  loginState,
  USER_ID_RE,
  ACCOUNT_LOCK,
} from '../src/core/accounts.js';
import { can, PERMISSIONS } from '../src/core/permissions.js';
import { hmacSha256, toHex } from '../src/lib/sha256.js';

const PASS = 'K7QM3-XRT9P-ZAWD4-N8F2C';
const ITER = 100_000; // mínimo que acepta el servidor (rápido en las pruebas)
const ADMIN_RUT = '17.752.753-K';
const DAY = 24 * 3600_000;

describe('reglas de cuentas', () => {
  test('clave inicial = RUT sin dígito verificador; reglas de la clave nueva', () => {
    assert.equal(rutBody('17.752.753-K'), '17752753');
    assert.equal(initialPassword('07.752.753-k'), '7752753');
    assert.equal(accountRut('17752753k'), '17752753-K');
    assert.equal(accountRut('17.752.753-1'), '', 'RUT con dígito verificador inválido');
    assert.match(passwordProblem('Ab1'), /6 caracteres/);
    assert.match(passwordProblem('abcdef1'), /mayúscula/);
    assert.match(passwordProblem('Abcdefg'), /número/);
    assert.equal(passwordProblem('Ojo2026'), null);
    assert.match(passwordProblem('Ojo2026', { current: 'Ojo2026' }), /distinta de la actual/);
    assert.equal(passwordProblem('Ojo2027', { current: 'Ojo2026' }), null);
    assert.equal(passwordProblem('Ñandu7'), null, 'la Ñ cuenta como mayúscula');
    assert.match(passwordProblem('17752753', { rut: ADMIN_RUT }), /mayúscula/);
    assert.equal(passwordProblem('Clave1', { rut: ADMIN_RUT }), null);
    assert.match(newUserId(), USER_ID_RE);
    assert.equal(loginState({ estado: 'activo', debeCambiar: true, tempExpira: 10 }, 20), 'clave_inicial_vencida');
    assert.equal(loginState({ estado: 'activo', bloqueadaHasta: 30 }, 20), 'bloqueada');
    assert.equal(loginState({ estado: 'desactivado' }, 20), 'desactivada');
  });

  test('permisos: clínicos editan, administrativos ven e ingresan, administradores gestionan', () => {
    const medico = { rol: 'medico', admin: false };
    const adm = { rol: 'administrativo', admin: false };
    const admin = { rol: 'administrativo', admin: true };
    assert.ok(can(medico, PERMISSIONS.EDITAR_CLINICO) && !can(medico, PERMISSIONS.USUARIOS));
    assert.ok(can(adm, PERMISSIONS.VER) && can(adm, PERMISSIONS.INGRESO) && !can(adm, PERMISSIONS.EDITAR_CLINICO));
    assert.ok(can(admin, PERMISSIONS.USUARIOS) && can(admin, PERMISSIONS.AJUSTES) && !can(admin, PERMISSIONS.EDITAR_CLINICO));
    assert.ok(can(null, PERMISSIONS.EDITAR_CLINICO), 'sin cuentas activadas, todo permitido (como antes)');
    assert.equal(can(medico, 'inventado'), false);
  });
});

/** Servidor de pruebas: sincronización y cuentas sobre el mismo almacén, con reloj controlable. */
async function setup() {
  const keys = await deriveTeamKeys(PASS);
  const secret = tokenHash(keys.token);
  const store = memoryBlobStore();
  const clock = { t: Date.UTC(2026, 10, 15, 12) };
  const now = () => clock.t;
  const accounts = createAccounts({ store, secret, now });
  const sync = createSyncHandler({ store, tokenHash: secret, accounts, now, authLimit: false });
  const call = async (path, { method = 'POST', body, token } = {}) => {
    const handler = path.startsWith('sync/') ? sync : accounts.handler;
    const res = await handler(
      new Request(`https://x/api/${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  const teamKey = await importEncKey(keys.encKey);
  /** Datos de una cuenta nueva con su clave inicial, calculados como en el PC. */
  const newAccount = async ({ rut, nombre, rol, admin = false, complemento, uid }) => ({
    id: uid,
    rut,
    rol,
    admin,
    perfil: await encryptProfile(teamKey, uid, { nombre, rut, rol }),
    ...(await credentialsFor({ password: initialPassword(rut), teamKeyB64: keys.encKey, uid, complemento, iterations: ITER })),
  });
  /** Entra como lo hace el PC: pide la sal, deriva y envía `acceso`. */
  const login = async (rut, password) => {
    const { body: s } = await call('cuentas/sal', { body: { rut } });
    const sec = await deriveAccountSecrets(password, s.sal, s.iter);
    const r = await call('cuentas/entrar', { body: { rut, acceso: sec.acceso } });
    return { ...r, sec };
  };
  /** Cambia la clave con la sesión dada. */
  const changePassword = async (token, uid, complemento, password, accesoActual) => {
    const c = await credentialsFor({ password, teamKeyB64: keys.encKey, uid, complemento, iterations: ITER });
    return call('cuentas/clave', { token, body: { ...c, ...(accesoActual ? { accesoActual } : {}) } });
  };
  return { keys, secret, accounts, store, clock, call, newAccount, login, changePassword, teamKey };
}

/** Activa las cuentas con un primer administrador y deja su clave cambiada. */
async function activated() {
  const env = await setup();
  const uid = newUserId();
  const { body: prep } = await env.call('cuentas/preparar', { token: env.keys.token, body: { id: uid } });
  const usuario = await env.newAccount({ rut: ADMIN_RUT, nombre: 'Dra. Admin Prueba', rol: 'medico', complemento: prep.complemento, uid });
  const act = await env.call('cuentas/activar', { token: env.keys.token, body: { usuario } });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  const first = await env.login(ADMIN_RUT, '17752753');
  assert.equal(first.status, 200);
  const changed = await env.changePassword(first.body.token, uid, first.body.usuario.complemento, 'Ojo2026');
  assert.equal(changed.status, 200);
  return { ...env, adminId: uid, adminToken: changed.body.token };
}

describe('servidor de cuentas', () => {
  test('activación: el primer administrador entra con su RUT, abre la clave del equipo y debe cambiar la clave', async () => {
    const env = await setup();
    assert.deepEqual((await env.call('cuentas/estado', { method: 'GET' })).body, { activas: false });
    // Antes de activar: la contraseña del equipo sincroniza como siempre.
    assert.equal((await env.call('sync/list', { method: 'GET', token: env.keys.token })).status, 200);
    // Preparar y activar exigen la contraseña del equipo.
    const uid = newUserId();
    assert.equal((await env.call('cuentas/preparar', { body: { id: uid } })).status, 401);
    const { body: prep } = await env.call('cuentas/preparar', { token: env.keys.token, body: { id: uid } });
    const usuario = await env.newAccount({
      rut: ADMIN_RUT,
      nombre: 'Dra. Admin Prueba',
      rol: 'medico',
      complemento: prep.complemento,
      uid,
    });
    assert.equal((await env.call('cuentas/activar', { token: 'otra', body: { usuario } })).status, 401);
    assert.equal((await env.call('cuentas/activar', { token: env.keys.token, body: { usuario } })).status, 200);
    assert.equal((await env.call('cuentas/activar', { token: env.keys.token, body: { usuario } })).status, 409, 'solo una vez');
    assert.deepEqual((await env.call('cuentas/estado', { method: 'GET' })).body, { activas: true });

    // Desde ahora la contraseña del equipo ya no sincroniza.
    const legacy = await env.call('sync/list', { method: 'GET', token: env.keys.token });
    assert.equal(legacy.status, 401);
    assert.equal(legacy.body.code, 'sesion_invalida');

    // Primer ingreso con el RUT sin dígito verificador.
    assert.equal((await env.login(ADMIN_RUT, '17752754')).status, 401);
    const r = await env.login('17752753-k', '17752753');
    assert.equal(r.status, 200);
    const u = r.body.usuario;
    assert.equal(u.debeCambiar, true);
    assert.equal(u.admin, true);
    // El PC abre la clave del equipo y el perfil.
    const k = await unwrapTeamKey(u.envuelta, { envoltura: r.sec.envoltura, complemento: u.complemento, uid });
    assert.equal(k, env.keys.encKey);
    assert.deepEqual(await decryptProfile(env.teamKey, uid, u.perfil), { nombre: 'Dra. Admin Prueba', rut: ADMIN_RUT, rol: 'medico' });
    // Sin cambiar la clave: no sincroniza ni registra eventos.
    assert.equal((await env.call('sync/list', { method: 'GET', token: r.body.token })).body.code, 'debe_cambiar_clave');
    assert.equal((await env.call('cuentas/eventos', { token: r.body.token, body: { eventos: [] } })).status, 403);
    // Cambio de clave: ahora sincroniza, y la clave inicial deja de servir.
    const c = await env.changePassword(r.body.token, uid, u.complemento, 'Ojo2026');
    assert.equal(c.status, 200);
    assert.equal((await env.call('sync/list', { method: 'GET', token: c.body.token })).status, 200);
    assert.equal((await env.login(ADMIN_RUT, '17752753')).status, 401);
    const again = await env.login(ADMIN_RUT, 'Ojo2026');
    assert.equal(again.body.usuario.debeCambiar, false);
    assert.equal(
      await unwrapTeamKey(again.body.usuario.envuelta, {
        envoltura: again.sec.envoltura,
        complemento: again.body.usuario.complemento,
        uid,
      }),
      env.keys.encKey,
    );
  });

  test('el servidor no guarda RUT, nombres ni claves en claro', async () => {
    const env = await activated();
    const all = JSON.stringify([...env.store._map.entries()]);
    for (const s of ['17752753', 'Admin Prueba', 'Ojo2026', env.keys.encKey]) assert.equal(all.includes(s), false, s);
  });

  test('cambio de clave fuera del primer ingreso: exige la actual', async () => {
    const env = await activated();
    const { body: me } = await env.login(ADMIN_RUT, 'Ojo2026');
    const comp = me.usuario.complemento;
    assert.equal((await env.changePassword(me.token, env.adminId, comp, 'Nueva22')).status, 401);
    const wrongCurrent = await deriveAccountSecrets(
      'Malo123',
      (await env.call('cuentas/sal', { body: { rut: ADMIN_RUT } })).body.sal,
      ITER,
    );
    assert.equal((await env.changePassword(me.token, env.adminId, comp, 'Nueva22', wrongCurrent.acceso)).status, 401);
    const cur = await env.login(ADMIN_RUT, 'Ojo2026');
    assert.equal((await env.changePassword(me.token, env.adminId, comp, 'Nueva22', cur.sec.acceso)).status, 200);
    assert.equal((await env.login(ADMIN_RUT, 'Nueva22')).status, 200);
  });

  test('bloqueo: 5 intentos fallidos bloquean la cuenta 15 min; la sal no revela si un RUT tiene cuenta', async () => {
    const env = await activated();
    for (let i = 0; i < 4; i++) assert.equal((await env.login(ADMIN_RUT, 'Malo' + i)).status, 401);
    const fifth = await env.login(ADMIN_RUT, 'Malo9');
    assert.equal(fifth.status, 401);
    const blocked = await env.login(ADMIN_RUT, 'Ojo2026');
    assert.equal(blocked.status, 423, 'ni con la clave correcta mientras dura el bloqueo');
    env.clock.t += 16 * 60_000;
    assert.equal((await env.login(ADMIN_RUT, 'Ojo2026')).status, 200);
    // Sal de un RUT sin cuenta: estable y con la misma forma.
    const a = await env.call('cuentas/sal', { body: { rut: '11.111.111-1' } });
    const b = await env.call('cuentas/sal', { body: { rut: '11.111.111-1' } });
    assert.equal(a.body.sal, b.body.sal);
    assert.equal(a.body.sal.length, 24);
    assert.equal((await env.login('11.111.111-1', '11111111')).status, 401);
  });

  test('administración: crear, RUT único, permisos, último administrador, desactivar corta la sesión', async () => {
    const env = await activated();
    const uid = newUserId();
    const { body: prep } = await env.call('cuentas/preparar', { token: env.adminToken, body: { id: uid } });
    const acc = await env.newAccount({
      rut: '11.111.111-1',
      nombre: 'Ana Admisión',
      rol: 'administrativo',
      complemento: prep.complemento,
      uid,
    });
    const created = await env.call('cuentas/crear', { token: env.adminToken, body: acc });
    assert.equal(created.status, 200);
    assert.equal(created.body.usuario.debeCambiar, true);
    assert.equal(created.body.usuario.verificador, undefined, 'sin secretos en la respuesta');
    // RUT repetido.
    const uid2 = newUserId();
    const { body: prep2 } = await env.call('cuentas/preparar', { token: env.adminToken, body: { id: uid2 } });
    const dup = await env.newAccount({ rut: '11111111-1', nombre: 'Otra', rol: 'medico', complemento: prep2.complemento, uid: uid2 });
    assert.equal((await env.call('cuentas/crear', { token: env.adminToken, body: dup })).status, 409);

    // La administrativa entra, cambia su clave y sincroniza; no puede administrar.
    const first = await env.login('11.111.111-1', '11111111');
    const c = await env.changePassword(first.body.token, uid, first.body.usuario.complemento, 'Admis1');
    const tok = c.body.token;
    assert.equal((await env.call('sync/list', { method: 'GET', token: tok })).status, 200);
    assert.equal((await env.call('cuentas/usuarios', { method: 'GET', token: tok })).status, 403);
    assert.equal((await env.call('cuentas/crear', { token: tok, body: dup })).status, 403);

    // Siempre queda un administrador activo.
    const solo = await env.call('cuentas/editar', { token: env.adminToken, body: { id: env.adminId, admin: false } });
    assert.equal(solo.status, 409);
    assert.equal(solo.body.code, 'ultimo_admin');
    assert.equal(
      (await env.call('cuentas/editar', { token: env.adminToken, body: { id: env.adminId, estado: 'desactivado' } })).status,
      409,
    );
    // Con un segundo administrador, sí.
    assert.equal((await env.call('cuentas/editar', { token: env.adminToken, body: { id: uid, admin: true } })).status, 200);
    assert.equal((await env.call('cuentas/editar', { token: env.adminToken, body: { id: uid, admin: false } })).status, 200);

    // Desactivar: su sesión deja de servir de inmediato y no puede volver a entrar.
    assert.equal((await env.call('cuentas/editar', { token: env.adminToken, body: { id: uid, estado: 'desactivado' } })).status, 200);
    const cut = await env.call('sync/list', { method: 'GET', token: tok });
    assert.equal(cut.status, 403);
    assert.equal(cut.body.code, 'cuenta_desactivada', 'la persona sabe por qué');
    assert.equal((await env.login('11.111.111-1', 'Admis1')).body.code, 'cuenta_desactivada');
    const list = (await env.call('cuentas/usuarios', { method: 'GET', token: env.adminToken })).body.usuarios;
    assert.deepEqual(list.map((u) => [u.id === env.adminId, u.estado]).sort(), [
      [false, 'desactivado'],
      [true, 'activo'],
    ]);
  });

  test('clave inicial: vence a los 7 días; restablecer da otra y cierra las sesiones', async () => {
    const env = await activated();
    const uid = newUserId();
    const { body: prep } = await env.call('cuentas/preparar', { token: env.adminToken, body: { id: uid } });
    await env.call('cuentas/crear', {
      token: env.adminToken,
      body: await env.newAccount({ rut: '11.111.111-1', nombre: 'Luis Tardío', rol: 'medico', complemento: prep.complemento, uid }),
    });
    env.clock.t += 8 * DAY;
    const late = await env.login('11.111.111-1', '11111111');
    assert.equal(late.status, 403);
    assert.equal(late.body.code, 'clave_inicial_vencida');
    // El administrador la restablece (su sesión dura 12 h: entra de nuevo).
    const adminTok = (await env.login(ADMIN_RUT, 'Ojo2026')).body.token;
    // El complemento de una cuenta existente se pide con `existente` (y solo para cuentas que existen).
    assert.equal((await env.call('cuentas/preparar', { token: adminTok, body: { id: uid } })).status, 400);
    assert.equal((await env.call('cuentas/preparar', { token: adminTok, body: { id: newUserId(), existente: true } })).status, 400);
    const again = await env.call('cuentas/preparar', { token: adminTok, body: { id: uid, existente: true } });
    assert.equal(again.body.complemento, prep.complemento);
    const c = await credentialsFor({
      password: '11111111',
      teamKeyB64: env.keys.encKey,
      uid,
      complemento: again.body.complemento,
      iterations: ITER,
    });
    assert.equal((await env.call('cuentas/restablecer', { token: adminTok, body: { id: uid, ...c } })).status, 200);
    assert.equal((await env.login('11.111.111-1', '11111111')).status, 200);
  });

  test('sesión: token alterado o vencido no sirve; salir la cierra', async () => {
    const env = await activated();
    const tok = env.adminToken;
    const tampered = tok.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    assert.equal((await env.call('sync/list', { method: 'GET', token: tampered })).status, 401);
    assert.equal((await env.call('cuentas/salir', { token: tok, body: { motivo: 'salir' } })).status, 200);
    assert.equal((await env.call('sync/list', { method: 'GET', token: tok })).status, 401, 'sesión cerrada');
    const fresh = (await env.login(ADMIN_RUT, 'Ojo2026')).body.token;
    env.clock.t += 13 * 3600_000;
    assert.equal((await env.call('sync/list', { method: 'GET', token: fresh })).status, 401, 'vencida a las 12 h');
  });

  test('registro de accesos: lo escribe el servidor con usuario y sesión; solo administradores lo leen', async () => {
    const env = await activated();
    const tok = env.adminToken;
    // Una escritura sincronizada queda atribuida a la sesión.
    const payload = await encryptPayload(env.teamKey, 'a1', 1000, { x: 1 });
    const put = await env.call('sync/put', { token: tok, body: { items: [{ id: 'a1', u: 1000, ...payload }] } });
    assert.deepEqual(put.body.saved, ['a1']);
    // Eventos que informa la app: solo los permitidos; usuario y hora los pone el servidor.
    const ev = await env.call('cuentas/eventos', {
      token: tok,
      body: {
        eventos: [
          { ev: 'atencion.ver', obj: 'a1' },
          { ev: 'ficha.ver', obj: 'p_abc', at: env.clock.t - 60_000, off: true },
          { ev: 'usuario.crear', obj: 'x' }, // solo lo registra el servidor
          { ev: 'atencion.ver', obj: '<script>' },
        ],
      },
    });
    assert.equal(ev.body.registrados, 2);
    await env.login(ADMIN_RUT, 'Malo1');
    const day = new Date(env.clock.t).toISOString().slice(0, 10);
    const r = await env.call(`cuentas/auditoria?desde=${day}&hasta=${day}`, { method: 'GET', token: tok });
    assert.equal(r.status, 200);
    const evs = r.body.eventos.map((e) => e.ev);
    for (const e of [
      'cuentas.activar',
      'usuario.crear',
      'sesion.inicio',
      'sesion.clave',
      'sync.escribir',
      'atencion.ver',
      'ficha.ver',
      'sesion.fallida',
    ]) {
      assert.ok(evs.includes(e), e);
    }
    assert.equal(evs.filter((e) => e === 'usuario.crear').length, 1, 'la app no puede registrar eventos de administración');
    const w = r.body.eventos.find((e) => e.ev === 'sync.escribir');
    assert.equal(w.u, env.adminId);
    assert.equal(w.n, 1);
    const off = r.body.eventos.find((e) => e.ev === 'ficha.ver');
    assert.equal(off.off, true);
    assert.equal(off.u, env.adminId);
    assert.ok(r.body.sesiones.some((s) => s.uid === env.adminId && s.inicio));
    // Rango demasiado grande.
    assert.equal((await env.call(`cuentas/auditoria?desde=2026-01-01&hasta=${day}`, { method: 'GET', token: tok })).status, 400);
  });
});

test('recuperar un administrador con la contraseña del equipo (script de operación)', async () => {
  const env = await activated();
  const accounts = createAccounts({ store: env.store, secret: tokenHash(env.keys.token), now: () => env.clock.t });
  const creds = (rut) => (uid, complemento) =>
    credentialsFor({ password: initialPassword(rut), teamKeyB64: env.keys.encKey, uid, complemento, iterations: ITER });
  // La cuenta existente vuelve a la clave inicial, como administradora activa.
  assert.equal((await env.login(ADMIN_RUT, 'Olvidada1')).status, 401);
  const r = await accounts.recoverAdmin({ rut: ADMIN_RUT, credentials: creds(ADMIN_RUT) });
  assert.deepEqual(r, { uid: env.adminId, creada: false });
  const back = await env.login(ADMIN_RUT, '17752753');
  assert.equal(back.status, 200);
  assert.equal(back.body.usuario.debeCambiar, true);
  assert.equal(back.body.usuario.admin, true);
  // Un RUT sin cuenta: se crea (con nombre) como administrador.
  await assert.rejects(accounts.recoverAdmin({ rut: '11.111.111-1', credentials: creds('11.111.111-1') }), /nombre/);
  const n = await accounts.recoverAdmin({
    rut: '11.111.111-1',
    credentials: creds('11.111.111-1'),
    perfil: (uid) => encryptProfile(env.teamKey, uid, { nombre: 'Nuevo Admin', rut: '11111111-1', rol: 'medico' }),
  });
  assert.equal(n.creada, true);
  assert.equal((await env.login('11.111.111-1', '11111111')).body.usuario.admin, true);
});

test('registro de accesos: el rango es de hora local (de tarde en Rapa Nui ya es otro día UTC)', async () => {
  const env = await activated();
  // 19:30 en Rapa Nui (UTC-5) = 00:30 del día siguiente en UTC.
  env.clock.t = Date.UTC(2026, 10, 17, 0, 30);
  const token = (await env.login(ADMIN_RUT, 'Ojo2026')).body.token;
  await env.call('cuentas/eventos', { token, body: { eventos: [{ ev: 'ficha.ver', obj: 'p_tarde' }] } });
  // El PC pide su día local: 16-11 de 00:00 a 23:59:59 en UTC-5.
  const from = Date.UTC(2026, 10, 16, 5);
  const to = Date.UTC(2026, 10, 17, 4, 59, 59, 999);
  const r = await env.call(`cuentas/auditoria?desde=${from}&hasta=${to}`, { method: 'GET', token });
  assert.equal(r.status, 200);
  assert.ok(
    r.body.eventos.some((e) => e.obj === 'p_tarde'),
    'el evento de la tarde aparece en su día local',
  );
  // Y no aparece en el día local siguiente.
  const next = await env.call(`cuentas/auditoria?desde=${to + 1}&hasta=${to + 24 * 3600_000}`, { method: 'GET', token });
  assert.equal(
    next.body.eventos.some((e) => e.obj === 'p_tarde'),
    false,
  );
});

/* ------------------------------------------------------------------ */
/* Control de acceso, validación y errores del servidor de cuentas.   */
/* ------------------------------------------------------------------ */

/** Solicitud cruda al servidor de cuentas (método, cuerpo y cabeceras a elección). */
async function raw(env, path, { method = 'POST', body, headers = {} } = {}) {
  const res = await env.accounts.handler(new Request(`https://x/api/${path}`, { method, headers, body }));
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/** Cuenta nueva creada por el administrador; con `password`, ya con su clave cambiada. */
async function addUser(env, { rut, rol = 'medico', admin = false, password }) {
  const uid = newUserId();
  const { body: prep } = await env.call('cuentas/preparar', { token: env.adminToken, body: { id: uid } });
  const acc = await env.newAccount({ rut, nombre: 'Persona Prueba', rol, admin, complemento: prep.complemento, uid });
  const created = await env.call('cuentas/crear', { token: env.adminToken, body: acc });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const first = await env.login(rut, initialPassword(rut));
  assert.equal(first.status, 200);
  if (!password) return { uid, acc, token: first.body.token };
  const c = await env.changePassword(first.body.token, uid, first.body.usuario.complemento, password);
  assert.equal(c.status, 200);
  return { uid, acc, token: c.body.token };
}

/** Contenido (sin verificar) de un token de sesión. */
const tokenPayload = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
/** Token firmado con el secreto del servidor, con el contenido que se quiera. */
const signedToken = (secret, text) => {
  const body = Buffer.from(text).toString('base64url');
  return `s1.${body}.${toHex(hmacSha256(secret, `sesion:${body}`))}`;
};
const ADMIN_ROUTES = [
  ['preparar', 'POST'],
  ['usuarios', 'GET'],
  ['crear', 'POST'],
  ['editar', 'POST'],
  ['restablecer', 'POST'],
  ['auditoria', 'GET'],
];
const HEX = 'ab'.repeat(32);

describe('servidor de cuentas: rutas, cuerpo y configuración', () => {
  test('ruta inexistente → 404 (sin heredar de Object.prototype); método equivocado → 405', async () => {
    const env = await setup();
    for (const action of ['nada', 'constructor', 'toString', '__proto__']) {
      const r = await raw(env, `cuentas/${action}`, { method: 'GET' });
      assert.equal(r.status, 404, action);
      assert.equal(r.body.code, 'ruta');
    }
    const root = await env.accounts.handler(new Request('https://x/'));
    assert.equal(root.status, 404, 'sin acción');
    const get = await raw(env, 'cuentas/entrar', { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.body.code, 'metodo');
    assert.match(get.body.error, /POST/);
    assert.equal((await raw(env, 'cuentas/usuarios', { body: '{}' })).status, 405);
    // Toda respuesta, también los errores: sin caché y sin adivinar el tipo.
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
  });

  test('sin el secreto del servidor (o con uno mal formado) las cuentas no están disponibles: 503', async () => {
    for (const secret of [undefined, 'abc', 'AB'.repeat(32)]) {
      const accounts = createAccounts({ store: memoryBlobStore(), secret });
      const res = await accounts.handler(new Request('https://x/api/cuentas/estado'));
      assert.equal(res.status, 503, String(secret));
      assert.equal((await res.json()).code, 'no_configurado');
      // La sincronización usa authenticate directamente: también se niega.
      const a = await accounts.authenticate(new Request('https://x/api/sync/list', { headers: { authorization: 'Bearer s1.x.y' } }));
      assert.equal(a.ok, false);
      assert.equal(a.response.status, 503);
      await assert.rejects(accounts.recoverAdmin({ rut: ADMIN_RUT, credentials: async () => ({}) }), /secreto/);
    }
  });

  test('cuerpo JSON ilegible o que no es un objeto → 400 antes de llegar a la acción; vacío equivale a {}', async () => {
    const env = await activated();
    for (const body of ['no-json{', 'null', '5', '"texto"']) {
      const r = await raw(env, 'cuentas/sal', { body });
      assert.equal(r.status, 400, body);
      assert.equal(r.body.code, 'json_invalido');
    }
    const empty = await raw(env, 'cuentas/sal', { body: '' });
    assert.equal(empty.body.code, 'rut_invalido', 'el cuerpo vacío llega como {} y la acción lo valida');
  });

  test('cuerpo demasiado grande → 413 sin procesar la acción (no es un error interno)', async (t) => {
    const env = await activated();
    const errors = t.mock.method(console, 'error', () => {});
    const r = await raw(env, 'cuentas/sal', { body: JSON.stringify({ rut: ADMIN_RUT, relleno: 'x'.repeat(600_001) }) });
    assert.equal(r.status, 413);
    assert.equal(r.body.code, 'demasiado_grande');
    assert.equal(r.body.sal, undefined);
    assert.equal(errors.mock.callCount(), 0, 'una solicitud grande no se registra como falla del servidor');
  });

  test('un fallo del almacén responde 500 genérico, sin detalles internos', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const store = memoryBlobStore();
    store.get = async () => {
      throw new Error('detalle interno del almacén');
    };
    const logs = [];
    const accounts = createAccounts({ store, secret: 'ab'.repeat(32), log: (e) => logs.push(e) });
    const res = await accounts.handler(new Request('https://x/api/cuentas/estado'));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, 'interno');
    assert.equal(JSON.stringify(body).includes('detalle interno'), false);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(errors.mock.callCount(), 1, 'el detalle queda en el registro del servidor');
    assert.deepEqual([logs[0].action, logs[0].status], ['estado', 500]);
  });
});

describe('servidor de cuentas: niveles de acceso', () => {
  test('rutas con sesión sin token (o con la contraseña del equipo tras activar) → 401', async () => {
    const env = await activated();
    for (const [action, method] of [['salir', 'POST'], ['clave', 'POST'], ['eventos', 'POST'], ...ADMIN_ROUTES]) {
      const none = await env.call(`cuentas/${action}`, { method });
      assert.equal(none.status, 401, `${action} sin token`);
      assert.equal(none.body.code, 'sesion_invalida');
      const team = await env.call(`cuentas/${action}`, { method, token: env.keys.token, body: { id: newUserId() } });
      assert.equal(team.status, 401, `${action} con la contraseña del equipo`);
    }
  });

  test('con la clave inicial solo se puede cambiar la clave o salir (ni siquiera un administrador administra)', async () => {
    const env = await activated();
    const { token } = await addUser(env, { rut: '22.222.222-2', admin: true });
    assert.equal((await env.call('cuentas/eventos', { token, body: { eventos: [] } })).body.code, 'debe_cambiar_clave');
    for (const [action, method] of ADMIN_ROUTES) {
      const r = await env.call(`cuentas/${action}`, { method, token, body: { id: newUserId() } });
      assert.equal(r.status, 403, action);
      assert.equal(r.body.code, 'debe_cambiar_clave', action);
    }
    // `clave` es de nivel sesión: llega a la acción (aquí, datos inválidos).
    assert.equal((await env.call('cuentas/clave', { token, body: {} })).body.code, 'datos_invalidos');
    assert.equal((await env.call('cuentas/salir', { token, body: {} })).status, 200);
  });

  test('una cuenta sin administrador, con su clave ya cambiada, usa eventos pero no las rutas de administración', async () => {
    const env = await activated();
    const { token } = await addUser(env, { rut: '22.222.222-2', rol: 'tens', password: 'Tens2026' });
    assert.equal((await env.call('cuentas/eventos', { token, body: { eventos: [{ ev: 'ficha.ver' }] } })).status, 200);
    for (const [action, method] of ADMIN_ROUTES) {
      const r = await env.call(`cuentas/${action}`, { method, token, body: { id: newUserId() } });
      assert.equal(r.status, 403, action);
      assert.equal(r.body.code, 'sin_permiso', action);
    }
  });

  test('token con firma válida pero inconsistente con el almacén no sirve (sesión inexistente, de otra cuenta, contenido ilegible)', async () => {
    const env = await activated();
    const p = tokenPayload(env.adminToken);
    const ok = (text) => env.call('cuentas/usuarios', { method: 'GET', token: signedToken(env.secret, text) });
    assert.equal((await ok(JSON.stringify(p))).status, 200, 'el mismo contenido firmado igual es aceptado (control)');
    const cases = {
      'sesión de otra cuenta': JSON.stringify({ ...p, u: newUserId() }),
      'sesión inexistente': JSON.stringify({ ...p, s: p.s.slice(0, 8) + 'zzzzzzzzzzzzzzzz' }),
      'sin vencimiento': JSON.stringify({ u: p.u, s: p.s }),
      'no es JSON': 'esto-no-es-json-valido',
      'JSON nulo': 'null'.padEnd(12, ' '),
    };
    for (const [name, text] of Object.entries(cases)) {
      const r = await ok(text);
      assert.equal(r.status, 401, name);
      assert.equal(r.body.code, 'sesion_invalida', name);
    }
  });

  test('la sesión anota su última actividad, como mucho una escritura por minuto', async () => {
    const env = await activated();
    const { s } = tokenPayload(env.adminToken);
    const key = `_cuentas/s/${s.slice(0, 8)}/${s}`;
    const before = (await env.store.get(key)).ultimo;
    env.clock.t += 30_000;
    await env.call('cuentas/usuarios', { method: 'GET', token: env.adminToken });
    assert.equal((await env.store.get(key)).ultimo, before, 'dentro del minuto no reescribe');
    env.clock.t += 60_000;
    await env.call('cuentas/usuarios', { method: 'GET', token: env.adminToken });
    assert.equal((await env.store.get(key)).ultimo, env.clock.t);
  });
});

describe('servidor de cuentas: entrar y límites', () => {
  test('entrar antes de activar las cuentas → 409; con datos mal formados → 400 sin contar como intento fallido', async () => {
    const pre = await setup();
    assert.equal((await pre.call('cuentas/entrar', { body: { rut: ADMIN_RUT, acceso: HEX } })).body.code, 'cuentas_inactivas');
    const env = await activated();
    assert.equal((await env.call('cuentas/sal', { body: { rut: '17.752.753-1' } })).body.code, 'rut_invalido');
    for (const body of [{ rut: 'x', acceso: HEX }, { rut: ADMIN_RUT, acceso: 'XYZ' }, { rut: ADMIN_RUT }]) {
      for (let i = 0; i < ACCOUNT_LOCK.maxFails; i++) {
        assert.equal((await env.call('cuentas/entrar', { body })).body.code, 'datos_invalidos');
      }
    }
    assert.equal((await env.login(ADMIN_RUT, 'Ojo2026')).status, 200, 'la cuenta no quedó bloqueada');
  });

  test('límite por red: 30 intentos fallidos bloquean esa IP 15 min (retry-after), ni con la clave correcta; otra IP sigue', async () => {
    const env = await activated();
    const { body: s } = await env.call('cuentas/sal', { body: { rut: ADMIN_RUT } });
    const good = { rut: ADMIN_RUT, acceso: (await deriveAccountSecrets('Ojo2026', s.sal, s.iter)).acceso };
    const from = (ip, body) => raw(env, 'cuentas/entrar', { body: JSON.stringify(body), headers: { 'x-nf-client-connection-ip': ip } });
    const bad = { rut: '22.222.222-2', acceso: HEX }; // RUT sin cuenta: no bloquea ninguna cuenta
    for (let i = 0; i < 30; i++) assert.equal((await from('10.0.0.1', bad)).status, 401);
    const blocked = await from('10.0.0.1', good);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'demasiados_intentos');
    assert.equal(blocked.headers.get('retry-after'), '900');
    // Detrás de un proxy cuenta la primera IP de x-forwarded-for.
    const proxied = await raw(env, 'cuentas/entrar', {
      body: JSON.stringify(good),
      headers: { 'x-forwarded-for': '10.0.0.1, 192.168.0.1' },
    });
    assert.equal(proxied.status, 429);
    assert.equal((await from('10.0.0.2', good)).status, 200, 'otra red no está bloqueada');
    // Al cumplirse el bloqueo (justo 15 min), los fallos se cuentan desde cero.
    env.clock.t += 15 * 60_000;
    assert.equal((await from('10.0.0.1', bad)).status, 401);
    assert.equal((await from('10.0.0.1', good)).status, 200);
  });

  test('límite por red: los fallos espaciados más de 15 min no se acumulan', async () => {
    const env = await activated();
    const bad = { rut: '22.222.222-2', acceso: HEX };
    for (let i = 0; i < 29; i++) assert.equal((await env.call('cuentas/entrar', { body: bad })).status, 401);
    env.clock.t += 16 * 60_000;
    for (let i = 0; i < 2; i++) assert.equal((await env.call('cuentas/entrar', { body: bad })).status, 401);
    assert.equal((await env.login(ADMIN_RUT, 'Ojo2026')).status, 200);
  });

  test('restablecer la clave desbloquea una cuenta bloqueada por intentos fallidos', async () => {
    const env = await activated();
    const { uid } = await addUser(env, { rut: '22.222.222-2', password: 'Otra2026' });
    for (let i = 0; i < ACCOUNT_LOCK.maxFails; i++) await env.login('22.222.222-2', 'Mala' + i);
    assert.equal((await env.login('22.222.222-2', 'Otra2026')).status, 423);
    const { body: prep } = await env.call('cuentas/preparar', { token: env.adminToken, body: { id: uid, existente: true } });
    const c = await credentialsFor({
      password: '22222222',
      teamKeyB64: env.keys.encKey,
      uid,
      complemento: prep.complemento,
      iterations: ITER,
    });
    assert.equal((await env.call('cuentas/restablecer', { token: env.adminToken, body: { id: uid, ...c } })).status, 200);
    const back = await env.login('22.222.222-2', '22222222');
    assert.equal(back.status, 200);
    assert.equal(back.body.usuario.debeCambiar, true);
  });
});

describe('servidor de cuentas: validación de las acciones', () => {
  test('activar: datos inválidos → 400 y las cuentas siguen inactivas; preparar el primero exige un id nuevo y válido', async () => {
    const env = await setup();
    const uid = newUserId();
    const { body: prep } = await env.call('cuentas/preparar', { token: env.keys.token, body: { id: uid } });
    const usuario = await env.newAccount({ rut: ADMIN_RUT, nombre: 'Admin', rol: 'medico', complemento: prep.complemento, uid });
    for (const body of [{}, { usuario: { ...usuario, rol: 'brujo' } }, { usuario: { ...usuario, iter: 10 } }]) {
      const r = await env.call('cuentas/activar', { token: env.keys.token, body });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(r.body.code, 'datos_invalidos');
    }
    assert.deepEqual((await env.call('cuentas/estado', { method: 'GET' })).body, { activas: false });
    assert.equal((await env.call('cuentas/preparar', { token: env.keys.token, body: { id: '../u/x' } })).body.code, 'id_invalido');
  });

  test('activar: una activación que quedó a medias (cuenta guardada, configuración no) se puede reintentar', async () => {
    const env = await setup();
    const uid = newUserId();
    const { body: prep } = await env.call('cuentas/preparar', { token: env.keys.token, body: { id: uid } });
    const usuario = await env.newAccount({ rut: ADMIN_RUT, nombre: 'Admin', rol: 'medico', complemento: prep.complemento, uid });
    assert.equal((await env.call('cuentas/activar', { token: env.keys.token, body: { usuario } })).status, 200);
    env.store._map.delete('_cuentas/config'); // la última escritura no llegó
    const uid2 = newUserId();
    const { body: prep2 } = await env.call('cuentas/preparar', { token: env.keys.token, body: { id: uid2 } });
    const retry = await env.newAccount({ rut: ADMIN_RUT, nombre: 'Admin', rol: 'medico', complemento: prep2.complemento, uid: uid2 });
    assert.equal((await env.call('cuentas/activar', { token: env.keys.token, body: { usuario: retry } })).status, 200);
  });

  test('crear: cada dato del alta se valida (id, RUT, profesión, perfil, credenciales) y no se guarda nada', async () => {
    const env = await activated();
    const uid = newUserId();
    const { body: prep } = await env.call('cuentas/preparar', { token: env.adminToken, body: { id: uid } });
    const acc = await env.newAccount({ rut: '22.222.222-2', nombre: 'Nueva', rol: 'medico', complemento: prep.complemento, uid });
    const cases = [
      [{ id: 'malo' }, /Id de cuenta/],
      [{ rut: '22.222.222-3' }, /RUT/],
      [{ rol: 'cirujano' }, /Profesión/],
      [{ perfil: { iv: 'corto', ct: 'x' } }, /Perfil/],
      [{ perfil: { ...acc.perfil, ct: 'A'.repeat(4001) } }, /Perfil/],
      [{ sal: 'corta' }, /Credenciales/],
      [{ iter: 1000 }, /Credenciales/],
      [{ iter: 6_000_000 }, /Credenciales/],
      [{ acceso: 'no-hex' }, /Credenciales/],
      [{ envuelta: null }, /Credenciales/],
    ];
    for (const [patch, msg] of cases) {
      const r = await env.call('cuentas/crear', { token: env.adminToken, body: { ...acc, ...patch } });
      assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 40));
      assert.match(r.body.error, msg);
    }
    const list = (await env.call('cuentas/usuarios', { method: 'GET', token: env.adminToken })).body.usuarios;
    assert.deepEqual(
      list.map((u) => u.id),
      [env.adminId],
    );
  });

  test('crear: un id ya usado no sobrescribe la cuenta existente, aunque el RUT sea otro', async () => {
    const env = await activated();
    const r = await env.call('cuentas/crear', {
      token: env.adminToken,
      body: await env.newAccount({ rut: '22.222.222-2', nombre: 'Intrusa', rol: 'tens', complemento: 'x', uid: env.adminId }),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'rut_existe');
    assert.equal((await env.login(ADMIN_RUT, 'Ojo2026')).body.usuario.rol, 'medico', 'el administrador sigue igual');
    assert.equal((await env.login('22.222.222-2', '22222222')).status, 401, 'y no quedó índice para el RUT nuevo');
  });

  test('editar: cuenta inexistente → 404; profesión, estado o perfil inválidos → 400; registra solo los campos que cambian', async () => {
    const env = await activated();
    const { uid } = await addUser(env, { rut: '22.222.222-2', rol: 'medico', password: 'Otra2026' });
    const edit = (body) => env.call('cuentas/editar', { token: env.adminToken, body });
    assert.equal((await edit({ id: '../../config' })).status, 404);
    assert.equal((await edit({ id: newUserId(), rol: 'tens' })).status, 404);
    assert.match((await edit({ id: uid, rol: 'cirujano' })).body.error, /Profesión/);
    assert.match((await edit({ id: uid, estado: 'borrado' })).body.error, /Estado/);
    assert.match((await edit({ id: uid, perfil: { iv: 'x', ct: 'y' } })).body.error, /Perfil/);
    const perfil = await encryptProfile(env.teamKey, uid, { nombre: 'Nombre Corregido', rut: '22222222-2', rol: 'tens' });
    const ok = await edit({ id: uid, rol: 'tens', admin: false, perfil });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.usuario.rol, 'tens');
    assert.deepEqual(await decryptProfile(env.teamKey, uid, ok.body.usuario.perfil), {
      nombre: 'Nombre Corregido',
      rut: '22222222-2',
      rol: 'tens',
    });
    const day = new Date(env.clock.t).toISOString().slice(0, 10);
    const { body } = await env.call(`cuentas/auditoria?desde=${day}`, { method: 'GET', token: env.adminToken });
    const ev = body.eventos.findLast((e) => e.ev === 'usuario.editar');
    assert.deepEqual(ev.det, { campos: ['rol', 'perfil'] }, '«admin» no cambió: no se registra');
    assert.equal(ev.obj, uid);
  });

  test('restablecer: cuenta inexistente → 404; credenciales inválidas → 400 sin tocar la cuenta', async () => {
    const env = await activated();
    const { uid } = await addUser(env, { rut: '22.222.222-2', password: 'Otra2026' });
    const reset = (body) => env.call('cuentas/restablecer', { token: env.adminToken, body });
    assert.equal((await reset({ id: newUserId() })).body.code, 'no_existe');
    assert.equal((await reset({ id: uid, sal: 'x', iter: ITER, acceso: HEX })).body.code, 'datos_invalidos');
    assert.equal((await env.login('22.222.222-2', 'Otra2026')).status, 200, 'su clave sigue sirviendo');
  });

  test('salir: un motivo desconocido se registra como «salir» y la sesión queda cerrada', async () => {
    const env = await activated();
    const { token } = await addUser(env, { rut: '22.222.222-2', password: 'Otra2026' });
    assert.equal((await env.call('cuentas/salir', { token, body: { motivo: '<script>' } })).status, 200);
    assert.equal((await env.call('cuentas/salir', { token, body: {} })).status, 401, 'la sesión ya no sirve');
    const day = new Date(env.clock.t).toISOString().slice(0, 10);
    const { body } = await env.call(`cuentas/auditoria?desde=${day}`, { method: 'GET', token: env.adminToken });
    const fin = body.eventos.filter((e) => e.ev === 'sesion.fin');
    assert.deepEqual(
      fin.map((e) => e.det.motivo),
      ['salir'],
    );
    assert.equal(body.sesiones.find((x) => x.id === tokenPayload(token).s).motivo, 'salir');
  });

  test('clave: credenciales mal formadas → 400; con la misma sal, la clave actual no sirve como nueva', async () => {
    const env = await activated();
    const me = await env.login(ADMIN_RUT, 'Ojo2026');
    assert.equal((await env.call('cuentas/clave', { token: me.body.token, body: { sal: 'x' } })).body.code, 'datos_invalidos');
    const { body: s } = await env.call('cuentas/sal', { body: { rut: ADMIN_RUT } });
    const same = { sal: s.sal, iter: s.iter, acceso: me.sec.acceso, envuelta: me.body.usuario.envuelta, accesoActual: me.sec.acceso };
    const r = await env.call('cuentas/clave', { token: me.body.token, body: same });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'clave_igual');
  });

  test('eventos: lote que no es lista o de más de 100 → 400; n y at fuera de rango se descartan', async () => {
    const env = await activated();
    const send = (eventos) => env.call('cuentas/eventos', { token: env.adminToken, body: { eventos } });
    assert.equal((await send('ficha.ver')).body.code, 'lote_invalido');
    assert.equal((await send(Array.from({ length: 101 }, () => ({ ev: 'ficha.ver' })))).body.code, 'lote_invalido');
    const t = env.clock.t;
    const r = await send([
      null,
      { ev: 'exportar.excel', n: 5, obj: 'lote1' },
      { ev: 'exportar.pdfs', n: -1, obj: 'lote2' },
      { ev: 'exportar.pdfs', n: 1.5, obj: 'lote3' },
      { ev: 'exportar.pdfs', n: 1e6, obj: 'lote4' },
      { ev: 'ficha.ver', at: t - 100 * DAY, obj: 'p_vieja' },
      { ev: 'ficha.ver', at: t + 100 * DAY, obj: 'p_futura' },
      { ev: 'ficha.ver', obj: 42 },
    ]);
    assert.equal(r.body.registrados, 6, 'null y un obj que no es texto se descartan');
    const day = new Date(t).toISOString().slice(0, 10);
    const { body } = await env.call(`cuentas/auditoria?desde=${day}`, { method: 'GET', token: env.adminToken });
    const by = Object.fromEntries(body.eventos.filter((e) => e.obj).map((e) => [e.obj, e]));
    assert.equal(by.lote1.n, 5);
    for (const k of ['lote2', 'lote3', 'lote4']) assert.equal(by[k].n, undefined, k);
    for (const k of ['p_vieja', 'p_futura']) {
      assert.equal(by[k].at, undefined, `${k}: hora del cliente implausible`);
      assert.equal(by[k].t, t, 'queda la hora del servidor');
    }
  });

  test('auditoría: sin «hasta» llega hasta ahora; fechas ilegibles, faltantes o rango invertido → 400', async () => {
    const env = await activated();
    const get = (q) => env.call(`cuentas/auditoria?${q}`, { method: 'GET', token: env.adminToken });
    const day = new Date(env.clock.t).toISOString().slice(0, 10);
    const open = await get(`desde=${day}`);
    assert.equal(open.status, 200);
    assert.ok(open.body.eventos.some((e) => e.ev === 'cuentas.activar'));
    for (const q of ['', 'desde=ayer', `desde=${day}&hasta=2026-11-14`, `desde=${day}&hasta=nunca`]) {
      assert.equal((await get(q)).body.code, 'rango_invalido', q);
    }
  });
});

test('recuperar un administrador: valida RUT, activación y credenciales antes de tocar nada', async () => {
  const pre = await setup();
  const fresh = createAccounts({ store: pre.store, secret: pre.secret, now: () => pre.clock.t });
  await assert.rejects(fresh.recoverAdmin({ rut: ADMIN_RUT, credentials: async () => ({}) }), /no están activadas/);

  const env = await activated();
  const accounts = createAccounts({ store: env.store, secret: env.secret, now: () => env.clock.t });
  await assert.rejects(accounts.recoverAdmin({ rut: '17.752.753-1', credentials: async () => ({}) }), /RUT inválido/);
  await assert.rejects(accounts.recoverAdmin({ rut: ADMIN_RUT, credentials: async () => ({ sal: 'x' }) }), /Credenciales/);
  assert.equal((await env.login(ADMIN_RUT, 'Ojo2026')).status, 200, 'la cuenta no cambió');
  // Un índice de RUT que apunta a una cuenta que ya no está no se pisa.
  const { uid } = await addUser(env, { rut: '22.222.222-2' });
  env.store._map.delete(`_cuentas/u/${uid}`);
  const creds = (id, complemento) =>
    credentialsFor({ password: '22222222', teamKeyB64: env.keys.encKey, uid: id, complemento, iterations: ITER });
  const perfil = (id) => encryptProfile(env.teamKey, id, { nombre: 'Otra', rut: '22222222-2', rol: 'medico' });
  await assert.rejects(accounts.recoverAdmin({ rut: '22.222.222-2', credentials: creds, perfil }), /No se pudo crear/);
});
