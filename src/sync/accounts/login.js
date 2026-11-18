/**
 * Cuentas (servidor): entrar con RUT y clave, en dos pasos (`sal` y `entrar`),
 * con los límites de intentos por cuenta y por red de origen, el bloqueo de
 * la cuenta y la apertura de la sesión.
 *
 * Los intentos se anotan uno por uno (attempts.js): muchos a la vez no se
 * pierden ni se saltan el límite.
 */
import { json, fail, clientIp } from './http.js';
import { isLogin } from './validate.js';
import { safeEqual } from './secrets.js';
import { dayOf } from './store.js';
import { waitMs } from '../attempts.js';
import { accountRut, loginState, ACCOUNT_LOCK, SESSION_MS } from '../../core/accounts.js';

/** @typedef {import('./store.js').Cuenta} Cuenta */
/** @typedef {import('./http.js').Peticion} Peticion */

/** Límite por red de origen (varios PC del hospital comparten la IP pública). */
const ACCOUNT_IP_LIMIT = Object.freeze({ maxFails: 30, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });
/** Iteraciones de la sal ficticia (las de una cuenta nueva). */
const FAKE_ITERATIONS = 310_000;

/**
 * @param {{
 *   db: ReturnType<typeof import('./store.js').createAccountStore>,
 *   keys: ReturnType<typeof import('./secrets.js').createSecrets>,
 *   attempts: ReturnType<typeof import('../attempts.js').createAttempts>,
 *   now: () => number,
 *   randId: (n?: number) => string,
 * }} deps
 */
