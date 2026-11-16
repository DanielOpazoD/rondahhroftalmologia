#!/usr/bin/env node
/**
 * Aligera las plantillas PDF sin cambiar lo que se ve ni sus campos
 * (ver docs/RENDIMIENTO.md). Se puede correr las veces que se quiera:
 *
 *   node scripts/plantillas-livianas.mjs          (modifica src/specialties/oftalmologia/*.pdf)
 *   node scripts/plantillas-livianas.mjs --check  (solo informa; falla si algo se puede aligerar)
 *
 * Qué quita o re-codifica, y por qué no cambia el resultado:
 *  - Perfil de color de impresión (/OutputIntents, ~1,3 MB): solo lo usan
 *    flujos de imprenta PDF/X; pantallas e impresoras de oficina lo ignoran.
 *  - Credenciales de contenido (C2PA, /AF y /Names → EmbeddedFiles) y
 *    metadatos XMP (/Metadata): datos de la herramienta que creó el archivo.
 *  - Imágenes en ASCII85 (texto, +25 %): se guardan binarias; si la imagen es
 *    en escala de grises (todos los píxeles R=G=B) se guarda en gris (÷3).
 *  - Fuentes LiberationSans incrustadas (TrueType completas, ~200 KB c/u):
 *    tienen las mismas medidas que Helvetica, que todo lector PDF trae; se
 *    reemplazan por la Helvetica estándar (misma codificación WinAnsi).
 *  - Objetos que nadie referencia; los objetos se renumeran sin huecos.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRawStream,
  PDFContext,
  PDFObjectCopier,
  PDFStreamWriter,
  PDFNumber,
  decodePDFRawStream,
} from 'pdf-lib';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/specialties/oftalmologia');
const check = process.argv.includes('--check');
const N = (/** @type {string} */ s) => PDFName.of(s);

/** Fuentes incrustadas con las mismas medidas que una estándar de PDF. */
const STANDARD = {
  LiberationSans: 'Helvetica',
  'LiberationSans-Bold': 'Helvetica-Bold',
  ArialMT: 'Helvetica',
  'Arial-BoldMT': 'Helvetica-Bold',
};

/**
 * Filtros PNG por fila (como un PNG: se elige por fila el que deja bytes más
 * pequeños): la imagen se comprime mucho mejor. PDF lo declara con Predictor 15.
 * @param {Uint8Array} raw @param {number} stride bytes por fila @param {number} bpp bytes por píxel
 */
