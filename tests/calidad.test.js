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

test('tipos: sin @ts-ignore, @ts-nocheck ni @ts-expect-error en src/', () => {
  const hits = globSync('src/**/*.js', { cwd: root.pathname }).filter((f) =>
    /@ts-(ignore|nocheck|expect-error)/.test(readFileSync(new URL(f, root), 'utf8')),
  );
  assert.deepEqual(hits, [], 'Corrige el tipo en vez de silenciar al verificador');
});
