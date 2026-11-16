#!/usr/bin/env node
/**
 * Mapa de dependencias del código (ver docs/DEPENDENCIAS.md).
 *
 *   npm run deps            → revisa: ciclos, dependencias entre capas no permitidas
 *                             y paquetes externos sin documentar (falla si hay alguno)
 *   npm run deps -- --write → además vuelve a generar docs/DEPENDENCIAS.md
 *
 * Lee los `import` reales de src/ (no los de comentarios ni los tipos JSDoc).
 * La misma revisión corre en las pruebas (tests/deps.test.js).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Capas y de qué capas puede depender cada una (además de sí misma).
 * `main` (el punto de entrada) puede usarlas todas.
 */
export const LAYERS = Object.freeze({
  lib: { desc: 'utilidades sin dominio (sha256, zip, xlsx)', allow: [] },
  config: { desc: 'catálogos y claves de almacenamiento', allow: ['specialties'] },
  specialties: { desc: 'la especialidad: catálogos, clínica, PDF, nota, Excel', allow: ['core', 'lib', 'config'] },
  core: { desc: 'modelo y reglas puras', allow: ['lib', 'config', 'specialties'] },
  app: { desc: 'reglas de las acciones (puras)', allow: ['core', 'lib', 'config', 'specialties'] },
  storage: { desc: 'IndexedDB y localStorage', allow: ['core', 'lib', 'config', 'specialties'] },
  sync: { desc: 'cifrado, protocolo, cliente, servidor, cuentas', allow: ['core', 'lib', 'config'] },
  ui: { desc: 'pantallas, acciones y servicios de la interfaz', allow: ['app', 'sync', 'core', 'storage', 'lib', 'config', 'specialties'] },
});

