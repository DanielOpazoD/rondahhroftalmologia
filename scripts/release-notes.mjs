#!/usr/bin/env node
/**
 * Notas de una versión, tomadas de su sección del CHANGELOG.
 *   node scripts/release-notes.mjs 2.13.0   -> imprime la sección «## 2.13.0 — …»
 * La usa .github/workflows/release.yml para crear la etiqueta y la release.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} changelog contenido de CHANGELOG.md
 * @param {string} version p. ej. «2.13.0»
 * @returns {string | null} la sección (sin su título), o null si no existe
 */
export function notesFor(changelog, version) {
  const lines = changelog.split('\n');
  const esc = version.replace(/\./g, '\\.');
  const start = lines.findIndex((l) => new RegExp(`^## ${esc}(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  const notes = notesFor(await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  if (notes === null) {
    console.error(`El CHANGELOG no tiene la sección ## ${version}`);
    process.exit(1);
  }
  console.log(notes);
}
