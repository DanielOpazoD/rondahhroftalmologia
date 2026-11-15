/**
 * Generador mínimo de archivos ZIP (método "store", sin compresión).
 *
 * Se usa para:
 *  - empaquetar el .xlsx (un .xlsx es un ZIP con XML adentro);
 *  - descargar en un solo archivo los PDF de un operativo completo.
 *
 * Los PDF ya vienen comprimidos internamente, así que "store" no pierde nada
 * relevante y mantiene el código simple y sin dependencias.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 (IEEE 802.3), el mismo que exige el formato ZIP.
 * @param {ArrayLike<number>} bytes
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Fecha/hora en formato MS-DOS que usa ZIP.
 * @param {Date} date
 */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Crea un ZIP.
 * @param {{name: string, data: Uint8Array|string}[]} entries
 * @param {Date} [date] fecha a registrar en cada entrada
 * @returns {Uint8Array}
 */
export function createZip(entries, date = new Date()) {
  const enc = new TextEncoder();
  const { time, day } = dosDateTime(date);
  const used = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = uniqueName(entry.name, used);
    const nameBytes = enc.encode(name);
    const data = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // versión necesaria
    lv.setUint16(6, 0x0800, true); // bit 11: nombre en UTF-8
    lv.setUint16(8, 0, true); // método: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Evita nombres repetidos dentro del ZIP agregando " (2)", " (3)", ... */
/**
 * @param {string} name
 * @param {Set<string>} used
 */
function uniqueName(name, used) {
  let candidate = name;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = name.replace(/(\.[^./]+)?$/, (/** @type {string} */ ext) => ` (${i})${ext || ''}`);
    i++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
