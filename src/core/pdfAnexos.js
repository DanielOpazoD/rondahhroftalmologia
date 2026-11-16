/**
 * PDF con anexos: la hoja de la atención seguida de sus adjuntos, en un solo
 * documento (sin DOM: recibe bytes; las imágenes que el PDF no admite las
 * convierte antes la interfaz).
 *
 *   1. la hoja de la atención (sin cambios);
 *   2. una página «Anexos» con el índice: cada archivo y dónde está;
 *   3. cada imagen (JPEG/PNG) en su página, con su título;
 *   4. cada PDF adjunto, con todas sus páginas;
 *   5. lo que no se puede mostrar como página (Word, Excel…) va INCRUSTADO en
 *      el PDF: se abre desde el panel de adjuntos del visor (Acrobat, Vista
 *      Previa, Edge, Firefox). El índice lo indica.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { toWinAnsi } from './format.js';

const A4 = /** @type {[number, number]} */ ([595.28, 841.89]);
const MARGIN = 40;
const GRAY = rgb(0.38, 0.42, 0.48);

/**
 * @typedef {{nombre: string, tipo: string, bytes: Uint8Array | null, como: 'imagen-jpg' | 'imagen-png' | 'pdf' | 'incrustar'}} Anexo
 *   `bytes` null: el contenido no está en este equipo (se informa en el índice).
 */

/** Texto que las fuentes estándar del PDF pueden escribir. @param {string} s */
const safe = (s) => toWinAnsi(s).replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

/**
 * «página 5» o «páginas 5 a 7».
 * @param {number} first primera página
 * @param {number} count cuántas páginas
 * @returns {string}
 */
const pagesWhere = (first, count) => (count === 1 ? `página ${first}` : `páginas ${first} a ${first + count - 1}`);

/**
 * Agrega una página con la imagen de un anexo (JPEG/PNG), con su título,
 * ajustada a los márgenes.
 * @param {PDFDocument} doc
 * @param {Anexo} a
 * @param {Uint8Array} bytes contenido de la imagen
 * @param {number} n número del anexo
 * @param {import('pdf-lib').PDFFont} bold
 */
async function addImagePage(doc, a, bytes, n, bold) {
  const img = a.como === 'imagen-jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  const page = doc.addPage(A4);
  const top = page.getHeight() - MARGIN - 18;
  page.drawText(safe(`Anexo ${n}: ${a.nombre}`).slice(0, 90), { x: MARGIN, y: top, size: 11, font: bold });
  const maxW = page.getWidth() - 2 * MARGIN;
  const maxH = top - MARGIN - 12;
  const s = Math.min(maxW / img.width, maxH / img.height, 1.5);
  const w = img.width * s;
  const h = img.height * s;
  page.drawImage(img, { x: (page.getWidth() - w) / 2, y: top - 12 - h, width: w, height: h });
}

/**
 * Agrega todas las páginas de un PDF adjunto; la primera lleva un título pequeño arriba.
 * @param {PDFDocument} doc
 * @param {Uint8Array} bytes contenido del PDF adjunto
 * @param {string} title
 * @param {import('pdf-lib').PDFFont} font
 * @returns {Promise<number>} cuántas páginas se agregaron
 */
async function addPdfPages(doc, bytes, title, font) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = await doc.copyPages(src, src.getPageIndices());
  pages.forEach((p, i) => {
    doc.addPage(p);
    if (i === 0) p.drawText(safe(title).slice(0, 110), { x: MARGIN, y: p.getHeight() - 22, size: 8, font, color: GRAY });
  });
  return pages.length;
}

/**
 * Dibuja el índice de anexos en su página.
 * @param {import('pdf-lib').PDFPage} page
 * @param {string} titulo
 * @param {{n: number, nombre: string, donde: string}[]} index
 * @param {boolean} hasEmbedded ¿hay archivos incrustados? (se explica dónde abrirlos)
 * @param {{font: import('pdf-lib').PDFFont, bold: import('pdf-lib').PDFFont}} fonts
 */
function drawIndex(page, titulo, index, hasEmbedded, { font, bold }) {
  let y = page.getHeight() - MARGIN - 10;
  page.drawText(safe(titulo), { x: MARGIN, y, size: 15, font: bold });
  y -= 26;
  for (const it of index) {
    if (y < MARGIN + 20) break; // con 30 adjuntos como máximo, cabe en una página
    page.drawText(safe(`${it.n}. ${it.nombre}`).slice(0, 95), { x: MARGIN, y, size: 10.5, font: bold });
    y -= 14;
    page.drawText(safe(it.donde), { x: MARGIN + 14, y, size: 9.5, font, color: GRAY });
    y -= 20;
  }
  if (hasEmbedded) {
    const note = 'Los archivos «dentro del PDF» se abren desde el panel de adjuntos del visor (clip o «Adjuntos»).';
    page.drawText(safe(note), { x: MARGIN, y: MARGIN, size: 8.5, font, color: GRAY });
  }
}

/**
 * @param {Uint8Array} baseBytes PDF de la hoja de la atención
 * @param {Anexo[]} anexos
 * @param {{titulo?: string, now?: Date}} [o]
 * @returns {Promise<{bytes: Uint8Array, paginas: number, incrustados: string[], faltantes: string[], ilegibles: string[]}>}
 */
export async function appendAnnexes(baseBytes, anexos, { titulo = 'Anexos', now = new Date() } = {}) {
  const doc = await PDFDocument.load(baseBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const basePages = doc.getPageCount();
  /** @type {{n: number, nombre: string, donde: string}[]} */
  const index = [];
  /** @type {string[]} */
  const incrustados = [];
  /** @type {string[]} */
  const faltantes = [];
  /** @type {string[]} */
  const ilegibles = [];

  /** @param {Anexo} a @param {number} n */
  const embed = async (a, n) => {
    await doc.attach(/** @type {Uint8Array} */ (a.bytes), safe(a.nombre), {
      mimeType: a.tipo || 'application/octet-stream',
      description: `Anexo ${n}`,
      creationDate: now,
      modificationDate: now,
    });
    incrustados.push(a.nombre);
    index.push({ n, nombre: a.nombre, donde: 'archivo dentro del PDF (panel de adjuntos del visor)' });
  };

  let n = 0;
  for (const a of anexos) {
    n++;
    if (!a.bytes) {
      faltantes.push(a.nombre);
      index.push({ n, nombre: a.nombre, donde: 'no disponible en este equipo (aún no se sincroniza)' });
      continue;
    }
    // Las páginas del anexo empiezan después de la hoja y del índice (que se inserta al final).
    const first = doc.getPageCount() + 2;
    try {
      if (a.como === 'imagen-jpg' || a.como === 'imagen-png') {
        await addImagePage(doc, a, a.bytes, n, bold);
        index.push({ n, nombre: a.nombre, donde: pagesWhere(first, 1) });
      } else if (a.como === 'pdf') {
        const count = await addPdfPages(doc, a.bytes, `Anexo ${n}: ${a.nombre}`, font);
        index.push({ n, nombre: a.nombre, donde: pagesWhere(first, count) });
      } else {
        await embed(a, n);
      }
    } catch {
      // Imagen dañada, PDF protegido o ilegible: va incrustado tal cual.
      ilegibles.push(a.nombre);
      await embed(a, n);
    }
  }

  // Índice de anexos, justo después de la hoja.
  drawIndex(doc.insertPage(basePages, A4), titulo, index, incrustados.length > 0, { font, bold });
  return { bytes: await doc.save(), paginas: doc.getPageCount(), incrustados, faltantes, ilegibles };
}
