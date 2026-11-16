#!/usr/bin/env node
/**
 * Informe de calidad del código (ver docs/CALIDAD.md):
 *
 *   npm run calidad
 *
 * Reúne en un lugar las cifras que el resto de las herramientas hace cumplir:
 *  - tipos: módulos con verificación estricta (jsconfig*.json: la app, el
 *    código de Node y el service worker);
 *  - complejidad: la más alta y cuántas funciones pasan de 10, la próxima meta
 *    (ESLint `complexity`, con tope en eslint.config.js);
 *  - capas, dependencias y exportaciones sin uso (scripts/deps.mjs);
 *  - manejo de errores: cada `catch` relanza, informa, sigue con una
 *    alternativa o explica en un comentario por qué se ignora (un bloque vacío
 *    sin comentario ya lo rechaza la regla `no-empty` de ESLint).
 */
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { analyze, exportUsage } from './deps.mjs';

/** Complejidad desde la que se cuenta una función en el informe (bajo el tope de ESLint). */
const WATCH = 10;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (/** @type {string} */ f) => f.replace(ROOT + '/', '');

/**
 * Cada configuración de tipos y el código que debe cubrir: la app (navegador),
 * el código de Node (scripts y funciones de Netlify) y el service worker.
 */
const TYPED = [
  { config: 'jsconfig.json', label: 'src/', files: ['src/**/*.js'] },
  { config: 'jsconfig.node.json', label: 'scripts/ y netlify/', files: ['scripts/**/*.mjs', 'netlify/**/*.mjs'] },
  { config: 'jsconfig.sw.json', label: 'public/', files: ['public/**/*.js'] },
];

/**
 * Opciones de una configuración de tipos, con las que hereda (`extends`).
 * @param {string} file
 * @returns {{compilerOptions: Record<string, unknown>, include: string[]}}
 */
function readTypeConfig(file) {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
  const base = cfg.extends ? readTypeConfig(cfg.extends) : { compilerOptions: {}, include: [] };
  return { compilerOptions: { ...base.compilerOptions, ...cfg.compilerOptions }, include: cfg.include ?? base.include };
}

/** Módulos verificados en modo estricto, por configuración (todos, si es estricta y los incluye). */
function strictCoverage() {
  return TYPED.map(({ config, label, files }) => {
    const cfg = readTypeConfig(config);
    const all = files.flatMap((p) => globSync(p, { cwd: ROOT }));
    if (!cfg.compilerOptions.strict) return { label, strict: 0, total: all.length };
    const included = new Set(cfg.include.flatMap((p) => globSync(p, { cwd: ROOT })));
    return { label, strict: all.filter((f) => included.has(f)).length, total: all.length };
  });
}

/**
 * Clase de un `catch` según su cuerpo.
 * @param {string} body texto entre las llaves
 */
function catchKind(body) {
  if (/\bthrow\b/.test(body)) return 'relanza';
  if (/logError|console\.(error|warn)|toast|ui(Alert|Confirm)|fail\(|textContent|error/.test(body)) return 'informa';
  if (/^(\/\/|\/\*)/.test(body)) return 'ignora (con motivo)';
  return 'alternativa';
}

/** Complejidad por función y clase de cada `catch`, en una pasada de ESLint sobre el código (no las pruebas). */
async function scan() {
  const plugin = {
    rules: {
      catch: {
        /** @param {any} context */
        create: (context) => ({
          /** @param {any} node */
          CatchClause: (node) => context.report({ node, message: catchKind(context.sourceCode.getText(node.body).slice(1, -1).trim()) }),
        }),
      },
    },
  };
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: { plugins: { calidad: plugin }, rules: { complexity: ['warn', WATCH], 'calidad/catch': 'warn' } },
  });
  /** @type {{n: number, where: string}[]} */
  const cx = [];
  /** @type {Record<string, number>} */
  const kinds = { relanza: 0, informa: 0, alternativa: 0, 'ignora (con motivo)': 0 };
  for (const f of await eslint.lintFiles(['src/**/*.js', 'scripts/**/*.mjs', 'netlify/**/*.mjs', 'public/**/*.js'])) {
    for (const m of f.messages) {
      const where = `${rel(f.filePath)}:${m.line}`;
      if (m.ruleId === 'complexity') cx.push({ n: Number(/complexity of (\d+)/.exec(m.message)?.[1]), where });
      if (m.ruleId === 'calidad/catch') kinds[m.message]++;
    }
  }
  return { cx: cx.sort((a, b) => b.n - a.n), kinds };
}

const t = strictCoverage();
const { cx, kinds: c } = await scan();
const d = analyze();
const e = exportUsage();
const sum = (/** @type {'strict' | 'total'} */ k) => t.reduce((n, x) => n + x[k], 0);
console.log(
  `Tipos estrictos:   ${sum('strict')}/${sum('total')} módulos (${t.map((x) => `${x.label} ${x.strict}/${x.total}`).join(', ')})`,
);
console.log(
  `Complejidad:       máxima ${cx[0]?.n ?? `≤${WATCH}`}${cx[0] ? ` (${cx[0].where})` : ''}; ${cx.length} funciones sobre ${WATCH}`,
);
for (const x of cx.slice(0, 5)) console.log(`                   ${String(x.n).padStart(3)}  ${x.where}`);
console.log(
  `Capas:             ${d.cycles.length} ciclos, ${d.violations.length} dependencias no permitidas, ${d.external.size} paquetes externos`,
);
console.log(`Exportaciones:     ${e.total} en src/; ${e.unused.length} sin uso, ${e.testOnly.length} usadas solo por las pruebas`);
console.log(
  `catch:             ${Object.entries(c)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ')}`,
);
