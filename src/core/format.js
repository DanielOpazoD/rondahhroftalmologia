/**
 * Utilidades puras de formato: fechas, RUT y texto.
 * Sin acceso al DOM ni a localStorage, para poder probarlas en Node.
 */

/* ------------------------------------------------------------------ fechas */

/** Fecha local de hoy en formato ISO (YYYY-MM-DD). */
export function todayIso(now = new Date()) {
  return [now.getFullYear(), pad2(now.getMonth() + 1), pad2(now.getDate())].join('-');
}

/**
 * "2026-11-14" -> "14-11-2026". Devuelve '' si no es una fecha ISO.
 * @param {unknown} iso
 */
export function fmtDate(iso) {
  if (!isIsoDate(iso)) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/** Fecha y hora local legible: "14-11-2026 18:05". */
export function fmtDateTime(date = new Date()) {
  return `${fmtDate(todayIso(date))} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * @param {unknown} s
 * @returns {s is string}
 */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Días entre dos fechas ISO (b - a).
 * @param {string} a
 * @param {string} b
 */
export function daysBetween(a, b) {
  /** @param {string} s */
  const toUtc = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/* --------------------------------------------------------------------- RUT */

/**
 * Deja solo dígitos y K (mayúscula).
 * @param {unknown} rut
 */
export function cleanRut(rut) {
  return String(rut ?? '')
    .replace(/[^0-9kK]/g, '')
    .toUpperCase();
}

/**
 * Dígito verificador (módulo 11) para la parte numérica de un RUT.
 * @param {string|number} body
 */
export function rutCheckDigit(body) {
  let sum = 0;
  let mul = 2;
  for (let i = String(body).length - 1; i >= 0; i--) {
    sum += Number(String(body)[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}

/**
 * true si el RUT tiene formato correcto y dígito verificador válido.
 * @param {unknown} rut
 */
export function isValidRut(rut) {
  const c = cleanRut(rut);
  if (c.length < 2) return false;
  const body = c.slice(0, -1).replace(/^0+/, '');
  if (!/^\d{1,9}$/.test(body)) return false;
  return rutCheckDigit(body) === c.slice(-1);
}

/**
 * "177527530" -> "17.752.753-0". Si no se puede formatear, devuelve el original.
 * @param {unknown} rut
 */
export function formatRut(rut) {
  const c = cleanRut(rut);
  if (c.length < 2) return String(rut ?? '');
  const dv = c.slice(-1);
  const body = c.slice(0, -1).replace(/^0+/, '');
  if (!/^\d+$/.test(body)) return String(rut ?? '');
  return body.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv;
}

/**
 * Clave canónica de un RUT para comparar: "17752753-0" (sin puntos).
 * @param {unknown} rut
 */
export function rutKey(rut) {
  const c = cleanRut(rut);
  if (c.length < 2) return '';
  return c.slice(0, -1).replace(/^0+/, '') + '-' + c.slice(-1);
}

/* ------------------------------------------------------------------- texto */

/**
 * Escapa HTML para insertar texto de usuario en plantillas.
 * @param {unknown} s
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * Minúsculas, sin tildes y con espacios simples: para búsquedas y claves.
 * @param {unknown} s
 */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Texto apto para fuentes estándar de PDF (WinAnsi): reemplaza comillas
 * tipográficas, guiones largos, etc. y elimina lo que no se puede dibujar.
 * @param {unknown} s
 */
export function toWinAnsi(s) {
  return String(s ?? '')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/[•·]/g, '-')
    .replace(/\t/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '');
}

/**
 * Fragmento seguro para nombres de archivo.
 * @param {unknown} s
 */
export function fileSafe(s, max = 40) {
  return (
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, max) || 'sin_nombre'
  );
}

/**
 * Convierte "12,5" o "12.5" en número; null si no es numérico.
 * @param {unknown} v
 */
export function parseNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * "Ana Pérez" -> "Dr(a). Ana Pérez"; no duplica si ya trae "Dr." / "Dra.".
 * @param {unknown} name
 */
export function doctorName(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  return /^dr(a)?\.?\s|^dr\(a\)/i.test(n) ? n : 'Dr(a). ' + n;
}

/**
 * Edad en años cumplidos a una fecha de referencia (ambas ISO).
 * @param {unknown} birthIso
 * @param {unknown} refIso
 * @returns {number|null} null si alguna fecha no es válida o la referencia es anterior al nacimiento
 */
export function ageAt(birthIso, refIso) {
  if (!isIsoDate(birthIso) || !isIsoDate(refIso) || refIso < birthIso) return null;
  const [by, bm, bd] = birthIso.split('-').map(Number);
  const [ry, rm, rd] = refIso.split('-').map(Number);
  return ry - by - (rm < bm || (rm === bm && rd < bd) ? 1 : 0);
}
