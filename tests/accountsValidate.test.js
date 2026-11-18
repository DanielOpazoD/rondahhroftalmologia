// Validación de las solicitudes de cuentas (src/sync/accounts/validate.js): pura, sin almacén ni secreto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_EVENTS,
  MAX_EVENTS,
  DAY_MS,
  isUserId,
  isCredentials,
  isLogin,
  isTokenPayload,
  newAccountData,
  accountChanges,
  logoutReason,
  eventBatch,
  clientEvent,
  auditRange,
} from '../src/sync/accounts/validate.js';
import { isObject } from '../src/sync/crypto.js';

const SEALED = { iv: 'A'.repeat(16), ct: 'QUJD' };
const CREDS = { sal: 'B'.repeat(24), iter: 100_000, acceso: 'a'.repeat(64), envuelta: SEALED };
const ALTA = { id: 'u0123456789abcdef', rut: '17.752.753-K', rol: 'medico', perfil: SEALED, ...CREDS };

test('objetos e ids: arreglos cuentan como objeto (como en el router); el id se valida como texto', () => {
  assert.ok(isObject({}) && isObject([]));
  assert.ok(!isObject(null) && !isObject('x') && !isObject(5));
  assert.ok(isUserId('u0123456789abcdef'));
  assert.ok(!isUserId('u0123') && !isUserId(undefined) && !isUserId(5));
  assert.equal(isUserId(['u0123456789abcdef']), false, 'una lista con un id no es un id (antes pasaba)');
});

test('credenciales: sal de 16 bytes, iteraciones en rango, acceso hex y clave envuelta válida', () => {
  assert.ok(isCredentials(CREDS));
  for (const bad of [
    null,
    'x',
    { ...CREDS, sal: 'x' },
    { ...CREDS, iter: 99_999 },
    { ...CREDS, iter: 5_000_001 },
    { ...CREDS, iter: '100000' },
    { ...CREDS, acceso: 'A'.repeat(64) },
    { ...CREDS, envuelta: null },
    { ...CREDS, envuelta: { iv: 'A'.repeat(15), ct: 'QUJD' } },
    { ...CREDS, envuelta: { iv: 'A'.repeat(16), ct: '' } },
    { ...CREDS, envuelta: { iv: 'A'.repeat(16), ct: 'Q'.repeat(4004) } },
  ]) {
    assert.equal(isCredentials(bad), false, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('alta: el primer problema en orden (id, RUT, profesión, perfil, credenciales)', () => {
  assert.deepEqual(newAccountData(ALTA), { alta: ALTA });
  assert.deepEqual(newAccountData(undefined), { error: 'Id de cuenta inválido' });
  assert.deepEqual(newAccountData({ ...ALTA, id: 'x', rut: 'x' }), { error: 'Id de cuenta inválido' });
  assert.deepEqual(newAccountData({ ...ALTA, rut: 'x', rol: 'x' }), { error: 'RUT inválido' });
  assert.deepEqual(newAccountData({ ...ALTA, rol: 'jefe' }), { error: 'Profesión inválida' });
  assert.deepEqual(newAccountData({ ...ALTA, perfil: 'x' }), { error: 'Perfil inválido' });
  assert.deepEqual(newAccountData({ ...ALTA, iter: 1 }), { error: 'Credenciales inválidas' });
});

test('entrar y token: forma mínima', () => {
  assert.ok(isLogin({ rut: '17.752.753-K', acceso: 'f'.repeat(64) }));
  assert.ok(!isLogin({ rut: 'x', acceso: 'f'.repeat(64) }) && !isLogin({ rut: '17.752.753-K' }));
  assert.ok(isTokenPayload({ u: 'u1', s: 's1', e: 1 }));
  assert.ok(!isTokenPayload({ u: 'u1', s: 's1', e: Infinity }) && !isTokenPayload(null) && !isTokenPayload({ u: 1, s: 's', e: 1 }));
});

test('cambios a una cuenta: solo los campos pedidos, validados; admin es estrictamente true', () => {
  assert.deepEqual(accountChanges({}), { changes: {} });
  assert.deepEqual(accountChanges({ rol: 'tens', admin: 'true', estado: 'desactivado', perfil: SEALED }), {
    changes: { rol: 'tens', admin: false, estado: 'desactivado', perfil: SEALED },
  });
  assert.deepEqual(accountChanges({ rol: 'jefe' }), { error: 'Profesión inválida' });
  assert.deepEqual(accountChanges({ estado: 'borrado' }), { error: 'Estado inválido' });
  assert.deepEqual(accountChanges({ perfil: null }), { error: 'Perfil inválido' });
});

test('salir, lote y eventos: lo desconocido se descarta o vuelve al valor por omisión', () => {
  assert.equal(logoutReason('inactividad'), 'inactividad');
  assert.equal(logoutReason('otro'), 'salir');
  assert.equal(logoutReason(undefined), 'salir');
  assert.equal(eventBatch('x'), null);
  assert.equal(eventBatch(Array(MAX_EVENTS + 1).fill(0)), null);
  assert.equal(eventBatch([]).length, 0);
  const t = Date.UTC(2026, 10, 15);
  assert.equal(clientEvent({ ev: 'inventado' }, t), null);
  assert.equal(clientEvent({ ev: CLIENT_EVENTS[0], obj: 5 }, t), null);
  assert.equal(clientEvent({ ev: CLIENT_EVENTS[0], obj: 'a b' }, t), null);
  assert.deepEqual(clientEvent({ ev: 'ficha.ver', obj: 'p_1', n: 3, at: t - 1, off: true, extra: 1 }, t), {
    ev: 'ficha.ver',
    obj: 'p_1',
    n: 3,
    at: t - 1,
    off: true,
  });
  assert.deepEqual(clientEvent({ ev: 'ficha.ver', n: 1e6, at: t + 91 * DAY_MS, off: 1 }, t), {
    ev: 'ficha.ver',
    obj: undefined,
    n: undefined,
    at: undefined,
    off: undefined,
  });
});

test('rango de auditoría: ms o AAAA-MM-DD, hasta 62 días y en orden', () => {
  const q = (s) => new URLSearchParams(s);
  const t = Date.UTC(2026, 10, 15);
  assert.deepEqual(auditRange(q('desde=2026-11-01'), t), { desde: Date.UTC(2026, 10, 1), hasta: t });
  assert.deepEqual(auditRange(q('desde=2026-11-01&hasta=2026-11-02'), t), {
    desde: Date.UTC(2026, 10, 1),
    hasta: Date.UTC(2026, 10, 3) - 1,
  });
  assert.deepEqual(auditRange(q(`desde=${t - 1000}&hasta=${t}`), t), { desde: t - 1000, hasta: t });
  assert.equal(auditRange(q('desde=2026-01-01&hasta=2026-12-31'), t), null);
  assert.equal(auditRange(q('desde=2026-11-02&hasta=2026-11-01'), t), null);
  assert.equal(auditRange(q(''), t), null);
});
