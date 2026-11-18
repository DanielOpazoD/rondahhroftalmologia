/**
 * Cuentas (servidor): validación de lo que llega en las solicitudes, sin
 * almacén ni secreto. Cada validador recibe `unknown` (JSON tal como llegó) y
 * es un type guard o devuelve el valor validado: lo que sigue ya está tipado.
 * Mensajes y reglas son los de siempre (ver tests/accounts.test.js).
 */
import { accountRut, USER_ID_RE } from '../../core/accounts.js';
import { ROLES } from '../../config/catalogs.js';

/** @typedef {{iv: string, ct: string}} Sellado  cifrado hecho en el PC (perfil o clave envuelta) */
/** @typedef {{sal: string, iter: number, acceso: string, envuelta: Sellado}} Credenciales  de una clave, calculadas en el PC */
/**
 * Alta de una cuenta, validada. `rut` es un RUT válido (accountRut lo normaliza).
 * @typedef {Credenciales & {id: string, rut: unknown, rol: string, perfil: Sellado, admin?: unknown}} AltaCuenta
 */
/** @typedef {{rut: unknown, acceso: string}} Ingreso  cuerpo de `entrar`, validado */
/** @typedef {'activo' | 'desactivado'} EstadoCuenta */
/** @typedef {{rol?: string, admin?: boolean, estado?: EstadoCuenta, perfil?: Sellado}} CambiosCuenta */
/**
 * Evento de lectura informado por la app, ya validado.
 * @typedef {{ev: string, obj: string | undefined, n: number | undefined, at: number | undefined, off: true | undefined}} EventoCliente
 */

/** Eventos que puede informar la app (los demás los registra el servidor). */
export const CLIENT_EVENTS = Object.freeze([
  'ficha.ver',
  'atencion.ver',
  'atencion.pdf',
  'atencion.nota',
  'adjunto.ver',
  'exportar.excel',
  'exportar.seudonimizado',
  'exportar.pdfs',
  'exportar.correspondencia',
  'respaldo.descargar',
  'respaldo.importar',
  'sesion.bloqueo',
  'sesion.desbloqueo',
  'sesion.inicio_local',
  'sesion.fin_local',
]);
/** Días que abarca como máximo una consulta del registro de accesos. */
export const MAX_AUDIT_DAYS = 62;
/** Eventos por lote que acepta `eventos`. */
export const MAX_EVENTS = 100;
export const DAY_MS = 24 * 3600_000;
export const HEX64 = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ROLE_KEYS = ROLES.map((r) => r.key);
const LOGOUT_REASONS = Object.freeze(['salir', 'inactividad', 'cierre']);
const STATES = /** @type {readonly EstadoCuenta[]} */ (Object.freeze(['activo', 'desactivado']));

/**
 * ¿Es un objeto (o un arreglo) cuyos campos se pueden leer? Es la misma
 * condición que exige el router a un cuerpo POST (`!b || typeof b !== 'object'` → 400).
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export const isObject = (v) => typeof v === 'object' && v !== null;

/**
 * @template {string} T
 * @param {readonly T[]} list
 * @param {unknown} v
 * @returns {v is T}
 */
const oneOf = (list, v) => list.includes(/** @type {T} */ (v));

/**
 * ¿Id de cuenta válido? Como `USER_ID_RE.test(v)` sin revisar el tipo
 * (RegExp#test convierte a texto), que es como se validó siempre.
 * @param {unknown} v
 * @returns {v is string}
 */
export const isUserId = (v) => USER_ID_RE.test(String(v));

/**
 * Cifrado válido (perfil o clave envuelta): iv de 12 bytes y texto cifrado acotado.
 * @param {unknown} p
 * @returns {p is Sellado}
 */
const isSealed = (p) =>
  isObject(p) &&
  typeof p.iv === 'string' &&
  p.iv.length === 16 &&
  B64_RE.test(p.iv) &&
  typeof p.ct === 'string' &&
  p.ct.length > 0 &&
  p.ct.length <= 4000 &&
  B64_RE.test(p.ct);

/**
 * Credenciales válidas de una clave (calculadas en el PC).
 * @param {unknown} c
 * @returns {c is Credenciales}
 */
export const isCredentials = (c) =>
  isObject(c) &&
  typeof c.sal === 'string' &&
  c.sal.length === 24 &&
  B64_RE.test(c.sal) &&
  typeof c.iter === 'number' &&
  Number.isSafeInteger(c.iter) &&
  c.iter >= 100_000 &&
  c.iter <= 5_000_000 &&
  typeof c.acceso === 'string' &&
  HEX64.test(c.acceso) &&
  isSealed(c.envuelta);

/**
 * Cuerpo de `entrar`: RUT válido y `acceso` (64 hex, derivado de la clave en el PC).
 * @param {Record<string, unknown>} b
 * @returns {b is Record<string, unknown> & Ingreso}
 */
export const isLogin = (b) => Boolean(accountRut(b.rut)) && typeof b.acceso === 'string' && HEX64.test(b.acceso);

