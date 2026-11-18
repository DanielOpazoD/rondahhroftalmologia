import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildHtml, buildSite, cspOf, cspHash, expandPartials, PDF_FONTS, specialtyFile, especialidadPlugin } from '../scripts/build.mjs';
import pkg from '../package.json' with { type: 'json' };

test('el build produce un HTML autocontenido y sin recursos externos', async () => {
  const html = await buildHtml();
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('<!-- @STYLES -->') && !html.includes('<!-- @SCRIPT -->'));
  assert.match(html, /Content-Security-Policy[^>]+connect-src 'self'/, 'solo puede conectarse con su propio servidor');
  // El único script permitido es el de la app, por su hash (sin 'unsafe-inline').
  const csp = cspOf(html);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'script-src sin unsafe-inline');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  assert.ok(csp.includes(cspHash(script)), 'el hash de la CSP corresponde al script incrustado');
  assert.ok(!/<!-- @(CSP|FORMULARIO|STYLES|SCRIPT) -->/.test(html), 'sin marcadores sin reemplazar');
  assert.ok(!/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html), 'no carga recursos de internet');
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'un solo bloque de script');
  assert.ok(html.includes('JVBERi0'), 'plantilla PDF incrustada');
  assert.ok(html.includes('id="motivo_consulta"'), 'formulario de la especialidad incrustado');
  assert.ok(html.length > 1_000_000 && html.length < 6_000_000);
});

/** Archivos .js de la interfaz (incluye subcarpetas como ui/actions/). */
const uiFiles = () => {
  const dir = new URL('../src/ui/', import.meta.url);
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, text: readFileSync(new URL(f, dir), 'utf8') }));
};

