#!/usr/bin/env node
/**
 * Construye la aplicación como UN SOLO archivo HTML autocontenido
 * (dist/index.html y su copia dist/Hoja_Atencion_Oftalmologica.html).
 *
 * - Empaqueta src/main.js y sus módulos (incluido pdf-lib) con esbuild.
 * - Incrusta la plantilla PDF en base64.
 * - Inserta CSS y JS en src/index.html.
 *
 * El resultado funciona sin conexión abriéndolo con doble clic (file://),
 * que es como se usa en terreno.
 *
 * Uso: npm run build   (o: node scripts/build.mjs --out ruta/archivo.html)
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const outFile = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(root, 'dist/Hoja_Atencion_Oftalmologica.html');

export async function buildHtml() {
  const result = await build({
    entryPoints: [resolve(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020', 'safari15'],
    minify: true,
    legalComments: 'inline',
    loader: { '.pdf': 'base64' },
    write: false,
    logLevel: 'warning',
  });
  // Evita que "</script" dentro del código cierre la etiqueta antes de tiempo.
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const html = await readFile(resolve(root, 'src/index.html'), 'utf8');
  if (!html.includes('<!-- @STYLES -->') || !html.includes('<!-- @SCRIPT -->')) {
    throw new Error('src/index.html debe contener los marcadores <!-- @STYLES --> y <!-- @SCRIPT -->');
  }
  // Funciones de reemplazo: evitan que "$&" u otros patrones del código se interpreten.
  return html.replace('<!-- @STYLES -->', () => `<style>\n${css}</style>`).replace('<!-- @SCRIPT -->', () => `<script>\n${js}</script>`);
}

/**
 * Escribe el sitio completo en dist/:
 *   index.html                       la app (lo que sirve Netlify)
 *   Hoja_Atencion_Oftalmologica.html copia idéntica para usar con doble clic, sin servidor
 *   sw.js, manifest.webmanifest, icon.svg   uso sin conexión desde la web (PWA)
 */
export async function buildSite(outDir = resolve(root, 'dist')) {
  const html = await buildHtml();
  const buildId = createHash('sha256').update(html).digest('hex').slice(0, 12);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'index.html'), html);
  await writeFile(resolve(outDir, 'Hoja_Atencion_Oftalmologica.html'), html);
  for (const name of await readdir(resolve(root, 'public'))) {
    let content = await readFile(resolve(root, 'public', name), 'utf8');
    if (name === 'sw.js') content = content.replace('__BUILD_ID__', buildId);
    await writeFile(resolve(outDir, name), content);
  }
  return { html, buildId };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (outArg > -1) {
    const html = await buildHtml();
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, html);
    console.log(`✔ ${outFile}`);
  } else {
    const { html, buildId } = await buildSite();
    console.log(`✔ dist/ (index.html ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB, build ${buildId})`);
  }
}
