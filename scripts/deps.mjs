#!/usr/bin/env node
/**
 * Mapa de dependencias del código (ver docs/DEPENDENCIAS.md).
 *
 *   npm run deps            → revisa: ciclos, dependencias entre capas no permitidas,
 *                             paquetes externos sin documentar y exportaciones que
 *                             nadie usa (falla si hay alguno)
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
  eslint: {
    uso: 'Revisión del código (npm run lint) e informe de calidad (npm run calidad).',
    donde: 'Solo en desarrollo y en la integración continua; nunca va dentro de la app.',
  },
  '@playwright/test': {
    uso: 'Pruebas de punta a punta (e2e/) y medir la app en un navegador real (npm run perf).',
    donde: 'Solo en desarrollo y en la integración continua; nunca va dentro de la app.',
  },
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
 * Ciclos (Tarjan): componentes fuertemente conexos de más de un módulo.
 * @param {Map<string, {deps: string[]}>} graph
 */
function findCycles(graph) {
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
  return cycles;
}

/**
 * Grafo de módulos de src/ (a qué módulos importa cada uno) y paquetes
 * externos usados en src/, netlify/functions/ y scripts/.
 * @param {string} root
 */
function readImports(root) {
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
  return { graph, external };
}

/**
 * Dependencias entre capas (cuántos `import` de cada capa a otra) y las que
 * LAYERS no permite.
 * @param {Map<string, {deps: string[]}>} graph
 */
function layerDeps(graph) {
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
  return { layerEdges, violations };
}

/**
 * Analiza el código.
 * @param {string} [root]
 */
export function analyze(root = ROOT) {
  const { graph, external } = readImports(root);
  const cycles = findCycles(graph);
  const { layerEdges, violations } = layerDeps(graph);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const undocumented = [...external.keys()].filter((p) => !Object.hasOwn(EXTERNAL, p));
  const undeclared = [...external.keys()].filter((p) => !Object.hasOwn(declared, p));
  return { graph, cycles, violations, layerEdges, external, undocumented, undeclared, pkg };
}

/** Nombres que declara un `export` (sin `default`). @param {string} code */
function declaredExports(code) {
  const names = [...code.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)].map((m) => m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}(?!\s*from)/gm)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) names.push(name);
    }
  }
  return names.filter((n) => n && n !== 'default');
}

/**
 * Lo que un archivo usa de otros módulos: `import {a, b as c} from`,
 * `export {a} from`, `const {a} = await import()` (por nombre) e
 * `import * as`, `export * from`, `const m = await import()` (todo el módulo).
 * @param {string} code sin comentarios
 * @returns {{spec: string, names: string[] | '*'}[]}
 */
function importedNames(code) {
  /** @param {string} list */
  const split = (list) =>
    list
      .split(',')
      .map((p) => p.trim().split(/\s+as\s+|\s*:\s*/)[0])
      .filter(Boolean);
  const out = [];
  for (const m of code.matchAll(/(?:^|\n)\s*(import|export)\s([^;]*?)from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[2];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (/\*/.test(clause) && !braces) out.push({ spec: m[3], names: /** @type {'*'} */ ('*') });
    else out.push({ spec: m[3], names: braces ? split(braces[1]) : [] });
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(?:(\{[^}]*\})|([\w$]+))\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ spec: m[3], names: m[1] ? split(m[1].slice(1, -1)) : /** @type {'*'} */ ('*') });
  }
  return out;
}

/**
 * Exportaciones de src/ que nadie usa. Una exportación es parte de la interfaz
 * de un módulo: si ningún otro archivo la importa, sobra (se borra o deja de
 * exportarse). Las que solo usan las pruebas se cuentan aparte: son válidas
 * (probar una pieza interna), pero conviene que sean pocas.
 *
 * `specialties/activa/` apunta en el build a cualquier especialidad: lo que se
 * importa de `activa/x.js` cuenta como usado en `x.js` de todas.
 * @param {string} [root]
 */
export function exportUsage(root = ROOT) {
  const src = join(root, 'src');
  const read = (/** @type {string} */ f) => stripComments(readFileSync(f, 'utf8'));
  const srcFiles = walk(src).filter((f) => !f.endsWith('.d.ts'));
  /** @type {Map<string, {names: string[], stars: string[]}>} */
  const modules = new Map();
  for (const f of srcFiles) {
    const code = read(f);
    const stars = [...code.matchAll(/^export\s*\*\s*from\s+['"]([^'"]+)['"]/gm)].map((m) => resolve(dirname(f), m[1]));
    modules.set(f, { names: declaredExports(code), stars });
  }
  const specialties = readdirSync(join(src, 'specialties')).filter(
    (d) => d !== 'activa' && statSync(join(src, 'specialties', d)).isDirectory(),
  );
  /** Archivos a los que apunta un import (activa/x.js → x.js de cada especialidad). @param {string} file */
  const targets = (file) => {
    const m = /\/specialties\/activa\/(.+)$/.exec(file);
    return m ? specialties.map((s) => join(src, 'specialties', s, m[1])) : [file];
  };
  /** @type {Map<string, Set<string>>} archivo → nombres usados */
  const used = new Map();
  /** @type {Map<string, Set<string>>} */
  const usedByTests = new Map();
  /**
   * @param {Map<string, Set<string>>} into
   * @param {string} file
   * @param {string[] | '*'} names
   * @param {Set<string>} [seen]
   */
  const mark = (into, file, names, seen = new Set()) => {
    for (const t of targets(file)) {
      const mod = modules.get(t);
      if (!mod || seen.has(t)) continue;
      seen.add(t);
      const set = into.get(t) || new Set();
      into.set(t, set);
      for (const n of names === '*' ? mod.names : names) set.add(n);
      // Lo que no declara el módulo puede venir de un `export * from`.
      for (const s of mod.stars) mark(into, s, names === '*' ? '*' : names.filter((n) => !mod.names.includes(n)), seen);
    }
  };
  const consumers = [
    ...srcFiles.map((f) => ({ f, into: used })),
    ...['netlify/functions', 'scripts'].flatMap((d) => walk(join(root, d)).map((f) => ({ f, into: used }))),
    ...['tests', 'e2e'].flatMap((d) => walk(join(root, d)).map((f) => ({ f, into: usedByTests }))),
  ];
  for (const { f, into } of consumers) {
    for (const { spec, names } of importedNames(read(f))) {
      if (spec.startsWith('.')) mark(into, resolve(dirname(f), spec), names);
    }
  }
  /** @type {string[]} */
  const unused = [];
  /** @type {string[]} */
  const testOnly = [];
  let total = 0;
  for (const [f, { names }] of modules) {
    for (const n of names) {
      total++;
      const where = `${relative(root, f)} ${n}`;
      if (used.get(f)?.has(n)) continue;
      if (usedByTests.get(f)?.has(n)) testOnly.push(where);
      else unused.push(where);
    }
  }
  return { total, unused: unused.sort(), testOnly: testOnly.sort() };
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
  const exp = exportUsage();
  const problems = [
    ...exp.unused.map((e) => `Exportación sin uso: ${e}`),
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
