/**
 * Cuentas de usuario, sesiones y registro de accesos: lógica del servidor
 * (ADR 0014). La usan la función `cuentas` (/api/cuentas/:accion) y la de
 * sincronización (para exigir sesión una vez activadas las cuentas).
 *
 * El servidor NO ve claves ni datos personales en claro:
 *   - del RUT guarda solo una huella HMAC (para encontrar la cuenta);
 *   - de la clave, HMAC(secreto, acceso), donde `acceso` lo deriva el PC;
 *   - el perfil (nombre, RUT, profesión) y la clave del equipo envuelta
 *     llegan cifrados desde el PC.
 * `secret` es la variable de entorno SYNC_TOKEN_SHA256 (fuera del almacén).
 *
 * Este archivo es la entrada pública: arma las piezas de accounts/ y tiene el
 * router (qué acceso exige cada ruta). Las piezas:
 *   accounts/validate.js  validación de cuerpos y consultas (puro: sin almacén ni secreto)
 *   accounts/http.js      respuestas JSON, cuerpo con tope, token Bearer, IP
 *   accounts/secrets.js   huellas, verificador, tokens de sesión, contraseña del equipo
 *   accounts/store.js     claves del almacén y lectura/escritura de cuentas, sesiones y auditoría
 *   accounts/login.js     sal y entrar, con límites de intentos por cuenta y por red
 *   accounts/session.js   verificar la sesión; salir, cambiar la clave, eventos
 *   accounts/admin.js     activar, preparar, crear, editar, restablecer, auditoría, recuperar
 *
 * API (JSON; las marcadas con 🔒 requieren `Authorization: Bearer <token de sesión>`):
 *   GET  estado      → {activas}
 *   POST sal         {rut} → {sal, iter}          (para una cuenta inexistente: una sal ficticia estable)
 *   POST entrar      {rut, acceso} → {token, exp, sesion, usuario}
 *   POST clave    🔒 {sal, iter, acceso, envuelta, accesoActual?} → {token, exp}
 *   POST salir    🔒 {motivo?}
 *   POST eventos  🔒 {eventos: [{ev, obj?, at?, n?, off?}]}
 *   POST preparar 🔒admin (o contraseña del equipo antes de activar) {id, existente?} → {complemento}
 *   POST activar     (contraseña del equipo) {usuario} — crea el primer administrador
 *   GET  usuarios 🔒admin → {usuarios}
 *   POST crear    🔒admin {id, rut, rol, admin, perfil, sal, iter, acceso, envuelta}
 *   POST editar   🔒admin {id, rol?, admin?, estado?, perfil?}
 *   POST restablecer 🔒admin {id, sal, iter, acceso, envuelta}
 *   GET  auditoria 🔒admin ?desde=<ms>&hasta=<ms> (o AAAA-MM-DD) → {eventos, sesiones}
 */
import { createAttempts } from './attempts.js';
import { json, fail, readBody } from './accounts/http.js';
import { createSecrets } from './accounts/secrets.js';
import { createAccountStore } from './accounts/store.js';
import { createLogin } from './accounts/login.js';
import { createSessionActions } from './accounts/session.js';
import { createAdmin } from './accounts/admin.js';
import { CLIENT_EVENTS } from './accounts/validate.js';

/** Eventos que puede informar la app (los demás los registra el servidor). */
export { CLIENT_EVENTS };

/** @typedef {import('./server.js').BlobStore} BlobStore */
/** @typedef {import('./accounts/store.js').Cuenta} Cuenta */
/** @typedef {import('./accounts/store.js').Sesion} Sesion */
/** @typedef {import('./accounts/session.js').Autenticado} Autenticado */
/** @typedef {import('./accounts/http.js').Peticion} Peticion */
/** @typedef {import('./accounts/http.js').PeticionConSesion} PeticionConSesion */
/**
 * @typedef {'publica' | 'sesion' | 'usuario' | 'admin'} Acceso
 *   publica: sin sesión (cada acción verifica lo suyo, p. ej. la contraseña del equipo);
 *   sesion: con sesión, aunque aún deba cambiar la clave inicial;
 *   usuario: con sesión y clave ya cambiada; admin: además, administrador.
 * @typedef {{method: 'GET' | 'POST'} & ({acceso: 'publica', run: (p: Peticion) => Promise<Response>} | {acceso: Exclude<Acceso, 'publica'>, run: (p: PeticionConSesion) => Promise<Response>})} Ruta
 */

/**
 * Respuesta de error si la petición no puede seguir aunque la ruta exista:
 * método equivocado (405) o servidor sin configurar (503). null si puede.
 * @param {Request} req
 * @param {string} method método de la ruta
 * @param {string} action
 * @param {boolean} ready ¿hay secreto del servidor?
 */
