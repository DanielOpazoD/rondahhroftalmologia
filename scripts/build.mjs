#!/usr/bin/env node
/**
 * Construye la aplicación como UN SOLO archivo HTML autocontenido
 * (dist/index.html y su copia dist/Hoja_Atencion_Oftalmologica.html).
 *
 * - Valida la especialidad elegida (ESPECIALIDAD=<id>, por defecto oftalmologia)
 *   contra el contrato de src/specialties/contrato.js.
 * - Empaqueta src/main.js y sus módulos (incluido pdf-lib) con esbuild, con la
 *   especialidad elegida detrás de src/specialties/activa/ (el alias
 *   `#especialidad/` de package.json apunta a ella; ver especialidadPlugin).
 * - Incrusta la plantilla PDF en base64 y el formulario de la especialidad.
 * - Calcula la CSP con el hash del script (sin 'unsafe-inline' para scripts).
 *
 * El resultado funciona sin conexión abriéndolo con doble clic (file://),
 * que es como se usa en terreno.
 *
 * Uso: npm run build   (o: node scripts/build.mjs --out ruta/archivo.html, que escribe solo el HTML)
 *      ESPECIALIDAD=orl node scripts/build.mjs --out /tmp/orl/index.html   (otra especialidad, sin tocar dist/)
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const outFile = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(root, 'dist/Hoja_Atencion_Oftalmologica.html');

/** Especialidad a construir (carpeta en src/specialties/). */
export const especialidadActiva = () => process.env.ESPECIALIDAD || 'oftalmologia';

/** Alias con que src/specialties/activa/ nombra la especialidad (package.json → "imports"). */
const ALIAS = '#especialidad/';

/**
 * Archivo de la especialidad `id` al que apunta `#especialidad/<ruta>`. Node, tsc
 * y ESLint resuelven el alias con package.json ("imports": oftalmología); el
 * build lo resuelve aquí para la especialidad elegida. Falla si el archivo no
 * existe (salvo una plantilla PDF: una especialidad que dibuja su PDF desde
 * cero, p. ej. orl, no la tiene y recibe una plantilla vacía, `null`).
 * @param {string} id
 * @param {string} spec especificador importado (`#especialidad/config.js`)
 * @returns {string | null}
 */
export function specialtyFile(id, spec) {
  if (!spec.startsWith(ALIAS)) throw new Error(`No es un import de la especialidad: ${spec}`);
  const dir = resolve(root, 'src/specialties', id);
  const path = resolve(dir, spec.slice(ALIAS.length));
  if (!path.startsWith(dir + sep)) throw new Error(`${spec} sale de la carpeta de la especialidad "${id}"`);
  if (existsSync(path)) return path;
  if (path.endsWith('plantilla.pdf')) return null;
  throw new Error(`La especialidad "${id}" no tiene ${spec.slice(ALIAS.length)} (lo pide src/specialties/activa/).`);
}

/**
 * Apunta `#especialidad/*` (lo usa solo src/specialties/activa/) a la
 * especialidad elegida. Así la plataforma no conoce la especialidad.
 * @param {string} id
 * @returns {import('esbuild').Plugin}
 */
export const especialidadPlugin = (id) => ({
  name: 'especialidad',
  setup(b) {
    b.onResolve({ filter: /^#especialidad\// }, (args) => {
      const path = specialtyFile(id, args.path);
      return path ? { path } : { path: args.path, namespace: 'sin-plantilla' };
    });
    b.onLoad({ filter: /.*/, namespace: 'sin-plantilla' }, () => ({ contents: "export default '';", loader: 'js' }));
  },
});

/**
 * Fuentes estándar de PDF que la app usa (pdf-lib trae las medidas de las 14;
 * las demás pesan ~85 KB y no se usan). tests/build.test.js verifica que el
 * código solo pida estas. Symbol y ZapfDingbats son pequeñas y se dejan.
 */
export const PDF_FONTS = Object.freeze(['Helvetica', 'Helvetica-Bold', 'Symbol', 'ZapfDingbats']);

/** Deja fuera las medidas de las fuentes estándar que no se usan. @returns {import('esbuild').Plugin} */
const fuentesPlugin = () => ({
  name: 'fuentes-pdf',
  setup(b) {
    b.onLoad({ filter: /@pdf-lib[\\/]standard-fonts[\\/].*[\\/][\w-]+\.compressed\.json$/ }, (args) => {
      const name = /([\w-]+)\.compressed\.json$/.exec(args.path)?.[1] || '';
      if (name === 'all-encodings' || PDF_FONTS.includes(name)) return undefined;
      return { contents: `export default ${JSON.stringify('sin-fuente:' + name)};`, loader: 'js' };
    });
  },
});

/**
 * Verifica el contrato de la especialidad antes de construir (falla si está mal configurada).
 * @param {string} id
 * @returns {Promise<string>} el HTML de su formulario
 */
async function checkSpecialty(id) {
  const dir = resolve(root, 'src/specialties', id);
  const mod = await import(pathToFileURL(resolve(dir, 'index.js')).href);
  const { validateSpecialty } = await import('../src/specialties/contrato.js');
  const formHtml = await readFile(resolve(dir, 'formulario.html'), 'utf8');
  const problems = validateSpecialty(mod, { formHtml });
  if (problems.length) throw new Error(`La especialidad "${id}" no cumple el contrato:\n - ${problems.join('\n - ')}`);
  return formHtml;
}

