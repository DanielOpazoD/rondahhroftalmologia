/**
 * Seudonimización genérica (común a todas las especialidades):
 * códigos estables con HMAC, limpieza de textos libres, generalización de
 * fecha y edad, verificación de fugas y tabla de correspondencia.
 * La forma de los datos exportados la define cada especialidad
 * (p. ej. specialties/oftalmologia/seudonimizacion.js).
 */
import { hmacSha256 } from '../lib/sha256.js';
import { daysBetween, normalizeText, cleanRut, fmtDateTime } from './format.js';
import { STYLE } from '../lib/xlsx.js';

/** Opciones por defecto (las más protectoras que siguen siendo útiles). */
export const ANON_DEFAULTS = Object.freeze({
  /** 'mes' (AAAA-MM) | 'relativa' (día 0, 1, …) | 'exacta' | 'omitir' */
  fechas: 'mes',
  /** 'rango5' (60-64, 90+) | 'exacta' (con tope 90+) */
  edad: 'rango5',
  /** 'limpiar' (reemplaza identificadores) | 'excluir' (quita todo texto libre) */
  texto: 'limpiar',
});

export const ANON_OPTIONS = {
  fechas: [
    ['mes', 'Solo mes y año'],
    ['relativa', 'Día relativo (0 = primer día)'],
    ['exacta', 'Fecha exacta'],
    ['omitir', 'Omitir fecha'],
  ],
  edad: [
    ['rango5', 'Rango de 5 años'],
    ['exacta', 'Edad exacta (90+ agrupado)'],
  ],
  texto: [
    ['limpiar', 'Incluir, limpiando identificadores'],
    ['excluir', 'Excluir textos libres'],
  ],
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Bytes -> base32 Crockford (sin letras ambiguas I, L, O, U).
 * @param {Iterable<number>} bytes
 */
export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Nueva clave secreta aleatoria (256 bits, en hexadecimal).
 * @param {(n: number) => Uint8Array} [rng]
 */
export function createSecret(rng = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  return Array.from(rng(32), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Huella corta de la clave, para comparar equipos sin mostrar la clave.
 * @param {string} secret
 */
export function secretFingerprint(secret) {
  return base32(hmacSha256(secret, 'huella')).slice(0, 6);
}

/**
 * Código seudónimo estable: `${prefix}-${8 caracteres}`.
 * 8 caracteres base32 = 40 bits: colisión prácticamente imposible para miles de pacientes.
 * @param {string} secret
 * @param {string} key
 */
export function pseudonym(secret, key, prefix = 'P', length = 8) {
  if (!secret) throw new Error('Falta la clave de seudonimización');
  return `${prefix}-${base32(hmacSha256(secret, key)).slice(0, length)}`;
}

/* ------------------------------------------------------- limpieza de texto */

/**
 * Expresión que encuentra una palabra sin importar tildes ni mayúsculas.
 * @param {string} word
 */
function wordRegex(word) {
  /** @type {Record<string, string>} */
  const variants = { a: '[aáàä]', e: '[eéèë]', i: '[iíìï]', o: '[oóòö]', u: '[uúùü]', n: '[nñ]' };
  const body = [...normalizeText(word)].map((c) => variants[c] || c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * Palabras de un nombre que vale la pena buscar (3+ letras).
 * @param {unknown} name
 */
export function nameTokens(name) {
  return [
    ...new Set(
      normalizeText(name)
        .split(/[^\p{L}]+/u)
        .filter((t) => t.length >= 3),
    ),
  ];
}

/**
 * Reemplaza identificadores en un texto libre.
 * @param {string} text
 * @param {{names?: string[]}} [ctx] nombres (paciente, médico) a ocultar
 */
export function scrubText(text, ctx = {}) {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[EMAIL]');
  s = s.replace(/\b\d{1,2}(?:\.\d{3}){2}-?[\dkK](?![\w])/g, '[RUT]');
  s = s.replace(/\b\d{7,8}-[\dkK](?![\w])/g, '[RUT]');
  s = s.replace(/\b\d{1,2}[-/.]\d{1,2}[-/.](?:\d{4}|\d{2})\b/g, '[FECHA]');
  s = s.replace(/\+?\d(?:[\s.-]?\d){7,}/g, '[NÚMERO]');
  const tokens = (ctx.names || []).flatMap(nameTokens).sort((a, b) => b.length - a.length);
  for (const t of tokens) s = s.replace(wordRegex(t), '[NOMBRE]');
  return s;
}

/* ------------------------------------------------------ generalizaciones */

/**
 * Edad generalizada según la opción.
 * @param {number | null | undefined} age
 * @param {string} mode
 */
export function generalizeAge(age, mode) {
  if (age === null || age === undefined) return '';
  if (age >= 90) return '90+';
  if (mode === 'exacta') return age;
  const lo = Math.floor(age / 5) * 5;
  return `${lo}-${lo + 4}`;
}

/**
 * Fecha generalizada según la opción.
 * @param {string} iso
 * @param {string} mode
 * @param {string | null} [firstDate]
 */
export function generalizeDate(iso, mode, firstDate) {
  if (!iso || mode === 'omitir') return '';
  if (mode === 'exacta') return iso;
  if (mode === 'relativa') return firstDate ? daysBetween(firstDate, iso) : '';
  return iso.slice(0, 7);
}

/**
 * Busca en la salida (texto serializado) identificadores de los pacientes
 * originales: palabras del nombre (4+ letras), cuerpo del RUT y teléfono.
 * @param {string} outputText
 * @param {import('../domain').RegistroFusionable[]} records
 * @returns {{tipo: string, muestra: string}[]} hallazgos (con el valor enmascarado)
 */
export function findLeaks(outputText, records) {
  const text = normalizeText(outputText);
  const digits = String(outputText).replace(/\D+/g, ' ');
  /** @type {Map<string, {tipo: string, muestra: string}>} */
  const found = new Map();
  /** @param {string} s */
  const mask = (s) => s.slice(0, 2) + '•'.repeat(Math.max(1, s.length - 2));
  for (const r of records) {
    const f = r.f || {};
    for (const t of nameTokens(f.paciente_nombre).filter((x) => x.length >= 4)) {
      if (new RegExp(`(?<![\\p{L}])${t}(?![\\p{L}])`, 'u').test(text)) found.set('n:' + t, { tipo: 'Nombre', muestra: mask(t) });
    }
    const rut = cleanRut(f.paciente_rut).slice(0, -1);
    if (rut.length >= 7 && digits.includes(rut)) found.set('r:' + rut, { tipo: 'RUT', muestra: mask(rut) });
    const fono = String(f.paciente_fono || '').replace(/\D/g, '');
    if (fono.length >= 8 && digits.replace(/ /g, '').includes(fono.slice(-8))) {
      found.set('f:' + fono, { tipo: 'Teléfono', muestra: mask(fono) });
    }
  }
  return [...found.values()];
}

/* ------------------------------------------------------------ salidas */

/**
 * Fila de la tabla de correspondencia: código seudónimo -> identidad del paciente.
 * @typedef {{codigo_paciente: string, nombre: string, rut: string, base_codigo: string, atenciones: number}} FilaCorrespondencia
 */

/**
 * Hoja de la tabla de correspondencia (CONFIDENCIAL).
 * @param {{correspondencia: FilaCorrespondencia[]}} result
 */
export function correspondenciaSheets(result, now = new Date()) {
  return [
    {
      name: 'Correspondencia',
      header: true,
      rows: [
        ['Código paciente', 'Nombre', 'RUT', 'Código basado en', 'N° atenciones'],
        ...result.correspondencia
          .slice()
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
          .map((c) => [c.codigo_paciente, c.nombre, c.rut, c.base_codigo, c.atenciones]),
      ],
    },
    {
      name: 'Aviso',
      rows: [
        [{ v: 'CONFIDENCIAL — contiene datos personales', s: STYLE.bold }],
        ['Permite reidentificar a los pacientes de la exportación seudonimizada.'],
        ['No compartir junto con los datos seudonimizados ni subir a servicios externos.'],
        ['Generado', fmtDateTime(now)],
      ],
      widths: [70, 30],
    },
  ];
}
