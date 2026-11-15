import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, join, setHtml, SafeHtml } from '../src/ui/html.js';

test('html escapa los valores interpolados (< > & " \')', () => {
  const name = `Ana & <Bo> "x" 'y'`;
  assert.equal(
    String(html`<b title="${name}">${name}</b>`),
    '<b title="Ana &amp; &lt;Bo&gt; &quot;x&quot; &#39;y&#39;">Ana &amp; &lt;Bo&gt; &quot;x&quot; &#39;y&#39;</b>',
  );
  assert.equal(String(html`<i>${'<script>alert(1)</script>'}</i>`), '<i>&lt;script&gt;alert(1)&lt;/script&gt;</i>');
});

test('fragmentos anidados no se escapan dos veces', () => {
  const inner = html`<span>${'a & b'}</span>`;
  assert.equal(String(html`<div>${inner}</div>`), '<div><span>a &amp; b</span></div>');
  assert.ok(!String(html`<div>${inner}</div>`).includes('&amp;amp;'));
});

test('arreglos se concatenan; null, undefined y false no escriben; 0 sí', () => {
  const items = ['x<', 'y'].map((t) => html`<li>${t}</li>`);
  assert.equal(String(html`<ul>${items}</ul>`), '<ul><li>x&lt;</li><li>y</li></ul>');
  assert.equal(String(html`${null}${undefined}${false}|${0}|${''}`), '|0|');
  assert.equal(String(html`${['a&', html`<b>b</b>`]}`), 'a&amp;<b>b</b>');
});

test('raw pasa sin escapar (solo para marcado del código)', () => {
  assert.equal(String(html`${raw('<svg><use href="#i-x"/></svg>')}`), '<svg><use href="#i-x"/></svg>');
  assert.ok(raw('x') instanceof SafeHtml);
});

test('join escapa el separador y respeta fragmentos', () => {
  assert.equal(String(join(['a<', html`<b>b</b>`], ' & ')), 'a&lt; &amp; <b>b</b>');
});

test('setHtml acepta solo plantillas seguras', () => {
  const el = /** @type {any} */ ({ innerHTML: '' });
  setHtml(el, html`<p>${'<x>'}</p>`);
  assert.equal(el.innerHTML, '<p>&lt;x&gt;</p>');
  assert.throws(() => setHtml(el, /** @type {any} */ ('<p>texto</p>')), TypeError);
  assert.equal(el.innerHTML, '<p>&lt;x&gt;</p>', 'no cambia si se rechaza');
});
