#!/usr/bin/env node
/**
 * Construye la aplicación como UN SOLO archivo HTML autocontenido
 * (dist/index.html y su copia dist/Hoja_Atencion_Oftalmologica.html).
 *
 * - Valida la especialidad elegida (ESPECIALIDAD=<id>, por defecto oftalmologia)
 *   contra el contrato de src/specialties/contrato.js.
 * - Empaqueta src/main.js y sus módulos (incluido pdf-lib) con esbuild, con la
 *   especialidad elegida detrás de src/specialties/activa/.
 * - Incrusta la plantilla PDF en base64 y el formulario de la especialidad.
 * - Calcula la CSP con el hash del script (sin 'unsafe-inline' para scripts).
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
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const outFile = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(root, 'dist/Hoja_Atencion_Oftalmologica.html');

/** Especialidad a construir (carpeta en src/specialties/). */
export const especialidadActiva = () => process.env.ESPECIALIDAD || 'oftalmologia';

/**
 * Redirige src/specialties/activa/* a la especialidad elegida
 * (por defecto oftalmologia). Así la plataforma no conoce la especialidad.
 */
const especialidadPlugin = (id) => ({
  name: 'especialidad',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/oftalmologia\// }, (args) => {
      if (!args.importer.includes(`${'/'}specialties${'/'}activa${'/'}`)) return undefined;
      return { path: resolve(root, 'src/specialties', id, args.path.replace('../oftalmologia/', '')) };
    });
  },
});

/** Verifica el contrato de la especialidad antes de construir (falla si está mal configurada). */
async function checkSpecialty(id) {
  const dir = resolve(root, 'src/specialties', id);
  const mod = await import(pathToFileURL(resolve(dir, 'index.js')).href);
  const { validateSpecialty } = await import(pathToFileURL(resolve(root, 'src/specialties/contrato.js')).href);
  const formHtml = await readFile(resolve(dir, 'formulario.html'), 'utf8');
  const problems = validateSpecialty(mod, { formHtml });
  if (problems.length) throw new Error(`La especialidad "${id}" no cumple el contrato:\n - ${problems.join('\n - ')}`);
  return formHtml;
}

/** Hash CSP (sha256, base64) del contenido exacto de un bloque inline. */
export const cspHash = (content) => `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`;

/**
 * Política de seguridad de contenido. El único script permitido es el de la
 * app, identificado por su hash: un script inyectado (XSS) no se ejecuta.
 */
export function contentSecurityPolicy(scriptHash) {
  return [
    "default-src 'none'",
    `script-src ${scriptHash}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** @returns {Promise<string>} el HTML final de la app */
export async function buildHtml() {
  const id = especialidadActiva();
  const formHtml = await checkSpecialty(id);
  const result = await build({
    entryPoints: [resolve(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020', 'safari15'],
    minify: true,
    legalComments: 'inline',
    loader: { '.pdf': 'base64' },
    plugins: [especialidadPlugin(id)],
    write: false,
    logLevel: 'warning',
  });
  // Evita que "</script" dentro del código cierre la etiqueta antes de tiempo.
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const html = await readFile(resolve(root, 'src/index.html'), 'utf8');
  for (const marker of ['<!-- @STYLES -->', '<!-- @SCRIPT -->', '<!-- @FORMULARIO -->', '<!-- @CSP -->']) {
    if (!html.includes(marker)) throw new Error(`src/index.html debe contener el marcador ${marker}`);
  }
  const scriptBody = `\n${js}`;
  const csp = contentSecurityPolicy(cspHash(scriptBody));
  // Funciones de reemplazo: evitan que "$&" u otros patrones del código se interpreten.
  return html
    .replace('<!-- @CSP -->', () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('<!-- @FORMULARIO -->', () => formHtml)
    .replace('<!-- @STYLES -->', () => `<style>\n${css}</style>`)
    .replace('<!-- @SCRIPT -->', () => `<script>${scriptBody}</script>`);
}

/** Extrae la CSP del HTML construido (para repetirla como cabecera HTTP). */
export function cspOf(html) {
  return /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';
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
  // Cabeceras HTTP para Netlify: la misma CSP (con el hash del script) y protección contra iframes.
  await writeFile(resolve(outDir, '_headers'), `/*\n  Content-Security-Policy: ${cspOf(html)}; frame-ancestors 'none'\n`);
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
