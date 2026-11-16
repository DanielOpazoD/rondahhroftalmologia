#!/usr/bin/env node
/**
 * Informe de calidad del código (ver docs/CALIDAD.md):
 *
 *   npm run calidad
 *
 * Reúne en un lugar las cifras que el resto de las herramientas hace cumplir:
 *  - tipos: módulos con verificación estricta (jsconfig.json);
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

/** Módulos de src/ verificados en modo estricto (todos, si jsconfig.json es estricto e incluye src/). */
function strictCoverage() {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'jsconfig.json'), 'utf8'));
  const all = globSync('src/**/*.js', { cwd: ROOT });
  if (!cfg.compilerOptions?.strict) return { strict: 0, total: all.length };
  const included = new Set(cfg.include.flatMap((/** @type {string} */ p) => globSync(p, { cwd: ROOT })));
  return { strict: all.filter((f) => included.has(f)).length, total: all.length };
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

/** Complejidad por función y clase de cada `catch`, en una pasada de ESLint sobre src/. */
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
  for (const f of await eslint.lintFiles(['src/**/*.js'])) {
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
console.log(`Tipos estrictos:   ${t.strict}/${t.total} módulos de src/ (${Math.round((t.strict / t.total) * 100)} %)`);
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
