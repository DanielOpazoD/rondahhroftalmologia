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

test('adjuntos: respaldo incremental (cada parte una vez), con tope de tiempo, y huérfanas borradas a los 30 días', async () => {
  const { backupAttachments, restoreAttachments } = await import('../src/sync/backup.js');
  const source = memoryBlobStore();
  for (let i = 0; i < 5; i++) await source.setJSON(`oftalmologia-adjuntos/r/jx-${i}/100`, { iv: 'IV', ct: 'PARTE' + i });
  await source.setJSON('oftalmologia/r/a1/100', { iv: 'IV', ct: 'ATENCION' }); // no es un adjunto
  const target = memoryBlobStore();
  // Tope de tiempo: solo alcanza para 2 partes; la siguiente ejecución continúa.
  let t = 0;
  const clock = () => (t += 10);
  const r1 = await backupAttachments({ source, target, now: T0, budgetMs: 25, clock });
  assert.equal(r1.copiadas, 2);
  assert.equal(r1.pendientes, 3);
  const r2 = await backupAttachments({ source, target, now: T0 });
  assert.deepEqual([r2.copiadas, r2.pendientes], [3, 0]);
  assert.equal((await backupAttachments({ source, target, now: T0 })).copiadas, 0, 'no se copia dos veces');
  assert.equal(await target.get('adjuntos/oftalmologia/r/a1/100'), null);
  // Se elimina un adjunto: su parte se conserva 30 días y luego se borra.
  await source.delete('oftalmologia-adjuntos/r/jx-0/100');
  assert.equal((await backupAttachments({ source, target, now: T0 + 5 * DAY })).borradas, 0);
  assert.ok(await target.get('adjuntos/oftalmologia-adjuntos/r/jx-0/100'));
  assert.equal((await backupAttachments({ source, target, now: T0 + 40 * DAY })).borradas, 1);
  assert.equal(await target.get('adjuntos/oftalmologia-adjuntos/r/jx-0/100'), null);
  assert.deepEqual(await listBackups(target), [], 'las partes no se confunden con días de respaldo');
  // Desastre: se pierde el servidor; se reponen las partes respaldadas.
  const empty = memoryBlobStore();
  assert.deepEqual(await restoreAttachments({ source: target, target: empty }), { partes: 4, escritas: 4 });
  assert.equal((await empty.get('oftalmologia-adjuntos/r/jx-3/100')).ct, 'PARTE3');
});

test('respaldo con adjuntos: ZIP con su contenido; al importar se verifica la huella y no se duplica', async () => {
  const { buildBackup, parseBackup, packBackup, unpackBackup, attachmentsToImport } = await import('../src/core/backup.js');
  const { sha256Hex } = await import('../src/core/attachments.js');
  const foto = new Uint8Array([1, 2, 3, 4, 5]);
  const informe = new Uint8Array([9, 8, 7]);
  const meta = async (id, nombre, bytes) => ({
    id,
    atencionId: 'a1',
    nombre,
    tipo: 'image/png',
    tamano: bytes.length,
    sha256: await sha256Hex(bytes),
    created: 1,
  });
  const metas = [
    await meta('jfoto', 'fondo.png', foto),
    await meta('jinf', 'informe.docx', informe),
    await meta('jfalta', 'oct.pdf', foto),
  ];
  const backup = buildBackup({ records: [], procs: [], attachments: metas });
  const zip = packBackup(
    backup,
    new Map([
      ['jfoto', foto],
      ['jinf', new Uint8Array([0, 0, 0])],
    ]),
  ); // informe dañado
  const { text, contents } = unpackBackup(zip);
  const incoming = parseBackup(text);
  assert.equal(incoming.attachments.length, 3);
  const r = await attachmentsToImport(incoming.attachments, contents, (id) => id === 'jfoto' && false);
  assert.deepEqual(
    r.metas.map((m) => m.id),
    ['jfoto', 'jinf', 'jfalta'],
  );
  assert.deepEqual([...r.contents.keys()], ['jfoto'], 'solo el contenido que coincide con su huella');
  assert.deepEqual(r.rechazados, ['informe.docx']);
  // Lo que el equipo ya tiene no se vuelve a importar.
  assert.deepEqual(
    (await attachmentsToImport(incoming.attachments, contents, (id) => id === 'jfoto')).metas.map((m) => m.id),
    ['jinf', 'jfalta'],
  );
  // Un respaldo JSON (anterior, o sin adjuntos) se sigue leyendo igual.
  const plain = unpackBackup(new TextEncoder().encode(JSON.stringify(buildBackup({ records: [], procs: [] }))));
  assert.equal(parseBackup(plain.text).attachments.length, 0);
  assert.equal(plain.contents.size, 0);
});
