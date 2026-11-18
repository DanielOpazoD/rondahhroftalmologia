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
import { ACCOUNT_ITERATIONS } from '../accountCrypto.js';
import { accountRut, loginState, ACCOUNT_LOCK, SESSION_MS } from '../../core/accounts.js';

/** @typedef {import('./store.js').Cuenta} Cuenta */
/** @typedef {import('./http.js').Peticion} Peticion */

/** Límite por red de origen (varios PC del hospital comparten la IP pública). */
const ACCOUNT_IP_LIMIT = Object.freeze({ maxFails: 30, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });
/** Iteraciones de la sal ficticia: las de una cuenta nueva, para no delatar qué RUT tiene cuenta. */
const FAKE_ITERATIONS = ACCOUNT_ITERATIONS;

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
   * Un RUT sin cuenta se bloquea igual que una cuenta real: mismos intentos,
   * misma duración y misma respuesta. Si no, «cuenta bloqueada» (o su ausencia
   * tras 5 intentos) revelaría qué RUT tiene cuenta. Su registro de intentos va
   * con un id ficticio derivado del RUT (`x…`, nunca choca con uno real).
   * @param {unknown} rut
   */
  const fakeId = (rut) => 'x' + keys.rutHashOf(rut).slice(0, 32);

  /** Hasta cuándo está bloqueado un id ficticio (0 si no lo está). @param {string} id @param {number} t */
  async function fakeLockedUntil(id, t) {
    const marks = await attempts.recent('bloqueo', id, t, ACCOUNT_LOCK.lockMs);
    return marks.length ? marks[marks.length - 1] + ACCOUNT_LOCK.lockMs : 0;
  }

  /**
   * Bloquea por intentos fallidos (si no lo estaba ya): la cuenta, o el id ficticio.
   * Sobre la cuenta vigente (no la leída al empezar): no pisa lo que cambió
   * entretanto. Si la clave cambió (un administrador la restableció), los
   * intentos eran contra la anterior y no se bloquea.
   * @param {Cuenta | null} u @param {string} id @param {number} t
   */
  async function lock(u, id, t) {
    if (!u) {
      if ((await fakeLockedUntil(id, t)) <= t) await attempts.add('bloqueo', id, t);
      return;
    }
    const r = await db.updateUser(u.id, (cur) =>
      cur.verificador !== u.verificador || (cur.bloqueadaHasta || 0) > t
        ? null
        : { ...cur, fallos: 0, bloqueadaHasta: t + ACCOUNT_LOCK.lockMs },
    );
    if (r?.despues) await db.audit({ ev: 'sesion.bloqueada', u: u.id });
  }

  /**
   * Respuesta a un intento fallido. El intento ya quedó anotado (ver `entrar`):
   * con `tries` (los recientes, incluido este) al máximo, se bloquea.
   * @param {Request} req @param {Cuenta | null} u @param {string} id @param {number} t @param {number} tries
   */
  async function loginFailed(req, u, id, t, tries) {
    await ipFailure(req);
    if (tries >= ACCOUNT_LOCK.maxFails) await lock(u, id, t);
    // Una cuenta real que se bloquea queda anotada como «bloqueada» (en lock); lo demás, como intento fallido.
    if (!u || tries < ACCOUNT_LOCK.maxFails) await db.audit(u ? { ev: 'sesion.fallida', u: u.id } : { ev: 'sesion.fallida' });
    return fail(401, 'credenciales', 'RUT o clave incorrectos.');
  }

  /** @param {number} until hasta cuándo dura el bloqueo @param {number} t */
  function lockedResponse(until, t) {
    const min = Math.ceil((until - t) / 60_000);
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
   * @param {Cuenta | null} u @param {string} id @param {number} t
   */
  async function admitAttempt(u, id, t) {
    const mine = await attempts.add('cuenta', id, t);
    const tries = (await attempts.recent('cuenta', id, t, ACCOUNT_LOCK.lockMs)).length;
    if (tries <= ACCOUNT_LOCK.maxFails) return tries;
    await attempts.remove(mine); // un rechazo no alarga el bloqueo
    await lock(u, id, t);
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

  /**
   * Por qué la cuenta, tal como está ahora, no puede abrir una sesión con la
   * clave `verificador` (null si puede).
   * @param {Cuenta} cur @param {string} verificador @param {number} t
   */
  function refusal(cur, verificador, t) {
    // La clave cambió desde que se revisó (restablecida o cambiada): la recibida ya no es la vigente.
    if (cur.verificador !== verificador) return fail(401, 'credenciales', 'RUT o clave incorrectos.');
    const state = loginState(cur, t);
    if (state === 'desactivada') return fail(403, 'cuenta_desactivada', 'Tu cuenta está desactivada. Habla con un administrador.');
    // Bloqueada entretanto por intentos simultáneos: el bloqueo se respeta.
    if (state === 'bloqueada') return lockedResponse(cur.bloqueadaHasta, t);
    if (state === 'clave_inicial_vencida') {
      return fail(403, 'clave_inicial_vencida', 'Tu clave inicial venció. Pide a un administrador que la restablezca.');
    }
    return null;
  }

  /**
   * Clave correcta: abre la sesión (si la cuenta puede entrar). Lo decide
   * sobre la cuenta vigente al escribir, no sobre la leída al empezar: una
   * desactivación, un bloqueo o una clave nueva escritos entretanto se respetan.
   * @param {Cuenta} u la cuenta con la que se revisó la clave @param {number} t
   */
  async function openSession(u, t) {
    const r = await db.updateUser(u.id, (cur) =>
      refusal(cur, u.verificador, t) ? null : { ...cur, fallos: 0, bloqueadaHasta: 0, ultimoIngreso: t },
    );
    // La cuenta existe (se acaba de leer): r es null solo si se borró entretanto.
    if (!r) return fail(401, 'credenciales', 'RUT o clave incorrectos.');
    if (!r.despues) return /** @type {Response} */ (refusal(r.antes, u.verificador, t));
    const cuenta = r.despues;
    const sid = dayOf(t) + randId(16);
    const exp = t + SESSION_MS;
    await db.putSession(sid, { uid: cuenta.id, inicio: t, ultimo: t, exp });
    await db.audit({ ev: 'sesion.inicio', u: cuenta.id, s: sid });
    const { id, rol, admin, debeCambiar, tempExpira, perfil, envuelta } = cuenta;
    return json(200, {
      token: keys.signToken({ u: id, s: sid, e: exp, c: debeCambiar }),
      exp,
      sesion: sid,
      usuario: { id, rol, admin, debeCambiar, tempExpira, perfil, envuelta, complemento: keys.complementOf(id) },
    });
  }

  /** @param {Peticion} p */
  async function entrar({ req, b, t }) {
    const refused = await refusedLogin(req);
    if (refused) return refused;
    if (!isLogin(b)) return fail(400, 'datos_invalidos', 'Datos inválidos');
    const u = await db.userByRut(b.rut);
    // Con o sin cuenta, el mismo camino (ver fakeId).
    const id = u ? u.id : fakeId(b.rut);
    const until = u ? (loginState(u, t) === 'bloqueada' ? u.bloqueadaHasta || 0 : 0) : await fakeLockedUntil(id, t);
    if (until > t) return lockedResponse(until, t);
    const tries = await admitAttempt(u, id, t);
    if (tries === null) return lockedResponse(t + ACCOUNT_LOCK.lockMs, t);
    const right = safeEqual(keys.verifierOf(b.acceso), u ? u.verificador : '');
    if (!u || !right) return loginFailed(req, u, id, t, tries);
    await attempts.clear('cuenta', u.id);
    return openSession(u, t);
  }

  return { sal, entrar };
}