/**
 * Validación común de un alta (crear una cuenta o el primer administrador).
 * @param {unknown} b
 * @returns {{alta: AltaCuenta} | {error: string}}
 */
export function newAccountData(b) {
  if (!isObject(b) || !isUserId(b.id)) return { error: 'Id de cuenta inválido' };
  if (!accountRut(b.rut)) return { error: 'RUT inválido' };
  if (!oneOf(ROLE_KEYS, b.rol)) return { error: 'Profesión inválida' };
  if (!isSealed(b.perfil)) return { error: 'Perfil inválido' };
  if (!isCredentials(b)) return { error: 'Credenciales inválidas' };
  return { alta: /** @type {AltaCuenta} */ (b) };
}

/**
 * Cambios pedidos a una cuenta (profesión, administrador, estado, perfil), validados.
 * @param {Record<string, unknown>} b
 * @returns {{changes: CambiosCuenta} | {error: string}}
 */
export function accountChanges(b) {
  /** @type {CambiosCuenta} */
  const changes = {};
  if (b.rol !== undefined) {
    if (!oneOf(ROLE_KEYS, b.rol)) return { error: 'Profesión inválida' };
    changes.rol = b.rol;
  }
  if (b.admin !== undefined) changes.admin = b.admin === true;
  if (b.estado !== undefined) {
    if (!oneOf(STATES, b.estado)) return { error: 'Estado inválido' };
    changes.estado = b.estado;
  }
  if (b.perfil !== undefined) {
    if (!isSealed(b.perfil)) return { error: 'Perfil inválido' };
    changes.perfil = b.perfil;
  }
  return { changes };
}

/** Motivo de un cierre de sesión (`salir` si no es uno conocido). @param {unknown} m */
export const logoutReason = (m) => (oneOf(LOGOUT_REASONS, m) ? m : 'salir');

/**
 * Lote de `eventos`: un arreglo de hasta MAX_EVENTS (cada uno se valida con
 * `clientEvent`), o null si no lo es.
 * @param {unknown} list
 * @returns {unknown[] | null}
 */
export const eventBatch = (list) => (Array.isArray(list) && list.length <= MAX_EVENTS ? /** @type {unknown[]} */ (list) : null);

/** Objeto de un evento: ninguno o un id seguro. @param {unknown} v @returns {v is string | undefined} */
const isEventObject = (v) => v === undefined || (typeof v === 'string' && ID_RE.test(v));
/** Cantidad de un evento (entero de 0 a 999 999), o undefined. @param {unknown} n */
const eventCount = (n) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < 1e6 ? n : undefined);
/** Hora de un evento según el PC (a menos de 90 días de la del servidor), o undefined. @param {unknown} at @param {number} t */
const eventTime = (at, t) => (typeof at === 'number' && Number.isSafeInteger(at) && Math.abs(at - t) < 90 * DAY_MS ? at : undefined);

/**
 * Evento de lectura informado por la app, ya validado: solo tipos conocidos,
 * un objeto con id seguro y números dentro de rango (lo demás se descarta).
 * null si no es un evento válido.
 * @param {unknown} e lo que llegó en el cuerpo de la petición
 * @param {number} t hora del servidor
 * @returns {EventoCliente | null}
 */
export function clientEvent(e, t) {
  if (!isObject(e) || !oneOf(CLIENT_EVENTS, e.ev) || !isEventObject(e.obj)) return null;
  return { ev: e.ev, obj: e.obj, n: eventCount(e.n), at: eventTime(e.at, t), off: e.off === true ? true : undefined };
}

/**
 * Rango pedido para la auditoría, en ms. Acepta ms (inicio y fin del día
 * LOCAL del PC: el servidor guarda por día UTC y en Rapa Nui, de tarde, ya es
 * el día siguiente en UTC) o AAAA-MM-DD (días UTC completos).
 * @param {URLSearchParams} q @param {number} t
 * @returns {{desde: number, hasta: number} | null}
 */
export function auditRange(q, t) {
  /** @param {string | null} v @param {boolean} end */
  const when = (v, end) => (/^\d{10,16}$/.test(v || '') ? Number(v) : Date.parse(v || '') + (end ? DAY_MS - 1 : 0));
  const desde = when(q.get('desde'), false);
  const hasta = q.get('hasta') ? when(q.get('hasta'), true) : t;
  const ok = Number.isFinite(desde) && Number.isFinite(hasta) && hasta >= desde && (hasta - desde) / DAY_MS <= MAX_AUDIT_DAYS;
  return ok ? { desde, hasta } : null;
}

/**
 * ¿Tiene la forma del contenido de un token de sesión? (la firma la verifica secrets.js)
 * @param {unknown} p JSON del token
 * @returns {p is {u: string, s: string, e: number}}
 */
export const isTokenPayload = (p) => isObject(p) && typeof p.u === 'string' && typeof p.s === 'string' && Number.isFinite(p.e);