/** Paquetes externos: para qué se usan (cada uno debe estar aquí y en package.json). */
export const EXTERNAL = Object.freeze({
  'pdf-lib': {
    uso: 'Llenar la plantilla PDF de la atención y armar el PDF con anexos.',
    donde: 'Va dentro de la app (el build la incluye en el HTML).',
  },
  '@netlify/blobs': {
    uso: 'Almacén del servidor: sincronización, cuentas, registro de accesos y respaldos.',
    donde: 'Solo en el servidor (funciones de Netlify) y en los scripts de operación.',
  },
  esbuild: { uso: 'Empaquetar la app en un solo archivo HTML.', donde: 'Solo al construir (scripts/build.mjs).' },
});

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** Código sin comentarios (los tipos JSDoc `import('…')` no son dependencias reales). @param {string} s */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Especificadores importados por un archivo. @param {string} code */
function specifiers(code) {
  const out = [];
  for (const m of stripComments(code).matchAll(
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    out.push(m[1] || m[2]);
  }
  return out;
}

/** Capa de un archivo de src/ («main» para el punto de entrada). @param {string} rel */
export const layerOf = (rel) => (rel.includes('/') ? rel.split('/')[0] : 'main');

/**
 * Analiza el código.
 * @param {string} [root]
 */
export function analyze(root = ROOT) {
  const src = join(root, 'src');
  /** @type {Map<string, {deps: string[], lines: number}>} */
  const graph = new Map();
  /** @type {Map<string, Set<string>>} paquete externo → archivos que lo usan */
  const external = new Map();
  const note = (/** @type {string} */ spec, /** @type {string} */ file) => {
    if (spec.startsWith('node:') || spec.endsWith('package.json')) return;
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!external.has(pkg)) external.set(pkg, new Set());
    external.get(pkg)?.add(file);
  };
  for (const f of walk(src)) {
    const rel = relative(src, f);
    const code = readFileSync(f, 'utf8');
    const deps = [];
    for (const spec of specifiers(code)) {
      if (spec.startsWith('.')) {
        const target = relative(src, resolve(dirname(f), spec));
        if (!target.startsWith('..')) deps.push(target);
      } else note(spec, `src/${rel}`);
    }
    graph.set(rel, { deps, lines: code.split('\n').length });
  }
  for (const dir of ['netlify/functions', 'scripts']) {
    for (const f of walk(join(root, dir))) {
      for (const spec of specifiers(readFileSync(f, 'utf8'))) if (!spec.startsWith('.')) note(spec, relative(root, f));
    }
  }

  // Ciclos (Tarjan): componentes fuertemente conexos de más de un módulo.
  let index = 0;
  /** @type {string[]} */
  const stack = [];
  const onStack = new Set();
  /** @type {Map<string, number>} */
  const idx = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  /** @type {string[][]} */
  const cycles = [];
  /** @param {string} v */
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v)?.deps || []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(/** @type {number} */ (low.get(v)), /** @type {number} */ (low.get(w))));
      } else if (onStack.has(w)) low.set(v, Math.min(/** @type {number} */ (low.get(v)), /** @type {number} */ (idx.get(w))));
    }
    if (low.get(v) === idx.get(v)) {
      const c = [];
      let w;
      do {
        w = /** @type {string} */ (stack.pop());
        onStack.delete(w);
        c.push(w);
      } while (w !== v);
      if (c.length > 1) cycles.push(c.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);

  // Dependencias entre capas.
  /** @type {Map<string, number>} */
  const layerEdges = new Map();
  /** @type {string[]} */
  const violations = [];
  for (const [file, { deps }] of graph) {
    const from = layerOf(file);
    for (const d of deps) {
      const to = layerOf(d);
      if (from === to || !graph.has(d)) continue;
      layerEdges.set(`${from}→${to}`, (layerEdges.get(`${from}→${to}`) || 0) + 1);
      const rule = /** @type {Record<string, {allow: string[]}>} */ (LAYERS)[from];
      if (from !== 'main' && !rule?.allow.includes(to)) violations.push(`${file} → ${d} (${from} no puede depender de ${to})`);
    }
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const undocumented = [...external.keys()].filter((p) => !Object.hasOwn(EXTERNAL, p));
  const undeclared = [...external.keys()].filter((p) => !Object.hasOwn(declared, p));
  return { graph, cycles, violations, layerEdges, external, undocumented, undeclared, pkg };
}

/** docs/DEPENDENCIAS.md a partir del análisis. @param {ReturnType<typeof analyze>} a */
export function renderDoc(a) {
  const layers = Object.keys(LAYERS);
  const byLayer = (/** @type {string} */ l) =>
    [...a.graph.entries()].filter(([f]) => layerOf(f) === l).sort(([x], [y]) => x.localeCompare(y));
  const fanIn = new Map();
  for (const [, { deps }] of a.graph) for (const d of deps) fanIn.set(d, (fanIn.get(d) || 0) + 1);
  const pkgVersion = (/** @type {string} */ p) => a.pkg.dependencies?.[p] || a.pkg.devDependencies?.[p] || '—';
  const kind = (/** @type {string} */ p) => (a.pkg.dependencies?.[p] ? 'servidor' : 'desarrollo y build');
  const lines = [
    '# Dependencias',
    '',
    '> Generado por `npm run deps -- --write` (scripts/deps.mjs). La prueba `tests/deps.test.js` falla si aparece un ciclo, una dependencia entre capas no permitida o un paquete externo sin documentar.',
    '',
    `Estado: **${a.cycles.length} ciclos**, **${a.violations.length} dependencias no permitidas**, ${a.graph.size} módulos.`,
    '',
    '## Capas y qué puede usar cada una',
    '',
    '| Capa | Qué contiene | Puede depender de |',
    '|---|---|---|',
    ...layers.map(
      (l) =>
        `| \`${l}/\` | ${/** @type {any} */ (LAYERS)[l].desc} | ${/** @type {any} */ (LAYERS)[l].allow.map((x) => `\`${x}\``).join(', ') || '— (nada)'} |`,
    ),
    '| `main.js` | punto de entrada | todas |',
    '',
    'Además: `core/`, `app/`, `lib/`, `sync/` y `config/` no tocan el DOM ni el almacenamiento del navegador (lo impide ESLint), y la plataforma ve la especialidad solo a través de `specialties/activa/`.',
    '',
    '## Dependencias reales entre capas',
    '',
    'Cada flecha es una capa que usa a otra (el número: cuántos `import` hay).',
    '',
    '```mermaid',
    'flowchart TD',
    ...[...a.layerEdges.entries()].sort().map(([k, n]) => {
      const [from, to] = k.split('→');
      return `  ${from} -->|${n}| ${to}`;
    }),
    '```',
    '',
    '## Paquetes externos',
    '',
    'Pocos y con versión fija en `package.json` (sin `^` ni `~`). Dependabot propone las actualizaciones, y cada una pasa por las pruebas antes de aceptarse.',
    '',
    '| Paquete | Versión | Tipo | Para qué | Dónde |',
    '|---|---|---|---|---|',
    ...[...a.external.keys()]
      .sort()
      .map(
        (p) =>
          `| \`${p}\` | ${pkgVersion(p)} | ${kind(p)} | ${/** @type {any} */ (EXTERNAL)[p]?.uso || '**sin documentar**'} | ${/** @type {any} */ (EXTERNAL)[p]?.donde || ''} |`,
      ),
    '',
    'Herramientas de desarrollo que no se importan desde el código: ' +
      Object.keys(a.pkg.devDependencies || {})
        .filter((p) => !a.external.has(p))
        .map((p) => `\`${p}\` ${a.pkg.devDependencies[p]}`)
        .join(', ') +
      '.',
    '',
    '## Módulos por capa',
    '',
    'Para cada módulo: cuántos módulos usa (→) y cuántos lo usan (←).',
    '',
  ];
  for (const l of ['main', ...layers]) {
    const mods = byLayer(l);
    if (!mods.length) continue;
    lines.push(`### ${l === 'main' ? 'main.js' : `${l}/`} (${mods.length})`, '');
    lines.push(mods.map(([f, { deps }]) => `\`${f}\` →${deps.length} ←${fanIn.get(f) || 0}`).join(' · '), '');
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = analyze();
  const problems = [
    ...a.cycles.map((c) => `Ciclo: ${c.join(' → ')}`),
    ...a.violations.map((v) => `Capa: ${v}`),
    ...a.undocumented.map((p) => `Paquete sin documentar en scripts/deps.mjs (EXTERNAL): ${p}`),
    ...a.undeclared.map((p) => `Paquete importado que no está en package.json: ${p}`),
  ];
  if (process.argv.includes('--write')) {
    const out = join(ROOT, 'docs/DEPENDENCIAS.md');
    writeFileSync(out, renderDoc(a));
    // Mismo formato que el resto del repositorio (npm run format:check).
    execFileSync('npx', ['prettier', '--write', out], { stdio: 'ignore' });
    console.log('docs/DEPENDENCIAS.md actualizado.');
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`Sin ciclos ni dependencias no permitidas (${a.graph.size} módulos, ${a.external.size} paquetes externos).`);
}