/** Hash CSP (sha256, base64) del contenido exacto de un bloque inline. @param {string} content */
export const cspHash = (content) => `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`;

/**
 * Política de seguridad de contenido. El único script permitido es el de la
 * app, identificado por su hash: un script inyectado (XSS) no se ejecuta.
 * @param {string} scriptHash @param {string} styleHash
 */
export function contentSecurityPolicy(scriptHash, styleHash) {
  return [
    "default-src 'none'",
    `script-src ${scriptHash}`,
    `style-src ${styleHash}`,
    "img-src 'self' data: blob:",
    'frame-src blob:',
    'object-src blob:',
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** Huella del contenido de la app (código, estilos y HTML), sin depender de sí misma. @param {...string} parts */
export const buildIdOf = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);

/** Compilación que contiene un HTML ya construido (la escribe el build en APP.build). @param {string} html */
export const appBuildOf = (html) => /data-build="([0-9a-f]{12})"/.exec(html)?.[1] || '';

/** @returns {Promise<string>} el HTML final de la app */
/**
 * Expande las plantillas compartidas del HTML: `<!-- @PACIENTE <prefijo> <idSexo> [validar] -->`
 * (los datos del paciente, iguales en Ingreso y Atención; src/partials/paciente.html).
 * @param {string} html
 */
export async function expandPartials(html) {
  const tpl = (await readFile(resolve(root, 'src/partials/paciente.html'), 'utf8')).replace(/^<!--[\s\S]*?-->\n/, '');
  return html.replace(/[ \t]*<!-- @PACIENTE (\w+) (\w+)( validar)? -->\n/g, (_m, p, sexo, validar) =>
    tpl
      .replaceAll('{p}', p)
      .replaceAll('{sexo}', sexo)
      .replace(/\{msg:(\w+)\}/g, (_x, f) => (validar ? `<small class="msg" data-msg="${p}${f}"></small>` : '')),
  );
}

/** Datos de la última compilación (composición del JS, para npm run perf). @type {{metafile: import('esbuild').Metafile | null}} */
export const lastBuild = { metafile: null };

export async function buildHtml() {
  const id = especialidadActiva();
  const formHtml = await checkSpecialty(id);
  const result = await build({
    entryPoints: [resolve(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020', 'safari15'],
    minify: process.env.SIN_MINIFICAR !== '1',
    legalComments: 'inline',
    loader: { '.pdf': 'base64' },
    plugins: [especialidadPlugin(id), fuentesPlugin()],
    write: false,
    metafile: true,
    logLevel: 'warning',
  });
  lastBuild.metafile = result.metafile;
  // Evita que "</script" dentro del código cierre la etiqueta antes de tiempo.
  let js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const html = await expandPartials(await readFile(resolve(root, 'src/index.html'), 'utf8'));
  // Logo del Hospital Hanga Roa: va dentro del HTML (la app es un solo archivo; la CSP admite imágenes data:).
  const logo = `data:image/png;base64,${(await readFile(resolve(root, 'src/assets/logo-hhr.png'))).toString('base64')}`;
  // Identificador de esta compilación, que la app conoce (APP.build) y que el
  // sitio publica en version.json: así un equipo sabe si tiene la última.
  const appBuild = buildIdOf(js, css, html, formHtml);
  js = js.replace('__APP_BUILD__', () => appBuild);
  for (const marker of ['<!-- @STYLES -->', '<!-- @SCRIPT -->', '<!-- @FORMULARIO -->', '<!-- @CSP -->']) {
    if (!html.includes(marker)) throw new Error(`src/index.html debe contener el marcador ${marker}`);
  }
  const scriptBody = `\n${js}`;
  const styleBody = `\n${css}`;
  // Solo el script y la hoja de estilos de la app, identificados por su hash (sin 'unsafe-inline').
  const csp = contentSecurityPolicy(cspHash(scriptBody), cspHash(styleBody));
  // Funciones de reemplazo: evitan que "$&" u otros patrones del código se interpreten.
  return html
    .replace('<html', () => `<html data-build="${appBuild}"`)
    .replace('<!-- @CSP -->', () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('<!-- @FORMULARIO -->', () => formHtml)
    .replaceAll('@LOGO_HHR', () => logo)
    .replace('<!-- @STYLES -->', () => `<style>${styleBody}</style>`)
    .replace('<!-- @SCRIPT -->', () => `<script>${scriptBody}</script>`);
}

/** Extrae la CSP del HTML construido (para repetirla como cabecera HTTP). @param {string} html */
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
  // Versión publicada: los equipos la comparan con la que tienen abierta.
  await writeFile(resolve(outDir, 'version.json'), JSON.stringify({ version: pkg.version, build: appBuildOf(html) }) + '\n');
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
    // dist/ es el sitio publicado de oftalmología: otra especialidad se construye aparte (dist-<id>/).
    const id = especialidadActiva();
    const dir = id === 'oftalmologia' ? 'dist' : `dist-${id}`;
    const { html, buildId } = await buildSite(resolve(root, dir));
    console.log(`✔ ${dir}/ (index.html ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB, build ${buildId})`);
  }
}