function pngPredict(raw, stride, bpp) {
  const rows = raw.length / stride;
  const out = new Uint8Array(rows * (stride + 1));
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < rows; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const up = y ? raw.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    let best = 0;
    let bestScore = Infinity;
    for (let t = 0; t < 5; t++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = up[i];
        const c = i >= bpp ? up[i - bpp] : 0;
        let pred = 0;
        if (t === 1) pred = a;
        else if (t === 2) pred = b;
        else if (t === 3) pred = (a + b) >> 1;
        else if (t === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[i] - pred) & 0xff;
        cand[t][i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  return out;
}

/**
 * Flujo comprimido con Flate (y filtros PNG si es una imagen).
 * @param {PDFContext} ctx @param {PDFDict} dict diccionario a reutilizar (ya clonado) @param {Uint8Array} raw
 * @param {{width: number, colors: number}} [image]
 */
function flateStream(ctx, dict, raw, image) {
  const data = deflateSync(image ? pngPredict(raw, image.width * image.colors, image.colors) : raw, { level: 9 });
  dict.set(N('Filter'), N('FlateDecode'));
  if (image) dict.set(N('DecodeParms'), ctx.obj({ Predictor: 15, Colors: image.colors, BitsPerComponent: 8, Columns: image.width }));
  else dict.delete(N('DecodeParms'));
  dict.set(N('Length'), PDFNumber.of(data.length));
  return PDFRawStream.of(dict, data);
}

/** Los píxeles RGB en gris si todos tienen R=G=B; si alguno tiene color, null. @param {Uint8Array} raw */
function grayOf(raw) {
  const gray = new Uint8Array(raw.length / 3);
  for (let i = 0, j = 0; i < raw.length; i += 3, j++) {
    if (raw[i] !== raw[i + 1] || raw[i] !== raw[i + 2]) return null;
    gray[j] = raw[i];
  }
  return gray;
}

/**
 * Imagen binaria (sin ASCII85) y en gris si no tiene color; null si ya está bien.
 * @param {PDFContext} ctx @param {PDFRawStream} obj
 */
function slimImage(ctx, obj) {
  const ascii = String(obj.dict.get(N('Filter'))).includes('ASCII85');
  const rgb =
    obj.dict.get(N('ColorSpace')) === N('DeviceRGB') &&
    obj.dict.get(N('BitsPerComponent'))?.toString() === '8' &&
    !obj.dict.get(N('SMask')) &&
    !obj.dict.get(N('DecodeParms'));
  if (!ascii && !rgb) return null;
  const raw = decodePDFRawStream(obj).decode();
  const gray = rgb ? grayOf(raw) : null;
  if (!ascii && !gray) return null;
  const dict = obj.dict.clone(ctx);
  if (gray) dict.set(N('ColorSpace'), N('DeviceGray'));
  const width = Number(obj.dict.get(N('Width'))?.toString());
  return flateStream(ctx, dict, gray || raw, { width, colors: gray ? 1 : 3 });
}

/**
 * Flujo aligerado (imágenes; otros flujos en ASCII85 pasan a binarios), o null si no cambia.
 * @param {PDFContext} ctx @param {PDFRawStream} obj
 */
function slimStream(ctx, obj) {
  if (obj.dict.get(N('Subtype')) === N('Image')) return slimImage(ctx, obj);
  if (!String(obj.dict.get(N('Filter'))).includes('ASCII85')) return null;
  return flateStream(ctx, obj.dict.clone(ctx), decodePDFRawStream(obj).decode());
}

/**
 * Fuente TrueType simple (WinAnsi) con las medidas de una fuente estándar → la estándar; null si no aplica.
 * @param {PDFContext} ctx @param {PDFDict} obj
 */
function standardFont(ctx, obj) {
  if (obj.get(N('Type')) !== N('Font') || obj.get(N('Subtype')) !== N('TrueType')) return null;
  const base = obj.get(N('BaseFont'))?.toString().slice(1) || '';
  const std = STANDARD[/** @type {keyof typeof STANDARD} */ (base.replace(/^[A-Z]{6}\+/, ''))];
  if (!std || obj.get(N('Encoding')) !== N('WinAnsiEncoding')) return null;
  const name = obj.get(N('Name'));
  return ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: std, Encoding: 'WinAnsiEncoding', ...(name ? { Name: name } : {}) });
}

/** Quita del catálogo el perfil de imprenta, las credenciales de contenido y los metadatos XMP. @param {PDFDocument} doc */
function removeInvisible(doc) {
  for (const k of ['OutputIntents', 'AF', 'Metadata']) doc.catalog.delete(N(k));
  const names = doc.catalog.lookupMaybe(N('Names'), PDFDict);
  if (!names) return;
  names.delete(N('EmbeddedFiles'));
  if (!names.keys().length) doc.catalog.delete(N('Names'));
}

/** @param {Uint8Array} bytes */
export async function slim(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  removeInvisible(doc);
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const next = obj instanceof PDFRawStream ? slimStream(ctx, obj) : obj instanceof PDFDict ? standardFont(ctx, obj) : null;
    if (next) ctx.assign(ref, next);
  }
  // Copia solo lo alcanzable desde el catálogo y la info, con números seguidos.
  const out = PDFContext.create();
  const copier = PDFObjectCopier.for(ctx, out);
  out.trailerInfo.Root = out.register(copier.copy(doc.catalog));
  const info = ctx.lookup(ctx.trailerInfo.Info);
  if (info) out.trailerInfo.Info = out.register(copier.copy(info));
  return PDFStreamWriter.forContext(out, 50).serializeToBuffer();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pending = 0;
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.pdf'))) {
    const file = join(DIR, name);
    const before = readFileSync(file);
    const after = await slim(before);
    const saved = before.length - after.length;
    // Menos de 1 KB de diferencia: ya está liviana (la re-escritura no es byte a byte igual).
    if (saved < 1024) {
      console.log(`${name}: ${Math.round(before.length / 1024)} KB (ya liviana)`);
      continue;
    }
    pending++;
    console.log(`${name}: ${Math.round(before.length / 1024)} KB → ${Math.round(after.length / 1024)} KB`);
    if (!check) writeFileSync(file, after);
  }
  if (check && pending) {
    console.error(`\n${pending} plantilla(s) se pueden aligerar: node scripts/plantillas-livianas.mjs`);
    process.exit(1);
  }
}
