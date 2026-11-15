import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notesFor } from '../scripts/release-notes.mjs';

test('notas de versión: la sección del CHANGELOG, sin la siguiente', () => {
  const md = '# Cambios\n\n## 2.1.0 — x\n\n- nuevo A\n\n## 2.0.10 — y\n\n- viejo\n';
  assert.equal(notesFor(md, '2.1.0'), '- nuevo A');
  assert.equal(notesFor(md, '2.0.10'), '- viejo');
  assert.equal(notesFor(md, '2.0.1'), null, 'no confunde 2.0.1 con 2.0.10');
});

test('la versión actual tiene su sección en el CHANGELOG (si no, la release fallaría)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const notes = notesFor(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), pkg.version);
  assert.ok(notes && notes.length > 20, `falta ## ${pkg.version} en CHANGELOG.md`);
});
