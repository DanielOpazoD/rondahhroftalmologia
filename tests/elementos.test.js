import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { idsOf, renderTypes, templateIds, OUT } from '../scripts/elementos.mjs';

test('elementos: src/ui/elements.d.ts está al día con la plantilla', async () => {
  const expected = renderTypes(await templateIds());
  assert.equal(readFileSync(OUT, 'utf8'), expected, 'src/ui/elements.d.ts no está al día: npm run elementos -- --write');
});

test('elementos: cada id tiene el tipo de su etiqueta', async () => {
  const ids = await templateIds();
  const text = renderTypes(ids);
  // De index.html, de los datos del paciente (plantilla compartida) y del formulario de la especialidad.
  assert.match(text, /'#syncPass': HTMLInputElement;/);
  assert.match(text, /'#dlg': HTMLDialogElement;/);
  assert.match(text, /'#ing_rut': HTMLInputElement;/);
  assert.match(text, /'#catSeg': HTMLElement;/);
  assert.match(text, /'#i-eye': SVGSymbolElement;/);
  // Solo los ids de formulario.html que tienen todas las especialidades.
  assert.equal(ids.has('od_av'), false, 'solo en el formulario de oftalmología');
  assert.equal(ids.get('motivo_consulta'), 'textarea', 'en el de todas');
});

test('elementos: idsOf lee la etiqueta, ignora comentarios y rechaza ids repetidos', () => {
  const ids = idsOf('<!-- <input id="viejo"> --><SELECT class="x" id="a"></SELECT><div data-id="no" id="b"></div>');
  assert.deepEqual(
    [...ids],
    [
      ['a', 'select'],
      ['b', 'div'],
    ],
  );
  assert.throws(() => idsOf('<p id="x"></p><span id="x"></span>'), /id repetido en la plantilla: x/);
});
