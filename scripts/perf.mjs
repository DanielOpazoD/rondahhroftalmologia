#!/usr/bin/env node
/**
 * Rendimiento con datos objetivos (ver docs/RENDIMIENTO.md).
 *
 *   npm run perf              → mide y muestra los resultados
 *   npm run perf -- --write   → además actualiza docs/RENDIMIENTO.md
 *   npm run perf -- --solo-node   (sin navegador)
 *
 * Mide tres cosas, siempre con el mismo conjunto de datos sintético
 * (semilla fija): 3.000 atenciones de 1.200 pacientes.
 *   1. Tamaño de la app publicada (total, comprimido y por parte).
 *   2. Funciones del núcleo en Node (estadística, duplicados, nota, PDF, seudonimizar…).
 *   3. La app real en el navegador: inicio vacío, inicio con los datos, cambio
 *      de pestaña y búsqueda (mediana de varias repeticiones).
 */
/* global document, window, requestAnimationFrame */ // (dentro de page.evaluate: corre en el navegador)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildSite, lastBuild } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const N_ATTENTIONS = 3000;
const N_PATIENTS = 1200;

/* ------------------------------------------------------------ datos */

/** Generador reproducible. @param {number} seed */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Conjunto sintético reproducible (no son datos reales). */
export async function dataset() {
  const { rutCheckDigit } = await import('../src/core/format.js');
  const { normalizeRecord } = await import('../src/core/record.js');
  const { DEFAULT_PROCS } = await import('../src/specialties/activa/index.js');
  const r = rng(42);
  const pick = (/** @type {any[]} */ a) => a[Math.floor(r() * a.length)];
  const apellidos = ['Pakarati', 'Tuki', 'Hotus', 'Teao', 'Rapu', 'Atán', 'Tepano', 'Haoa', 'Pérez', 'Soto', 'Muñoz', 'Rojas'];
  const nombres = ['Ana', 'Juan', 'María', 'Pedro', 'Rosa', 'Luis', 'Carmen', 'José', 'Elena', 'Pablo'];
  const patients = Array.from({ length: N_PATIENTS }, (_, i) => {
    const body = String(5_000_000 + i * 7919);
    return {
      rut: `${body}-${rutCheckDigit(body)}`,
      paterno: pick(apellidos),
      materno: pick(apellidos),
      nombres: pick(nombres),
      fnac: `19${40 + Math.floor(r() * 60)}-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`,
      sexo: pick(['F', 'M']),
    };
  });
  const dx = ['diagnostico_glaucoma', 'diagnostico_catarata', 'diagnostico_miopia', 'diagnostico_rdnp'];
  const records = Array.from({ length: N_ATTENTIONS }, (_, i) => {
    const p = patients[Math.floor(r() * N_PATIENTS)];
    const day = 1 + Math.floor(r() * 27);
    const month = 1 + Math.floor(r() * 12);
    const t = Date.UTC(2026, month - 1, day, 12) + i;
    return normalizeRecord({
      id: 'a' + i.toString(36).padStart(6, '0'),
      created: t,
      updated: t,
      f: {
        operativo: `Operativo ${month}/2026`,
        fecha_atencion: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        paciente_rut: p.rut,
        paciente_apellido_paterno: p.paterno,
        paciente_apellido_materno: p.materno,
        paciente_nombres: p.nombres,
        paciente_nombre: `${p.paterno} ${p.materno} ${p.nombres}`,
        paciente_fnac: p.fnac,
        paciente_sexo: p.sexo,
        od_av: pick(['20/20', '20/40', '20/80', 'CD']),
        oi_av: pick(['20/25', '20/30', '20/60']),
        od_hallazgos: r() < 0.4 ? 'Catarata nuclear N2' : '',
        plan: r() < 0.5 ? 'Control en 3 meses' : '',
        medico_nombre: 'Dra. Ejemplo',
      },
      checks: Object.fromEntries(dx.filter(() => r() < 0.3).map((k) => [k, true])),
      proc:
        r() < 0.6
          ? {
              t_aplan: { eye: 'AO', od: String(10 + Math.floor(r() * 20)), oi: String(10 + Math.floor(r() * 20)) },
              fo: { eye: 'AO', desc_od: 'Papila normal' },
            }
          : {},
    });
  });
  return { records, procs: DEFAULT_PROCS };
}

