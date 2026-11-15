import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryBlobStore } from '../src/sync/server.js';
import { dailyBackup, listBackups, restoreBackup, KEEP_DAYS, dayOf } from '../src/sync/backup.js';

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 16, 3);

async function filled() {
  const s = memoryBlobStore();
  await s.setJSON('oftalmologia/r/a1/100.0123456789abcdef', { iv: 'IV', ct: 'CIFRADO1' });
  await s.setJSON('pacientes/r/h_x/50', { iv: 'IV', ct: 'CIFRADO2' });
  await s.setJSON('oftalmologia/c/20261116/1.a1.100.0123456789abcdef', 1); // índice: no se respalda
  await s.setJSON('oftalmologia-adjuntos/r/jx-0/5', { iv: 'IV', ct: 'ARCHIVO' }); // contenido de adjuntos: no se respalda
  return s;
}

test('respaldo diario: copia solo las versiones (cifradas), un documento por día', async () => {
  const source = await filled();
  const target = memoryBlobStore();
  const r = await dailyBackup({ source, target, now: T0 });
  assert.deepEqual(r, { dia: '2026-11-16', claves: 2, borrados: [] });
  const doc = await target.get('2026-11-16.json');
  assert.deepEqual(Object.keys(doc.claves).sort(), ['oftalmologia/r/a1/100.0123456789abcdef', 'pacientes/r/h_x/50']);
  assert.equal(doc.claves['pacientes/r/h_x/50'].ct, 'CIFRADO2', 'se copia tal cual (cifrado)');
});

test('se conservan 30 días y se puede restaurar (sin borrar lo más nuevo)', async () => {
  const source = await filled();
  const target = memoryBlobStore();
  for (let d = 0; d <= KEEP_DAYS + 3; d++) await dailyBackup({ source, target, now: T0 + d * DAY });
  const days = await listBackups(target);
  assert.equal(days.length, KEEP_DAYS + 1);
  assert.equal(days[0], dayOf(T0 + (KEEP_DAYS + 3) * DAY));

  // Desastre: se pierde el almacén de sincronización.
  const empty = memoryBlobStore();
  await empty.setJSON('oftalmologia/r/a1/200.ffffffffffffffff', { iv: 'IV', ct: 'MAS-NUEVA' });
  assert.deepEqual(await restoreBackup({ source: target, target: empty, day: days[0], dryRun: true }), { claves: 2, escritas: 0 });
  assert.deepEqual(await restoreBackup({ source: target, target: empty, day: days[0] }), { claves: 2, escritas: 2 });
  assert.equal((await empty.get('pacientes/r/h_x/50')).ct, 'CIFRADO2');
  assert.equal((await empty.get('oftalmologia/r/a1/200.ffffffffffffffff')).ct, 'MAS-NUEVA', 'lo más nuevo sigue ahí');
  await assert.rejects(restoreBackup({ source: target, target: empty, day: '1999-01-01' }), /No hay respaldo/);
});
