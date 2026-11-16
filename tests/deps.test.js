import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, exportUsage, LAYERS, EXTERNAL } from '../scripts/deps.mjs';

const a = analyze();

test('dependencias: sin ciclos entre módulos', () => {
  assert.deepEqual(a.cycles, [], a.cycles.map((c) => c.join(' → ')).join('\n'));
});

test('dependencias: cada capa usa solo las capas permitidas (scripts/deps.mjs LAYERS)', () => {
  assert.deepEqual(a.violations, []);
  // Ninguna capa (salvo la interfaz y el punto de entrada) depende de ui/.
  for (const [edge] of a.layerEdges) {
    const [from, to] = edge.split('→');
    if (to === 'ui') assert.equal(from, 'main', edge);
  }
});

test('dependencias: cada paquete externo está en package.json y documentado', () => {
  assert.deepEqual(a.undeclared, []);
  assert.deepEqual(a.undocumented, []);
  const doc = readFileSync(new URL('../docs/DEPENDENCIAS.md', import.meta.url), 'utf8');
  for (const p of a.external.keys()) assert.ok(doc.includes(`\`${p}\``), `docs/DEPENDENCIAS.md no menciona ${p} (npm run deps -- --write)`);
  for (const l of Object.keys(LAYERS)) assert.ok(doc.includes(`\`${l}/\``), l);
  // Versiones fijas (sin ^ ni ~): una actualización siempre es explícita.
  for (const [p, v] of Object.entries({ ...a.pkg.dependencies, ...a.pkg.devDependencies })) assert.match(String(v), /^\d/, `${p}: ${v}`);
  assert.ok(Object.keys(EXTERNAL).length <= 5, 'pocos paquetes externos: agregar uno es una decisión');
});

test('dependencias: cada exportación de src/ la usa otro archivo (sin código muerto)', () => {
  const { unused, testOnly } = exportUsage();
  assert.deepEqual(unused, [], 'Si solo se usa en su archivo, quita el `export`; si no se usa, bórrala.');
  // Cuenta también `const { x } = await import(…)` (no confunde la llave con una anterior).
  assert.ok(testOnly.includes('src/sync/client.js contentHash'));
  assert.ok(testOnly.includes('src/core/attachments.js isThumbnail'));
});
