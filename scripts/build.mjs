#!/usr/bin/env node
/**
 * Construye la aplicación como UN SOLO archivo HTML autocontenido:
 *   dist/Hoja_Atencion_Oftalmologica.html
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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = await buildHtml();
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, html);
  console.log(`✔ ${outFile} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
}
