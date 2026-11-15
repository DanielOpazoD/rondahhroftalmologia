import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, MAX_AHEAD_MS } from '../src/core/clock.js';
import { mergeRecords, stampChanges } from '../src/core/merge.js';

test('tick es estrictamente creciente aunque la hora del sistema no avance', () => {
  const c = createClock({ now: () => 1000 });
  assert.deepEqual([c.tick(), c.tick(), c.tick()], [1000, 1001, 1002]);
});

test('una edición hecha después de ver otra gana aunque el reloj local esté atrasado', () => {
  // PC1 con la hora adelantada 1 hora edita la PIO.
  const pc1 = createClock({ now: () => 10_000_000 + 3_600_000 });
  // PC2 con la hora correcta (atrasada respecto de PC1).
  const pc2 = createClock({ now: () => 10_000_000 });
  const base = { id: 'a', updated: 1, ft: {}, f: {}, checks: {}, proc: {} };
  const t1 = pc1.tick();
  const v1 = stampChanges({ ...structuredClone(base), f: { od_pio: '30' }, updated: t1 }, base, t1);
  // PC2 recibe la versión de PC1 (observa su fecha) y luego corrige la PIO.
  pc2.observe(v1.updated);
  const t2 = pc2.tick();
  const v2 = stampChanges({ ...structuredClone(v1), f: { od_pio: '18' }, updated: t2 }, v1, t2);
  assert.ok(t2 > t1, 'la corrección queda con fecha posterior');
  assert.equal(mergeRecords(v1, v2).f.od_pio, '18');
  assert.equal(mergeRecords(v2, v1).f.od_pio, '18');
});

test('no se adopta una hora absurdamente adelantada', () => {
  const c = createClock({ now: () => 5000 });
  c.observe(5000 + MAX_AHEAD_MS * 10);
  assert.equal(c.last, 5000 + MAX_AHEAD_MS);
  c.observe(NaN);
  assert.equal(c.last, 5000 + MAX_AHEAD_MS);
});

test('persistencia: retoma la última hora guardada', () => {
  let saved = 0;
  const c1 = createClock({ now: () => 100, save: (t) => (saved = t) });
  c1.observe(900);
  const c2 = createClock({ now: () => 100, load: () => saved });
  assert.equal(c2.tick(), 901);
});