/* ------------------------------------------------------- utilidades */

const median = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const kb = (/** @type {number} */ n) => Math.round(n / 1024);

/** Mediana de `runs` ejecuciones (ms). @param {() => unknown} fn */
async function time(fn, runs = 7) {
  await fn(); // calentamiento
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return median(out);
}

/* ------------------------------------------------------------ tamaño */

function sizes() {
  const html = readFileSync(join(ROOT, 'dist/index.html'));
  const s = html.toString('utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(s)?.[1] || '';
  const style = /<style>([\s\S]*?)<\/style>/.exec(s)?.[1] || '';
  const base64 = [...script.matchAll(/"[A-Za-z0-9+/=]{20000,}"/g)].reduce((a, m) => a + m[0].length, 0);
  return {
    total: kb(html.length),
    gzip: kb(gzipSync(html, { level: 9 }).length),
    brotli: kb(brotliCompressSync(html).length),
    js: kb(Buffer.byteLength(script) - base64),
    plantillas: kb(base64),
    css: kb(Buffer.byteLength(style)),
  };
}

/** KB del JS por origen: cada paquete externo, las plantillas y cada carpeta de src/. */
function composition() {
  const inputs = Object.values(lastBuild.metafile?.outputs || {})[0]?.inputs || {};
  /** @type {Record<string, number>} */
  const g = {};
  for (const [k, v] of Object.entries(inputs)) {
    const key = k.includes('node_modules/')
      ? k
          .split('node_modules/')[1]
          .split('/')
          .slice(0, k.includes('node_modules/@') ? 2 : 1)
          .join('/')
      : k.endsWith('.pdf')
        ? 'plantillas PDF'
        : k
            .replace(/^src\//, '')
            .split('/')
            .slice(0, -1)
            .join('/') + '/';
    const label = key === '/' ? 'src/ (main.js)' : key;
    g[label] = (g[label] || 0) + v.bytesInOutput;
  }
  return Object.entries(g)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => /** @type {[string, number]} */ ([k, kb(v)]));
}

/* -------------------------------------------------------------- Node */

async function nodeBench() {
  const { records, procs } = await dataset();
  const spec = await import('../src/specialties/activa/index.js');
  const { findDuplicatePairs, missingPatients } = await import('../src/core/patient.js');
  const { normalizeRecord } = await import('../src/core/record.js');
  const { buildXlsx } = await import('../src/lib/xlsx.js');
  const { buildBackup } = await import('../src/core/backup.js');
  const patients = missingPatients(records, new Map());
  const template = readFileSync(join(ROOT, 'src/specialties/oftalmologia/plantilla.pdf'));
  return {
    fichas: patients.length,
    'Normalizar 3.000 atenciones': await time(() => records.forEach((r) => normalizeRecord(r))),
    'Estadística (3.000)': await time(() => spec.computeStats(records, procs)),
    'Excel de estadística (3.000)': await time(() => buildXlsx(spec.statsWorkbook(records, procs, {}))),
    'Posibles duplicados (fichas)': await time(() => findDuplicatePairs(patients)),
    'Seudonimizar (3.000)': await time(() => spec.anonymizeRecords(records, procs, { secret: 'a'.repeat(64) }), 3),
    'Nota de una atención': await time(() => spec.buildNote(records[0], procs)),
    'PDF de una atención': await time(() => spec.buildAttentionPdf(template, records[0], procs, {}), 5),
    'Respaldo JSON (3.000)': await time(() => JSON.stringify(buildBackup({ records, procs, patients })), 3),
  };
}

/* --------------------------------------------------------- navegador */

async function browserBench() {
  const { chromium } = await import('@playwright/test');
  const { records, procs } = await dataset();
  const { buildBackup } = await import('../src/core/backup.js');
  const { missingPatients } = await import('../src/core/patient.js');
  const dir = mkdtempSync(join(tmpdir(), 'hhr-perf-'));
  const backup = join(dir, 'respaldo.json');
  writeFileSync(backup, JSON.stringify(buildBackup({ records, procs, patients: missingPatients(records, new Map()) })));

  const port = 8800 + Math.floor(Math.random() * 100);
  const server = spawn(process.execPath, [join(ROOT, 'scripts/dev-server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 800));
  const url = `http://localhost:${port}/`;
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    /** Inicio: desde que empieza la navegación hasta que la app está lista (marca `hhr:listo`). */
    const startup = async () => {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => performance.getEntriesByName('hhr:listo').length > 0);
      return page.evaluate(() => performance.getEntriesByName('hhr:listo')[0].startTime);
    };
    /** Memoria JS tras recolectar basura (MB). */
    const heap = () =>
      page.evaluate(() => /** @type {any} */ (window.gc?.(), /** @type {any} */ (performance).memory?.usedJSHeapSize / 2 ** 20 || 0));
    const emptyStart = [];
    for (let i = 0; i < 5; i++) emptyStart.push(await startup());
    const heapEmpty = await heap();
    // Cargar los datos con un respaldo (como lo haría una persona).
    await page.locator('#brandBtn').click();
    await page.locator('.ajnav').getByRole('tab', { name: 'Datos' }).click();
    await page.locator('#bkImp').setInputFiles(backup);
    await page.locator('#msgDlg').getByRole('button').first().click({ timeout: 60_000 });
    const fullStart = [];
    for (let i = 0; i < 5; i++) fullStart.push(await startup());
    const heapFull = await heap();
    /**
     * Tiempo de una acción (de las de abajo) hasta el siguiente cuadro dibujado.
     * @param {'reg' | 'est' | 'ing' | 'buscar'} what
     */
    const action = async (what) => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        out.push(
          await page.evaluate(async (w) => {
            const t = performance.now();
            const tab = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById('tab-' + id)).click();
            if (w === 'buscar') {
              tab('t-reg');
              const s = /** @type {HTMLInputElement} */ (document.getElementById('regSearch'));
              s.value = 'Pakarati';
              s.dispatchEvent(new Event('input'));
            } else tab('t-' + w);
            await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
            return performance.now() - t;
          }, what),
        );
        await page.evaluate(() => document.getElementById('tab-t-at')?.click());
      }
      return median(out);
    };
    return {
      'Inicio sin datos': median(emptyStart),
      'Inicio con 3.000 atenciones': median(fullStart),
      'Pestaña Pacientes': await action('reg'),
      'Pestaña Reportes': await action('est'),
      'Pestaña Ingreso': await action('ing'),
      'Buscar en Pacientes': await action('buscar'),
      'Memoria JS sin datos (MB)': heapEmpty,
      'Memoria JS con datos (MB)': heapFull,
    };
  } finally {
    await browser.close();
    server.kill();
  }
}

