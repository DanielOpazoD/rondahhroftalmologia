import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import {
  pbkdf2,
  pinProblem,
  createLockConfig,
  verifyPin,
  verifyRecovery,
  isLockConfig,
  lockoutMs,
  generateRecoveryCode,
  FREE_ATTEMPTS,
} from '../src/core/pin.js';

test('pbkdf2 propio coincide con el de Node', () => {
  const salt = '00112233445566778899aabbccddeeff';
  for (const [secret, iter] of [
    ['1234', 1],
    ['1234', 1000],
    ['98765432', 2500],
  ]) {
    assert.equal(pbkdf2(secret, salt, iter), pbkdf2Sync(secret, Buffer.from(salt, 'hex'), iter, 32, 'sha256').toString('hex'));
  }
});

test('PIN: valida, verifica, y el código de recuperación desbloquea', () => {
  assert.equal(pinProblem('1234'), null);
  assert.ok(pinProblem('12'));
  assert.ok(pinProblem('12a4'));
  assert.ok(pinProblem('123456789'));
  const { lock, recoveryCode } = createLockConfig('4821', 15, 1000);
  assert.ok(isLockConfig(lock));
  assert.equal(lock.minutes, 15);
  assert.ok(!JSON.stringify(lock).includes('4821'), 'el PIN no se guarda');
  assert.ok(verifyPin(lock, '4821'));
  assert.ok(!verifyPin(lock, '4822'));
  assert.match(recoveryCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(verifyRecovery(lock, recoveryCode.toLowerCase().replace(/-/g, ' ')), 'tolera minúsculas y separadores');
  assert.ok(!verifyRecovery(lock, generateRecoveryCode()));
  assert.throws(() => createLockConfig('12'), /entre 4 y 8/);
  assert.equal(createLockConfig('1234', 7, 1000).lock.minutes, 10, 'minutos fuera de la lista: por omisión');
  assert.ok(!isLockConfig({ hash: 'x' }));
  assert.ok(!isLockConfig({ ...lock, iter: 1 }), 'muy pocas iteraciones: inválido');
  // Una huella truncada o alargada no valida (la comparación exige el mismo largo).
  assert.ok(!verifyPin({ ...lock, hash: lock.hash.slice(0, 32) }, '4821'));
  assert.ok(!verifyPin({ ...lock, hash: lock.hash + '00' }, '4821'));
});

test('espera creciente tras intentos fallidos', () => {
  assert.equal(lockoutMs(FREE_ATTEMPTS - 1), 0);
  assert.equal(lockoutMs(FREE_ATTEMPTS), 30_000);
  assert.equal(lockoutMs(FREE_ATTEMPTS + 1), 60_000);
  assert.equal(lockoutMs(FREE_ATTEMPTS + 20), 15 * 60_000);
});
