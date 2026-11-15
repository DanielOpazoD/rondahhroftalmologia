import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTeamKeys, tokenHash, importEncKey, encryptPayload } from '../src/sync/crypto.js';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import { createAccounts } from '../src/sync/accounts.js';
import { credentialsFor, deriveAccountSecrets, unwrapTeamKey, encryptProfile, decryptProfile } from '../src/sync/accountCrypto.js';
import { passwordProblem, rutBody, initialPassword, accountRut, newUserId, loginState, USER_ID_RE } from '../src/core/accounts.js';
import { can, PERMISSIONS } from '../src/core/permissions.js';

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
  return { keys, store, clock, call, newAccount, login, changePassword, teamKey };
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
