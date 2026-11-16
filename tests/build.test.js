import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHtml, buildSite, cspOf, cspHash, expandPartials } from '../scripts/build.mjs';

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
