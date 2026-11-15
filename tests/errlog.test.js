import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorEntry, pushEntry, formatLog, MAX_ENTRIES } from '../src/core/errlog.js';

test('registro de errores: entradas acotadas, solo las últimas y texto para soporte', () => {
  const e = errorEntry('sincronización', new Error('x'.repeat(1000)), 1_800_000_000_000, '2.13.0');
  assert.equal(e.msg.length, 300);
  assert.ok(e.stack && e.stack.split('\n').length <= 6);
  assert.equal(errorEntry('a', 'texto').msg, 'texto');
  assert.equal(errorEntry('a', undefined).msg, 'Error desconocido');
  let list = [];
  for (let i = 0; i < MAX_ENTRIES + 5; i++) list = pushEntry(list, errorEntry('a', 'e' + i, i));
  assert.equal(list.length, MAX_ENTRIES);
  assert.equal(list[0].msg, 'e5');
  const text = formatLog(list.slice(-2), 'Cabecera');
  assert.match(text, /^Cabecera\n.*e54/);
});
