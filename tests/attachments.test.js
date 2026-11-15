import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { deriveTeamKeys, tokenHash, importEncKey } from '../src/sync/crypto.js';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import { createSyncApi } from '../src/sync/client.js';
import { syncAttachmentContent, attachmentsPending } from '../src/sync/attachments.js';
import {
  normalizeAttachment,
  addProblem,
  kindOf,
  splitChunks,
  joinChunks,
  chunkCount,
  sha256Hex,
  safeFileName,
  CHUNK_BYTES,
  ATTACHMENT_LIMITS,
} from '../src/core/attachments.js';
import { idbBackend } from '../src/storage/backends.js';
import { createRepo } from '../src/storage/repo.js';

const PASS = 'K7QM3-XRT9P-ZAWD4-N8F2C';
/** Bytes pseudoaleatorios (incompresibles), deterministas. */
function bytesOf(n, seed = 7) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) b[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  return b;
}

test('modelo: tipos, límites, nombres seguros y partes', async () => {
  assert.equal(kindOf('image/jpeg', 'a.jpg'), 'imagen');
  assert.equal(kindOf('image/heic', 'IMG.HEIC'), 'imagen-otra');
  assert.equal(kindOf('application/pdf', 'x'), 'pdf');
  assert.equal(kindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'informe.docx'), 'documento');
  assert.equal(safeFileName('C:\\fotos\\fondo<ojo>.jpg'), 'fondoojo.jpg');
  assert.equal(addProblem([], ATTACHMENT_LIMITS.fileBytes + 1) !== null, true);
  assert.equal(addProblem([{ tamano: 50 * 1024 * 1024 }], 15 * 1024 * 1024) !== null, true, 'total por atención');
  assert.equal(addProblem([], 1000), null);
  const big = bytesOf(CHUNK_BYTES * 2 + 10);
  const parts = splitChunks(big);
  assert.equal(parts.length, 3);
  assert.equal(chunkCount(big.length), 3);
  assert.deepEqual(joinChunks(parts), big);
  const meta = normalizeAttachment({
    id: 'jx1',
    atencionId: 'a1',
    nombre: '../../x.pdf',
    tipo: 'application/pdf',
    tamano: big.length,
    sha256: await sha256Hex(big),
    created: 5,
  });
  assert.equal(meta.nombre, 'x.pdf');
  assert.equal(meta.partes, 3);
  assert.equal(normalizeAttachment({ ...meta, id: 'a1' }), null, 'los ids de adjunto empiezan con j');
  assert.equal(normalizeAttachment({ ...meta, sha256: 'x' }), null);
});

test('repositorio: metadatos en memoria; contenido de a uno, solo con IndexedDB', async () => {
  const repo = createRepo(await idbBackend('adj', new IDBFactory()));
  await repo.init();
  const bytes = bytesOf(1000);
  const meta = {
    id: 'j1',
    atencionId: 'a1',
    nombre: 'f.png',
    tipo: 'image/png',
    tamano: 1000,
    sha256: await sha256Hex(bytes),
    created: 10,
  };
  repo.saveAttachments([meta]);
  await repo.saveAttachmentData('j1', bytes);
  await repo.flush();
  const again = createRepo(await idbBackend('adj', new IDBFactory()));
  assert.ok(again.supportsAttachments());
  assert.deepEqual(await repo.attachmentDataIds(), ['j1']);
  assert.deepEqual((await repo.loadAttachmentData('j1')).bytes, bytes);
  assert.equal(repo.loadAttachments('a1').length, 1);
  assert.equal(repo.loadAttachments('otra').length, 0);
});

/** Un equipo con su repositorio y un conjunto de «subidos». */
async function device(api, key) {
  const repo = createRepo(await idbBackend('pc' + Math.random(), new IDBFactory()));
  await repo.init();
  const uploaded = new Set();
  return {
    repo,
    uploaded,
    sync: (purges = []) =>
      syncAttachmentContent({
        api,
        key,
        metas: repo.loadAttachments(),
        purges,
        local: {
          ids: () => repo.attachmentDataIds(),
          load: (id) => repo.loadAttachmentData(id),
          save: (id, b) => repo.saveAttachmentData(id, b),
          isUploaded: (id) => uploaded.has(id),
          markUploaded: (id) => uploaded.add(id),
        },
      }),
  };
}

test('sincronización del contenido: cifrado en partes, íntegro, y se libera al eliminar', async () => {
  const keys = await deriveTeamKeys(PASS, 1000);
  const key = await importEncKey(keys.encKey);
  const store = memoryBlobStore();
  const handler = createSyncHandler({ store, tokenHash: tokenHash(keys.token) });
  const fetchFn = (url, init) => handler(new Request('https://x.test' + url, init));
  const api = createSyncApi({ token: keys.token, fetchFn, esp: 'oftalmologia-adjuntos' });
  const A = await device(api, key);
  const B = await device(api, key);

  // A adjunta un archivo de 3 partes.
  const bytes = bytesOf(CHUNK_BYTES * 2 + 1234, 3);
  const meta = {
    id: 'jabc',
    atencionId: 'a1',
    nombre: 'fondo.png',
    tipo: 'image/png',
    tamano: bytes.length,
    sha256: await sha256Hex(bytes),
    created: Date.now(),
  };
  A.repo.saveAttachments([meta]);
  await A.repo.saveAttachmentData('jabc', bytes);
  assert.equal(
    attachmentsPending(A.repo.loadAttachments(), await A.repo.attachmentDataIds(), (id) => A.uploaded.has(id), []),
    true,
  );
  assert.equal((await A.sync()).subidos, 1);
  assert.equal(
    attachmentsPending(A.repo.loadAttachments(), await A.repo.attachmentDataIds(), (id) => A.uploaded.has(id), []),
    false,
    'nada pendiente',
  );
  const keysOnServer = [...store._map.keys()].filter((k) => k.includes('/r/'));
  assert.equal(keysOnServer.length, 3);
  // El servidor no ve el contenido.
  const raw = JSON.stringify([...store._map.values()]);
  assert.ok(!raw.includes(Buffer.from(bytes.subarray(0, 64)).toString('base64').slice(0, 40)));

  // B recibió los metadatos (sincronización normal) y baja el contenido.
  B.repo.saveAttachments([meta]);
  const r = await B.sync();
  assert.equal(r.bajados, 1);
  assert.deepEqual((await B.repo.loadAttachmentData('jabc')).bytes, bytes);

  // Contenido alterado (huella que no coincide): no se acepta.
  const C = await device(api, key);
  C.repo.saveAttachments([{ ...meta, sha256: '0'.repeat(64) }]);
  const rc = await C.sync();
  assert.deepEqual(rc.fallidos, ['jabc']);
  assert.equal(await C.repo.loadAttachmentData('jabc'), undefined);

  // Eliminar: el contenido del servidor se reemplaza por lápidas pequeñas.
  const before = [...store._map.values()].join('').length;
  assert.deepEqual((await A.sync(['jabc'])).borrados, ['jabc']);
  const after = [...store._map.values()].join('').length;
  assert.ok(after < before / 10, 'se liberó el espacio');
});
