/**
 * Texto para PDF (común a todas las especialidades): ajuste de líneas al ancho
 * con las fuentes estándar de pdf-lib. No depende de pdf-lib: basta un objeto
 * con `widthOfTextAtSize` (la fuente incrustada).
 */
import { toWinAnsi } from './format.js';

/** @typedef {{widthOfTextAtSize(text: string, size: number): number}} MedidorTexto */

/**
 * Divide un texto en líneas que caben en `width` con la fuente y tamaño dados.
 * Respeta saltos de línea y corta palabras demasiado largas.
 * @param {string} text
 * @param {MedidorTexto} font
 * @param {number} size
 * @param {number} width
 * @returns {string[]}
 */
export function wrapText(text, font, size, width) {
  const out = [];
  const max = width - 4;
  for (const par of toWinAnsi(text).split('\n')) {
    let line = '';
    for (let word of par.split(/\s+/).filter(Boolean)) {
      const candidate = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= max) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      while (font.widthOfTextAtSize(word, size) > max && word.length > 1) {
        let i = word.length;
        while (i > 1 && font.widthOfTextAtSize(word.slice(0, i), size) > max) i--;
        out.push(word.slice(0, i));
        word = word.slice(i);
      }
      line = word;
    }
    if (line) out.push(line);
  }
  return out;
}
