/**
 * Los documentos no citan archivos que ya no existen: cada ruta del repo que
 * nombran (src/…, scripts/…, tests/…, docs/…) tiene que estar. Así una
 * reorganización no deja la documentación apuntando a la nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'docs/' + f),
  ...readdirSync(join(ROOT, 'docs/adr'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'docs/adr/' + f),
].filter((f) => existsSync(join(ROOT, f)));

/** Rutas de archivos del repo nombradas en un texto (sin comodines ni marcadores como `<id>`). @param {string} text */
const pathsIn = (text) =>
  [...text.matchAll(/(?<![\w/.-])((?:src|scripts|tests|e2e|docs|netlify|public)\/[\w./-]*\.(?:js|mjs|ts|md|html|css|json|pdf))\b/g)]
    .map((m) => m[1])
    .filter((p) => !/[*<>]/.test(p));

test('documentación: cada archivo del repo que se cita existe', () => {
  /** @type {string[]} */
  const missing = [];
  for (const doc of DOCS) {
    for (const p of new Set(pathsIn(readFileSync(join(ROOT, doc), 'utf8')))) {
      if (!existsSync(join(ROOT, p))) missing.push(`${doc}: ${p}`);
    }
  }
  assert.deepEqual(missing, [], 'Corrige la ruta en el documento (o el documento quedó desactualizado).');
});
