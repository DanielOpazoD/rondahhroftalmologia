import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { sha256, hmacSha256, toHex } from '../src/lib/sha256.js';
import { crc32, createZip, readZip, isZip } from '../src/lib/zip.js';
import { buildXlsx, columnLetter, sheetName, xmlEscape, STYLE } from '../src/lib/xlsx.js';
import { readZipWithPython, sheetCells } from './helpers.js';

test('sha256 coincide con node:crypto en largos límite', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
    const data = randomBytes(len);
    assert.equal(toHex(sha256(new Uint8Array(data))), createHash('sha256').update(data).digest('hex'), `largo ${len}`);
  }
  assert.equal(toHex(sha256('ñandú ojo')), createHash('sha256').update('ñandú ojo').digest('hex'));
});

test('hmacSha256 coincide con node:crypto (clave corta y > 64 bytes)', () => {
  for (const key of ['k', 'clave-secreta', 'x'.repeat(100)]) {
    assert.equal(toHex(hmacSha256(key, 'rut:11111111-1')), createHmac('sha256', key).update('rut:11111111-1').digest('hex'));
  }
});

test('crc32 conocido', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('createZip produce un ZIP válido, con nombres UTF-8 y sin duplicados', () => {
  const zip = createZip([
    { name: 'a.txt', data: 'hola' },
    { name: 'Atención_ñ.txt', data: 'ojo' },
    { name: 'a.txt', data: 'repetido' },
    { name: 'bin.dat', data: new Uint8Array([0, 255, 1, 2]) },
  ]);
  const files = readZipWithPython(zip);
  assert.deepEqual(Object.keys(files), ['a.txt', 'Atención_ñ.txt', 'a (2).txt', 'bin.dat']);
  assert.equal(files['a.txt'], 'hola');
  assert.equal(files['a (2).txt'], 'repetido');
});

test('columnLetter, sheetName y xmlEscape', () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnLetter), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  const used = new Set();
  assert.equal(sheetName('Resumen', used), 'Resumen');
  assert.equal(sheetName('resumen', used), 'resumen (2)');
  assert.equal(sheetName('a/b:c?[d]*', new Set()), 'a b c  d');
  assert.equal(sheetName('x'.repeat(40), new Set()).length, 31);
  assert.equal(xmlEscape('<a & "b">\u0001'), '&lt;a &amp; &quot;b&quot;&gt;');
});

test('buildXlsx genera un libro legible con texto, números y estilos', () => {
  const bytes = buildXlsx(
    [
      {
        name: 'Datos',
        header: true,
        rows: [
          ['Nombre', 'N°'],
          ['Ñuñoa <&>', 3],
          ['vacío', null],
          [{ v: 'Total', s: STYLE.bold }, 4.5],
        ],
      },
      { name: 'Otra', rows: [['solo texto']] },
    ],
    { title: 'Prueba', date: new Date('2026-11-14T12:00:00Z') },
  );
  const files = readZipWithPython(bytes);
  assert.ok(files['[Content_Types].xml'].includes('sheet2.xml'));
  assert.ok(files['xl/workbook.xml'].includes('name="Datos"'));
  const cells = sheetCells(files['xl/worksheets/sheet1.xml']);
  assert.equal(cells.A1, 'Nombre');
  assert.equal(cells.A2, 'Ñuñoa <&>');
  assert.equal(cells.B2, '3');
  assert.equal(cells.B4, '4.5');
  assert.ok(files['xl/worksheets/sheet1.xml'].includes('state="frozen"'));
  assert.ok(files['xl/worksheets/sheet1.xml'].includes('<autoFilter ref="A1:B4"/>'));
  assert.throws(() => buildXlsx([]));
});

test('readZip lee lo que escribe createZip y detecta daños', () => {
  const zip = createZip([
    { name: 'respaldo.json', data: '{"a":1}' },
    { name: 'adjuntos/j1', data: new Uint8Array([0, 255, 7]) },
  ]);
  assert.ok(isZip(zip));
  assert.equal(isZip(new TextEncoder().encode('{"app":1}')), false);
  const files = readZip(zip);
  assert.deepEqual([...files.keys()], ['respaldo.json', 'adjuntos/j1']);
  assert.deepEqual([...files.get('adjuntos/j1')], [0, 255, 7]);
  const bad = zip.slice();
  bad[zip.indexOf(255)] = 254; // un byte del contenido
  assert.throws(() => readZip(bad), /dañado/);
  assert.throws(() => readZip(new Uint8Array([1, 2, 3])), /no es un ZIP/);
});