test('cada id que usa la interfaz existe en el HTML', async () => {
  const html =
    (await expandPartials(readFileSync(new URL('../src/index.html', import.meta.url), 'utf8'))) +
    readFileSync(new URL('../src/specialties/oftalmologia/formulario.html', import.meta.url), 'utf8');
  const sources = [...uiFiles().map((f) => f.text), readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')];
  const ids = new Set(sources.flatMap((s) => [...s.matchAll(/\$\('#([A-Za-z0-9_-]+)/g)].map((m) => m[1])));
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('la interfaz no usa alert/confirm/prompt del navegador (usa ui/modal.js)', () => {
  const offenders = uiFiles()
    .filter((f) => /(^|[^\w.])(window\.)?(alert|confirm|prompt)\(/.test(f.text))
    .map((f) => f.name);
  assert.deepEqual(offenders, []);
});

test('buildSite escribe el sitio para Netlify con service worker versionado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oft-site-'));
  const { buildId } = await buildSite(dir);
  assert.deepEqual(readdirSync(dir).sort(), [
    'Hoja_Atencion_Oftalmologica.html',
    '_headers',
    'icon.svg',
    'index.html',
    'manifest.webmanifest',
    'sw.js',
    'version.json',
  ]);
  const pub = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'));
  assert.match(pub.build, /^[0-9a-f]{12}$/);
  assert.ok(readFileSync(join(dir, 'index.html'), 'utf8').includes(`data-build="${pub.build}"`), 'la app conoce su compilación');
  const sw = readFileSync(join(dir, 'sw.js'), 'utf8');
  assert.ok(sw.includes(`oftalmo-${buildId}`) && !sw.includes('__BUILD_ID__'));
  assert.ok(sw.includes("startsWith('/api/')"), 'la API no se guarda en caché');
  JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8'));
  const headers = readFileSync(join(dir, '_headers'), 'utf8');
  assert.match(headers, /Content-Security-Policy: default-src 'none'; script-src 'sha256-/);
  // Estilos: solo la hoja de la app, por su hash (sin 'unsafe-inline').
  assert.ok(!headers.includes('unsafe-inline'), "sin 'unsafe-inline'");
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(headers.includes(`style-src ${cspHash(style)}`), 'el hash de estilos corresponde a la hoja incluida');
  assert.ok(!/\sstyle="/.test(html), 'sin atributos style en el HTML');
  assert.match(headers, /frame-ancestors 'none'/);
});

test('datos del paciente: una sola plantilla para Ingreso y Atención (solo la atención valida)', async () => {
  const html = await expandPartials(readFileSync(new URL('../src/index.html', import.meta.url), 'utf8'));
  assert.ok(!html.includes('@PACIENTE'));
  for (const f of ['rut', 'nombre', 'fono', 'fnac', 'edad']) {
    assert.ok(html.includes(`id="ing_${f}"`) && html.includes(`id="paciente_${f}"`), f);
  }
  assert.ok(html.includes('data-msg="paciente_rut"'));
  assert.ok(!html.includes('data-msg="ing_rut"'));
  assert.ok(html.includes('id="ingSexo"') && html.includes('id="sexSeg"'));
});

test('PDF: el código solo usa fuentes estándar incluidas en el build (PDF_FONTS)', () => {
  // El build deja fuera las medidas de las fuentes que no están en PDF_FONTS (scripts/build.mjs).
  const names = {
    Helvetica: 'Helvetica',
    HelveticaBold: 'Helvetica-Bold',
    HelveticaOblique: 'Helvetica-Oblique',
    HelveticaBoldOblique: 'Helvetica-BoldOblique',
    Courier: 'Courier',
    CourierBold: 'Courier-Bold',
    CourierOblique: 'Courier-Oblique',
    CourierBoldOblique: 'Courier-BoldOblique',
    TimesRoman: 'Times-Roman',
    TimesRomanBold: 'Times-Bold',
    TimesRomanItalic: 'Times-Italic',
    TimesRomanBoldItalic: 'Times-BoldItalic',
    Symbol: 'Symbol',
    ZapfDingbats: 'ZapfDingbats',
  };
  const walk = (/** @type {string} */ dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
    );
  const used = new Set();
  for (const f of walk(new URL('../src', import.meta.url).pathname)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/StandardFonts\.(\w+)/g)) used.add(m[1]);
  }
  assert.ok(used.size > 0);
  for (const k of used) {
    assert.ok(
      PDF_FONTS.includes(names[/** @type {keyof typeof names} */ (k)]),
      `StandardFonts.${k} no está en PDF_FONTS (scripts/build.mjs)`,
    );
  }
});

test('especialidad activa: #especialidad/ apunta a la carpeta elegida y falla fuerte si falta un archivo', async () => {
  const dir = (/** @type {string} */ id) => fileURLToPath(new URL(`../src/specialties/${id}/`, import.meta.url));
  // Sin build (Node, tsc, ESLint), package.json apunta a oftalmología.
  assert.deepEqual(pkg.imports, { '#especialidad/*': './src/specialties/oftalmologia/*' });
  assert.equal(specialtyFile('orl', '#especialidad/config.js'), join(dir('orl'), 'config.js'));
  assert.equal(specialtyFile('oftalmologia', '#especialidad/plantilla.pdf'), join(dir('oftalmologia'), 'plantilla.pdf'));
  // Plantilla PDF opcional: una especialidad sin ella recibe una vacía.
  assert.equal(specialtyFile('orl', '#especialidad/plantilla.pdf'), null);
  assert.throws(() => specialtyFile('orl', '#especialidad/no-existe.js'), /La especialidad "orl" no tiene no-existe\.js/);
  assert.throws(() => specialtyFile('noexiste', '#especialidad/config.js'), /La especialidad "noexiste" no tiene config\.js/);
  assert.throws(() => specialtyFile('orl', '#especialidad/../oftalmologia/config.js'), /sale de la carpeta/);
  // En el build, el error detiene la compilación (antes, un import que no se redirigía caía en silencio en oftalmología).
  await assert.rejects(
    build({
      stdin: { contents: "export * from '#especialidad/no-existe.js';", resolveDir: dir('activa') },
      bundle: true,
      write: false,
      logLevel: 'silent',
      plugins: [especialidadPlugin('orl')],
    }),
    /no tiene no-existe\.js/,
  );
});

test('el build de otra especialidad (orl) usa su formulario y no incluye plantillas PDF', async () => {
  const before = process.env.ESPECIALIDAD;
  process.env.ESPECIALIDAD = 'orl';
  try {
    const html = await buildHtml();
    assert.ok(html.includes('id="otoscopia_od"'), 'formulario de ORL');
    assert.ok(!html.includes('JVBERi0'), 'sin plantillas PDF (ORL dibuja su PDF desde cero)');
  } finally {
    if (before === undefined) delete process.env.ESPECIALIDAD;
    else process.env.ESPECIALIDAD = before;
  }
});
