/**
 * Reglas de calidad que ninguna otra herramienta revisa sola (ver docs/CALIDAD.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';

const root = new URL('../', import.meta.url);

test('tipos: jsconfig.json es estricto y cubre todo src/', () => {
  const cfg = JSON.parse(readFileSync(new URL('jsconfig.json', root), 'utf8'));
  assert.equal(cfg.compilerOptions.strict, true);
  // Una opción explícita le gana a `strict`: ninguna de su familia puede quedar en false.
  for (const k of ['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'noImplicitThis', 'alwaysStrict']) {
    assert.notEqual(cfg.compilerOptions[k], false, k);
  }
  assert.ok(cfg.include.includes('src/**/*.js'));
});

test('tipos: el código de Node y el service worker también se verifican en modo estricto', () => {
  // Cada configuración hereda la estricta de jsconfig.json y cubre todo su código.
  const covers = {
    'jsconfig.node.json': ['scripts/**/*.mjs', 'netlify/**/*.mjs'],
    'jsconfig.sw.json': ['public/**/*.js'],
  };
  for (const [file, globs] of Object.entries(covers)) {
    const cfg = JSON.parse(readFileSync(new URL(file, root), 'utf8'));
    assert.equal(cfg.extends, './jsconfig.json', file);
    for (const k of [
      'strict',
      'noImplicitAny',
      'strictNullChecks',
      'strictFunctionTypes',
      'strictBindCallApply',
      'noImplicitThis',
      'alwaysStrict',
    ]) {
      assert.ok(!(k in (cfg.compilerOptions ?? {})), `${file} no debe redefinir ${k}`);
    }
    const included = new Set(cfg.include.flatMap((/** @type {string} */ p) => globSync(p, { cwd: root.pathname })));
    const missing = globs.flatMap((g) => globSync(g, { cwd: root.pathname })).filter((f) => !included.has(f));
    assert.deepEqual(missing, [], `${file} debe incluir todo su código`);
  }
  // Y `npm run typecheck` (el paso de CI) las revisa todas.
  const { scripts } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  for (const file of ['jsconfig.json', ...Object.keys(covers)]) assert.ok(scripts.typecheck.includes(`-p ${file}`), file);
});

test('tipos: sin @ts-ignore, @ts-nocheck ni @ts-expect-error en el código', () => {
  const hits = ['src/**/*.js', 'scripts/**/*.mjs', 'netlify/**/*.mjs', 'public/**/*.js']
    .flatMap((g) => globSync(g, { cwd: root.pathname }))
    .filter((f) => /@ts-(ignore|nocheck|expect-error)/.test(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(hits, [], 'Corrige el tipo en vez de silenciar al verificador');
});
