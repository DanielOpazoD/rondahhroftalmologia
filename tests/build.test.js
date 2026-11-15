import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHtml, buildSite } from '../scripts/build.mjs';

test('el build produce un HTML autocontenido y sin recursos externos', async () => {
  const html = await buildHtml();
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('<!-- @STYLES -->') && !html.includes('<!-- @SCRIPT -->'));
  assert.match(html, /Content-Security-Policy[^>]+connect-src 'self'/, 'solo puede conectarse con su propio servidor');
  assert.ok(!/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html), 'no carga recursos de internet');
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'un solo bloque de script');
  assert.ok(html.includes('JVBERi0'), 'plantilla PDF incrustada');
  assert.ok(html.length > 1_000_000 && html.length < 6_000_000);
});

test('cada id que usa la interfaz existe en el HTML', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const dir = new URL('../src/ui/', import.meta.url);
  const sources = [
    ...readdirSync(dir).map((f) => readFileSync(new URL(f, dir), 'utf8')),
    readFileSync(new URL('../src/main.js', import.meta.url), 'utf8'),
  ];
  const ids = new Set(sources.flatMap((s) => [...s.matchAll(/\$\('#([A-Za-z0-9_]+)/g)].map((m) => m[1])));
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('la interfaz no usa alert/confirm/prompt del navegador (usa ui/modal.js)', () => {
  const dir = new URL('../src/ui/', import.meta.url);
  const offenders = readdirSync(dir).filter((f) =>
    /(^|[^\w.])(window\.)?(alert|confirm|prompt)\(/.test(readFileSync(new URL(f, dir), 'utf8')),
  );
  assert.deepEqual(offenders, []);
});

test('buildSite escribe el sitio para Netlify con service worker versionado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oft-site-'));
  const { buildId } = await buildSite(dir);
  assert.deepEqual(readdirSync(dir).sort(), [
    'Hoja_Atencion_Oftalmologica.html',
    'icon.svg',
    'index.html',
    'manifest.webmanifest',
    'sw.js',
  ]);
  const sw = readFileSync(join(dir, 'sw.js'), 'utf8');
  assert.ok(sw.includes(`oftalmo-${buildId}`) && !sw.includes('__BUILD_ID__'));
  assert.ok(sw.includes("startsWith('/api/')"), 'la API no se guarda en caché');
  JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8'));
});