function refusedBeforeBody(req, method, action, ready) {
  if (req.method !== method) return fail(405, 'metodo', `Usa ${method} para ${action}`);
  if (!ready) return fail(503, 'no_configurado', 'Cuentas no configuradas en el servidor (falta SYNC_TOKEN_SHA256).');
  return null;
}

/**
 * Respuesta 403 si la sesión no alcanza para el acceso de la ruta: con la
 * clave inicial sin cambiar solo se usan las rutas de `sesion`; las de
 * `admin`, solo un administrador. null si puede.
 * @param {Exclude<Acceso, 'publica'>} acceso
 * @param {{mustChange: boolean, user: {admin?: boolean}}} a
 */
function accessDenied(acceso, a) {
  if (acceso !== 'sesion' && a.mustChange) return fail(403, 'debe_cambiar_clave', 'Primero cambia tu clave inicial.');
  if (acceso === 'admin' && !a.user.admin) return fail(403, 'sin_permiso', 'Solo un administrador puede hacer esto.');
  return null;
}

/**
 * @param {{store: BlobStore, secret: string | undefined, now?: () => number,
 *   rand?: (n: number) => Uint8Array, log?: (entry: Record<string, unknown>) => void}} deps
 *   `secret`: SYNC_TOKEN_SHA256 (hex). Sin él, las cuentas no están disponibles.
 */
export function createAccounts({
  store,
  secret,
  now = Date.now,
  rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  log = () => {},
}) {
  const randId = (n = 12) => Array.from(rand(n), (b) => (b % 36).toString(36)).join('');
  const keys = createSecrets(secret);
  const db = createAccountStore({ store, now, randId, rutHashOf: keys.rutHashOf });
  // Intentos anotados uno por uno (attempts.js): muchos a la vez no se pierden.
  const attempts = createAttempts(store, '_limites/cuentas/');
  const login = createLogin({ db, keys, attempts, now, randId });
  const session = createSessionActions({ db, keys, now });
  const admin = createAdmin({ db, keys, attempts, now, rand });

  /**
   * Rutas: método, quién puede usarlas (ver `Acceso`) y la acción. Toda ruta
   * está aquí: lo que no figura responde 404.
   * @type {Record<string, Ruta>}
   */
  const ROUTES = {
    estado: { method: 'GET', acceso: 'publica', run: async () => json(200, { activas: await db.isActive() }) },
    sal: { method: 'POST', acceso: 'publica', run: login.sal },
    entrar: { method: 'POST', acceso: 'publica', run: login.entrar },
    activar: { method: 'POST', acceso: 'publica', run: admin.activar },
    salir: { method: 'POST', acceso: 'sesion', run: session.salir },
    clave: { method: 'POST', acceso: 'sesion', run: session.clave },
    eventos: { method: 'POST', acceso: 'usuario', run: session.eventos },
    preparar: { method: 'POST', acceso: 'admin', run: admin.preparar },
    usuarios: { method: 'GET', acceso: 'admin', run: admin.usuarios },
    crear: { method: 'POST', acceso: 'admin', run: admin.crear },
    editar: { method: 'POST', acceso: 'admin', run: admin.editar },
    restablecer: { method: 'POST', acceso: 'admin', run: admin.restablecer },
    auditoria: { method: 'GET', acceso: 'admin', run: admin.auditoria },
  };

  /**
   * Valida ruta, método, cuerpo y acceso, y delega en la acción.
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async function handle(req) {
    const url = new URL(req.url);
    const action = url.pathname.split('/').filter(Boolean).pop() || '';
    const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : null;
    if (!route) return fail(404, 'ruta', 'Ruta no encontrada');
    const refused = refusedBeforeBody(req, route.method, action, keys.ready);
    if (refused) return refused;
    const body = await readBody(req);
    if ('response' in body) return body.response;
    /** @type {Peticion} */
    const p = { req, url, b: body.b, t: now() };
    if (route.acceso === 'publica') return route.run(p);
    // Antes de activar las cuentas no hay sesiones: el primer administrador se prepara con la contraseña del equipo.
    if (action === 'preparar' && !(await db.isActive())) return admin.prepararPrimero(p);

    const a = await session.authenticate(req);
    if ('response' in a) return a.response;
    return accessDenied(route.acceso, a) || route.run({ ...p, a, me: a.user });
  }

  return {
    /** ¿Están activadas las cuentas? (desde ese momento la sincronización exige sesión) */
    active: db.isActive,
    authenticate: session.authenticate,
    audit: db.audit,
    recoverAdmin: admin.recoverAdmin,
    /** @param {Request} req */
    async handler(req) {
      const started = Date.now();
      let res;
      try {
        res = await handle(req);
      } catch (e) {
        console.error('cuentas', e);
        res = fail(500, 'interno', 'Error interno del servidor de cuentas');
      }
      res.headers.set('x-content-type-options', 'nosniff');
      log({ action: new URL(req.url).pathname.split('/').pop(), status: res.status, ms: Date.now() - started });
      return res;
    },
  };
}
