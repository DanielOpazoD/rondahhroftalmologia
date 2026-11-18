/**
 * Cuentas (servidor): lo HTTP común a todas las acciones — respuestas JSON con
 * un `code` estable, el cuerpo de la solicitud (con tope de tamaño), el token
 * `Bearer` y la IP de origen.
 */
import { isObject } from './validate.js';

/**
 * Una solicitud ya validada (ruta, método, cuerpo JSON).
 * @typedef {{req: Request, url: URL, b: Record<string, unknown>, t: number}} Peticion
 *   `b`: cuerpo JSON de un POST (lo valida cada acción campo a campo); vacío en GET.
 * @typedef {Peticion & {a: import('./session.js').Autenticado, me: import('./store.js').Cuenta}} PeticionConSesion
 */

/** Tope del cuerpo de una solicitud de cuentas (en caracteres). */
const BODY_MAX_CHARS = 600_000;

/** @type {(status: number, body: unknown) => Response} */
export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
/** @type {(status: number, code: string, error: string, extra?: Record<string, unknown>) => Response} */
export const fail = (status, code, error, extra = {}) => json(status, { error, code, ...extra });

/** Token de la solicitud (sesión o contraseña del equipo); '' si no trae. @param {Request} req */
export const bearer = (req) => {
  const a = req.headers.get('authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
};

/** IP de origen (Netlify / proxy). @param {Request} req */
export const clientIp = (req) =>
  req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'desconocida';

/** Cuerpo de una solicitud GET (no se lee). */
const NO_BODY = Object.freeze({});

/** JSON del texto, o null si está mal formado. @param {string} text @returns {unknown} */
function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}

/**
 * Cuerpo JSON de la solicitud, o la respuesta de error si no sirve: más de
 * 600 KB (413, sin leerlo como JSON) o, en un POST, JSON que no es un objeto
 * (400). Un GET no trae cuerpo.
 * @param {Request} req
 * @returns {Promise<{b: Record<string, unknown>} | {response: Response}>}
 */
export async function readBody(req) {
  if (req.method !== 'POST') return { b: NO_BODY };
  const text = await req.text();
  if (text.length > BODY_MAX_CHARS) return { response: fail(413, 'demasiado_grande', 'La solicitud es demasiado grande') };
  const b = parseJson(text);
  return isObject(b) ? { b } : { response: fail(400, 'json_invalido', 'JSON inválido') };
}
