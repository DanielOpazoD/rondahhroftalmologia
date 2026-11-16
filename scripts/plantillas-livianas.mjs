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

/** @param {Uint8Array} bytes */
export async function slim(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  for (const k of ['OutputIntents', 'AF', 'Metadata']) doc.catalog.delete(N(k));
  const names = doc.catalog.lookupMaybe(N('Names'), PDFDict);
  if (names) {
    names.delete(N('EmbeddedFiles'));
    if (!names.keys().length) doc.catalog.delete(N('Names'));
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    // Otros flujos en ASCII85 (contenido de página, etc.): binarios.
    if (obj instanceof PDFRawStream && obj.dict.get(N('Subtype')) !== N('Image') && String(obj.dict.get(N('Filter'))).includes('ASCII85')) {
      const data = deflateSync(decodePDFRawStream(obj).decode(), { level: 9 });
      const dict = obj.dict.clone(ctx);
      dict.set(N('Filter'), N('FlateDecode'));
      dict.delete(N('DecodeParms'));
      dict.set(N('Length'), PDFNumber.of(data.length));
      ctx.assign(ref, PDFRawStream.of(dict, data));
      continue;
    }
    // Imágenes: binarias (sin ASCII85) y en gris si no tienen color.
    if (obj instanceof PDFRawStream && obj.dict.get(N('Subtype')) === N('Image')) {
      const filter = obj.dict.get(N('Filter'));
      const ascii = String(filter).includes('ASCII85');
      const rgb =
        obj.dict.get(N('ColorSpace')) === N('DeviceRGB') &&
        obj.dict.get(N('BitsPerComponent'))?.toString() === '8' &&
        !obj.dict.get(N('SMask')) &&
        !obj.dict.get(N('DecodeParms'));
      if (!ascii && !rgb) continue;
      let raw = decodePDFRawStream(obj).decode();
      const dict = obj.dict.clone(ctx);
      if (rgb) {
        const gray = new Uint8Array(raw.length / 3);
        let ok = true;
        for (let i = 0, j = 0; i < raw.length; i += 3, j++) {
          if (raw[i] !== raw[i + 1] || raw[i] !== raw[i + 2]) {
            ok = false;
            break;
          }
          gray[j] = raw[i];
        }
        if (ok) {
          raw = gray;
          dict.set(N('ColorSpace'), N('DeviceGray'));
        } else if (!ascii) continue;
      }
      const width = Number(obj.dict.get(N('Width'))?.toString());
      const colors = dict.get(N('ColorSpace')) === N('DeviceGray') ? 1 : 3;
      const data = deflateSync(pngPredict(raw, width * colors, colors), { level: 9 });
      dict.set(N('Filter'), N('FlateDecode'));
      dict.set(N('DecodeParms'), ctx.obj({ Predictor: 15, Colors: colors, BitsPerComponent: 8, Columns: width }));
      dict.set(N('Length'), PDFNumber.of(data.length));
      ctx.assign(ref, PDFRawStream.of(dict, data));
    }
    // Fuentes TrueType simples (WinAnsi) con medidas de Helvetica → Helvetica estándar.
    if (obj instanceof PDFDict && obj.get(N('Type')) === N('Font') && obj.get(N('Subtype')) === N('TrueType')) {
      const base = obj.get(N('BaseFont'))?.toString().slice(1) || '';
      const std = STANDARD[/** @type {keyof typeof STANDARD} */ (base.replace(/^[A-Z]{6}\+/, ''))];
      if (!std || obj.get(N('Encoding')) !== N('WinAnsiEncoding')) continue;
      const name = obj.get(N('Name'));
      ctx.assign(
        ref,
        ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: std, Encoding: 'WinAnsiEncoding', ...(name ? { Name: name } : {}) }),
      );
    }
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
