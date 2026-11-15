import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml } from '../scripts/build.mjs';

test('el build produce un HTML autocontenido y sin recursos externos', async () => {
  const html = await buildHtml();
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('<!-- @STYLES -->') && !html.includes('<!-- @SCRIPT -->'));
  assert.match(html, /Content-Security-Policy[^>]+connect-src 'none'/);
  assert.ok(!/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html), 'no carga recursos de internet');
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'un solo bloque de script');
  assert.ok(html.includes('JVBERi0'), 'plantilla PDF incrustada');
  assert.ok(html.length > 1_000_000 && html.length < 6_000_000);
});
