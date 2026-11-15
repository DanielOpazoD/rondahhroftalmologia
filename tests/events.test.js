import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '../src/ui/events.js';

test('bus: agrupa avisos del mismo momento y entrega una vez por suscriptor', async () => {
  const bus = createBus();
  const calls = [];
  bus.on('datos', (t) => calls.push(['listas', t]));
  const both = (t) => calls.push(['ambos', t]);
  bus.on('datos', both);
  bus.on('otro', both);
  for (let i = 0; i < 50; i++) bus.emit('datos');
  bus.emit('otro');
  assert.equal(calls.length, 0, 'se entrega después (microtarea)');
  await Promise.resolve();
  assert.deepEqual(calls, [
    ['listas', ['datos', 'otro']],
    ['ambos', ['datos', 'otro']],
  ]);
});

test('bus: una vista que falla no impide las demás; desuscribirse funciona', () => {
  const queue = [];
  const bus = createBus({ schedule: (fn) => queue.push(fn) });
  let ok = 0;
  bus.on('datos', () => {
    throw new Error('vista rota');
  });
  const off = bus.on('datos', () => ok++);
  bus.emit('datos');
  const origError = console.error;
  console.error = () => {};
  try {
    queue.shift()();
  } finally {
    console.error = origError;
  }
  assert.equal(ok, 1);
  off();
  bus.emit('datos');
  queue.shift()();
  assert.equal(ok, 1);
});
