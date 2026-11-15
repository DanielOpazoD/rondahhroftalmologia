import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBuild } from '../src/ui/version.js';

test('compareBuild: misma compilación, más nueva o sin datos para comparar', () => {
  assert.equal(compareBuild('abc123abc123', { build: 'abc123abc123' }), 'same');
  assert.equal(compareBuild('abc123abc123', { build: 'ffff00001111', version: '2.13.0' }), 'newer');
  assert.equal(compareBuild('__APP_BUILD__', { build: 'x' }), 'unknown', 'sin compilar (pruebas)');
  assert.equal(compareBuild('abc123abc123', null), 'unknown');
  assert.equal(compareBuild('abc123abc123', {}), 'unknown');
});
