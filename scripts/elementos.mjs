#!/usr/bin/env node
/**
 * Tipo de cada elemento de la plantilla, por su id (src/ui/elements.d.ts).
 *
 *   npm run elementos            → revisa que src/ui/elements.d.ts esté al día (falla si no)
 *   npm run elementos -- --write → lo vuelve a generar
 *
 * `$('#id')` de src/ui/dom.js toma de aquí el tipo del elemento: un
 * `<input id="x">` da HTMLInputElement, y así el verificador de tipos revisa
 * cada `.value`, `.checked` o `.showModal()` contra el elemento real.
 *
 * Lee src/index.html con los datos del paciente ya expandidos (como el build)
 * y, de los formulario.html de las especialidades, solo los ids que están en
 * todos con la misma etiqueta: la interfaz es común y solo puede contar con
 * esos. La prueba tests/elementos.test.js falla si el archivo no está al día.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandPartials } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'src/ui/elements.d.ts');

/**
 * Etiquetas con un tipo propio que la interfaz aprovecha (valor, casillas,
 * diálogos…). Las demás quedan como HTMLElement, que basta para texto, clases
 * y atributos.
 * @type {Readonly<Record<string, string>>}
 */
export const TIPOS = Object.freeze({
  input: 'HTMLInputElement',
  select: 'HTMLSelectElement',
  textarea: 'HTMLTextAreaElement',
  button: 'HTMLButtonElement',
  dialog: 'HTMLDialogElement',
  details: 'HTMLDetailsElement',
  form: 'HTMLFormElement',
  label: 'HTMLLabelElement',
  a: 'HTMLAnchorElement',
  img: 'HTMLImageElement',
  canvas: 'HTMLCanvasElement',
  output: 'HTMLOutputElement',
  progress: 'HTMLProgressElement',
  fieldset: 'HTMLFieldSetElement',
  option: 'HTMLOptionElement',
  // Íconos: no son elementos HTML, sino de SVG.
  svg: 'SVGSVGElement',
  symbol: 'SVGSymbolElement',
});

/**
 * Ids de un HTML y su etiqueta (sin contar los comentarios).
 * @param {string} html
 * @returns {Map<string, string>} id → etiqueta en minúsculas
 */
export function idsOf(html) {
  const sinComentarios = html.replace(/<!--[\s\S]*?-->/g, '');
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const m of sinComentarios.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*?\sid="([^"]+)"/g)) {
    const [, tag, id] = m;
    if (out.has(id)) throw new Error(`id repetido en la plantilla: ${id}`);
    out.set(id, tag.toLowerCase());
  }
  return out;
}

/**
 * Ids de la plantilla que la interfaz puede usar: los de index.html y los que
 * están en el formulario de todas las especialidades con la misma etiqueta.
 * @param {string} root carpeta del repositorio
 * @returns {Promise<Map<string, string>>} id → etiqueta
 */
export async function templateIds(root = ROOT) {
  const ids = idsOf(await expandPartials(readFileSync(join(root, 'src/index.html'), 'utf8')));
  const dir = join(root, 'src/specialties');
  const forms = readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'formulario.html')))
    .map((d) => idsOf(readFileSync(join(dir, d, 'formulario.html'), 'utf8')));
  for (const [id, tag] of forms[0] || []) {
    if (!forms.every((f) => f.get(id) === tag)) continue;
    if (ids.has(id)) throw new Error(`id repetido entre index.html y formulario.html: ${id}`);
    ids.set(id, tag);
  }
  return ids;
}

/**
 * Contenido de src/ui/elements.d.ts (ya con el formato de Prettier).
 * @param {Map<string, string>} ids id → etiqueta
 */
export function renderTypes(ids) {
  const lines = [...ids].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, tag]) => `  '#${id}': ${TIPOS[tag] || 'HTMLElement'};`);
  return [
    '/**',
    ' * Tipo de cada elemento de la plantilla, por su id. `$` de ./dom.js lo usa',
    " * para que `$('#id')` tenga el tipo del elemento real.",
    ' *',
    ' * Generado por `npm run elementos -- --write` (scripts/elementos.mjs) a partir',
    ' * de src/index.html y de los formulario.html de las especialidades: no se edita',
    ' * a mano. tests/elementos.test.js falla si no está al día.',
    ' */',
    'export interface ElementosPorId {',
    ...lines,
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = renderTypes(await templateIds());
  if (process.argv.includes('--write')) {
    writeFileSync(OUT, text);
    console.log('src/ui/elements.d.ts actualizado.');
  } else if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('src/ui/elements.d.ts no está al día con la plantilla: npm run elementos -- --write');
    process.exit(1);
  } else {
    console.log('src/ui/elements.d.ts está al día.');
  }
}
