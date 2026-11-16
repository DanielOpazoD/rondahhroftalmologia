/**
 * Imágenes adjuntas en el navegador: compresión de fotos y conversión a
 * formatos que el PDF admite (JPEG/PNG). Usa canvas (CSSOM/DOM, no la red).
 */

/** Lado mayor máximo de una foto adjunta (px). */
const MAX_SIDE = 2400;
/** Por debajo de este tamaño no se recomprime (si además cabe en MAX_SIDE). */
const SMALL_BYTES = 1.5 * 1024 * 1024;

/** Decodifica una imagen; null si el navegador no puede (p. ej. HEIC en Chrome). @param {Blob} blob */
async function decode(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * Dibuja en un canvas y exporta.
 * @param {ImageBitmap} img
 * @param {number} width
 * @param {number} height
 * @param {string} type tipo MIME de salida
 * @param {number | undefined} quality calidad JPEG (0 a 1)
 * @returns {Promise<Uint8Array | null>}
 */
async function render(img, width, height, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) return null;
  if (type === 'image/jpeg') {
    g.fillStyle = '#fff'; // JPEG no tiene transparencia
    g.fillRect(0, 0, width, height);
  }
  g.drawImage(img, 0, 0, width, height);
  const out = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  return out ? new Uint8Array(await /** @type {Blob} */ (out).arrayBuffer()) : null;
}

/**
 * Prepara una foto para adjuntar: si es grande, la reduce (lado mayor
 * MAX_SIDE) y la guarda como JPEG; si es pequeña, la deja igual. Si el
 * navegador no puede leerla, devuelve el archivo original.
 * @param {File} file
 * @returns {Promise<{bytes: Uint8Array, tipo: string, nombre: string, comprimida: boolean}>}
 */
export async function prepareImage(file) {
  const original = { bytes: new Uint8Array(await file.arrayBuffer()), tipo: file.type, nombre: file.name, comprimida: false };
  const img = await decode(file);
  if (!img) return original;
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const okFormat = file.type === 'image/jpeg' || file.type === 'image/png';
  if (scale === 1 && file.size <= SMALL_BYTES && okFormat) return original;
  const bytes = await render(img, Math.round(img.width * scale), Math.round(img.height * scale), 'image/jpeg', 0.85);
  if (!bytes || (bytes.length >= file.size && okFormat)) return original;
  const nombre = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return { bytes, tipo: 'image/jpeg', nombre, comprimida: true };
}

/**
 * Convierte una imagen que el PDF no admite (WebP, GIF, HEIC…) a PNG, para
 * incluirla como página en el PDF con anexos. null si el navegador no puede leerla.
 * @param {Uint8Array} bytes
 * @param {string} tipo
 */
export async function toPng(bytes, tipo) {
  const img = await decode(new Blob([/** @type {BlobPart} */ (bytes)], { type: tipo }));
  if (!img) return null;
  return render(img, img.width, img.height, 'image/png', undefined);
}

/** Lado mayor de una miniatura (px): el doble de lo que se ve, para pantallas nítidas. */
const THUMB_SIDE = 96;

/**
 * Miniatura de una imagen (JPEG pequeño como data URL) para guardar con sus
 * metadatos; null si el navegador no puede leerla.
 * @param {Uint8Array} bytes
 * @param {string} tipo
 * @param {number} [maxChars] tamaño máximo del texto
 * @returns {Promise<string | null>}
 */
export async function makeThumbnail(bytes, tipo, maxChars = 16_000) {
  const img = await decode(new Blob([/** @type {BlobPart} */ (bytes)], { type: tipo }));
  if (!img) return null;
  const s = Math.min(1, THUMB_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * s));
  canvas.height = Math.max(1, Math.round(img.height * s));
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const q of [0.72, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= maxChars) return url;
  }
  return null;
}