/* ---------------------------------------------------------- informe */

const fmt = (/** @type {number} */ v, unit = 'ms') =>
  unit === 'ms' ? `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` : `${Math.round(v)} ${unit}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite();
  const s = sizes();
  const n = await nodeBench();
  const b = args.includes('--solo-node') ? null : await browserBench();
  const lines = [
    `Tamaño: ${s.total} KB (gzip ${s.gzip} KB, brotli ${s.brotli} KB) · JS ${s.js} KB · plantillas PDF ${s.plantillas} KB · CSS ${s.css} KB`,
    '',
    'Composición del script (KB, minificado):',
    ...composition()
      .filter(([, v]) => v >= 5)
      .map(([k, v]) => `  ${k.padEnd(34)} ${String(v).padStart(4)} KB`),
    '',
    `Núcleo en Node (${N_ATTENTIONS} atenciones, ${n.fichas} fichas; mediana):`,
    ...Object.entries(n)
      .filter(([k]) => k !== 'fichas')
      .map(([k, v]) => `  ${k.padEnd(34)} ${fmt(/** @type {number} */ (v))}`),
  ];
  if (b) {
    lines.push('', 'App en el navegador (Chromium, mediana de 5):');
    for (const [k, v] of Object.entries(b)) lines.push(`  ${k.padEnd(34)} ${k.includes('MB') ? fmt(v, 'MB') : fmt(v)}`);
  }
  console.log(lines.join('\n'));
  if (args.includes('--write')) {
    const file = join(ROOT, 'docs/RENDIMIENTO.md');
    const prev = (() => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    })();
    const marker = '<!-- mediciones -->';
    const head = prev.includes(marker) ? prev.slice(0, prev.indexOf(marker)) : '# Rendimiento\n\n';
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(
      file,
      `${head}${marker}\n\n## Última medición (${date}, versión ${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version})\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`,
    );
    console.log('\ndocs/RENDIMIENTO.md actualizado.');
  }
}