export function createLogin({ db, keys, attempts, now, randId }) {
  /** @param {Request} req */
  const netId = (req) => keys.netId(clientIp(req));

  /** ms que falta esperar si la red de origen está bloqueada (0 si no). @param {Request} req */
  async function ipBlocked(req) {
    const t = now();
    const times = await attempts.recent('red', netId(req), t, ACCOUNT_IP_LIMIT.windowMs);
    return waitMs(times, ACCOUNT_IP_LIMIT.maxFails, t, ACCOUNT_IP_LIMIT.windowMs);
  }
  /** @param {Request} req */
  const ipFailure = (req) => attempts.add('red', netId(req), now());

  /** @param {Peticion} p */
  async function sal({ b }) {
    if (!accountRut(b.rut)) return fail(400, 'rut_invalido', 'RUT inválido');
    const u = await db.userByRut(b.rut);
    // Para un RUT sin cuenta, una sal ficticia estable: no revela si existe.
    const s = u ? u.sal : keys.fakeSalt(b.rut);
    return json(200, { sal: s, iter: u ? u.iter : FAKE_ITERATIONS });
  }

  /**
   * Respuesta a un intento fallido. El intento ya quedó anotado (ver `entrar`):
   * con `tries` (los recientes, incluido este) al máximo, la cuenta se bloquea.
   * @param {Request} req @param {Cuenta | null} u @param {number} t @param {number} tries
   */
  async function loginFailed(req, u, t, tries) {
    await ipFailure(req);
    if (!u) {
      await db.audit({ ev: 'sesion.fallida' });
    } else if (tries >= ACCOUNT_LOCK.maxFails) {
      await lockAccount(u, t);
    } else await db.audit({ ev: 'sesion.fallida', u: u.id });
    return fail(401, 'credenciales', 'RUT o clave incorrectos.');
  }

  /** Bloquea la cuenta por intentos fallidos (si no lo estaba ya). @param {Cuenta} u @param {number} t */
  async function lockAccount(u, t) {
    if ((u.bloqueadaHasta || 0) > t) return;
    await db.putUser({ ...u, fallos: 0, bloqueadaHasta: t + ACCOUNT_LOCK.lockMs });
    await db.audit({ ev: 'sesion.bloqueada', u: u.id });
  }

  /** @param {Cuenta} u @param {number} t */
  function lockedResponse(u, t) {
    const min = Math.ceil(((u.bloqueadaHasta || t + ACCOUNT_LOCK.lockMs) - t) / 60_000);
    return fail(
      423,
      'cuenta_bloqueada',
      `Cuenta bloqueada por intentos fallidos. Espera ${min} min o pide a un administrador que restablezca tu clave.`,
    );
  }

  /**
   * Anota el intento ANTES de revisar la clave, y cuenta los recientes. Si ya
   * había el máximo, no se revisa la clave: así muchos intentos simultáneos no
   * se saltan el límite. Devuelve cuántos hay (incluido este), o null si se rechaza.
   * @param {Cuenta} u @param {number} t
   */
  async function admitAttempt(u, t) {
    const mine = await attempts.add('cuenta', u.id, t);
    const tries = (await attempts.recent('cuenta', u.id, t, ACCOUNT_LOCK.lockMs)).length;
    if (tries <= ACCOUNT_LOCK.maxFails) return tries;
    await attempts.remove(mine); // un rechazo no alarga el bloqueo
    await lockAccount(u, t);
    return null;
  }

  /**
   * Lo que impide intentar entrar antes de mirar la cuenta: red bloqueada o
   * cuentas sin activar. null si se puede seguir.
   * @param {Request} req
   */
  async function refusedLogin(req) {
    const blocked = await ipBlocked(req);
    if (blocked) {
      const r = fail(429, 'demasiados_intentos', 'Demasiados intentos desde esta red. Espera unos minutos.');
      r.headers.set('retry-after', String(Math.ceil(blocked / 1000)));
      return r;
    }
    if (!(await db.isActive())) return fail(409, 'cuentas_inactivas', 'Las cuentas de usuario aún no están activadas.');
    return null;
  }

  /** Clave correcta: abre la sesión (si la cuenta puede entrar). @param {Cuenta} u @param {number} t */
  async function openSession(u, t) {
    const state = loginState(u, t);
    if (state === 'desactivada') return fail(403, 'cuenta_desactivada', 'Tu cuenta está desactivada. Habla con un administrador.');
    if (state === 'clave_inicial_vencida') {
      return fail(403, 'clave_inicial_vencida', 'Tu clave inicial venció. Pide a un administrador que la restablezca.');
    }
    const sid = dayOf(t) + randId(16);
    const exp = t + SESSION_MS;
    await db.putSession(sid, { uid: u.id, inicio: t, ultimo: t, exp });
    await db.putUser({ ...u, fallos: 0, bloqueadaHasta: 0, ultimoIngreso: t });
    await db.audit({ ev: 'sesion.inicio', u: u.id, s: sid });
    const { id, rol, admin, debeCambiar, tempExpira, perfil, envuelta } = u;
    return json(200, {
      token: keys.signToken({ u: u.id, s: sid, e: exp, c: u.debeCambiar }),
      exp,
      sesion: sid,
      usuario: { id, rol, admin, debeCambiar, tempExpira, perfil, envuelta, complemento: keys.complementOf(u.id) },
    });
  }

  /** @param {Peticion} p */
  async function entrar({ req, b, t }) {
    const refused = await refusedLogin(req);
    if (refused) return refused;
    if (!isLogin(b)) return fail(400, 'datos_invalidos', 'Datos inválidos');
    const u = await db.userByRut(b.rut);
    if (!u) return loginFailed(req, null, t, 0);
    if (loginState(u, t) === 'bloqueada') return lockedResponse(u, t);
    const tries = await admitAttempt(u, t);
    if (tries === null) return lockedResponse({ ...u, bloqueadaHasta: t + ACCOUNT_LOCK.lockMs }, t);
    if (!safeEqual(keys.verifierOf(b.acceso), u.verificador)) return loginFailed(req, u, t, tries);
    await attempts.clear('cuenta', u.id);
    return openSession(u, t);
  }

  return { sal, entrar };
}
