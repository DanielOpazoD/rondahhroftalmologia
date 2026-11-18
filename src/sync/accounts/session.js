/**
 * Cuentas (servidor): la sesión ya abierta — verificar el token de una
 * solicitud y las acciones de quien tiene sesión: salir, cambiar su clave e
 * informar eventos de lectura. (Abrir la sesión está en login.js.)
 */
import { json, fail, bearer } from './http.js';
import { isCredentials, logoutReason, eventBatch, clientEvent, MAX_EVENTS } from './validate.js';
import { safeEqual } from './secrets.js';

/** @typedef {import('./store.js').Cuenta} Cuenta */
/** @typedef {import('./store.js').Sesion} Sesion */
/** @typedef {{user: Cuenta, sid: string, mustChange: boolean}} Autenticado */
/** @typedef {import('./http.js').PeticionConSesion} PeticionConSesion */

/**
 * @param {{
 *   db: ReturnType<typeof import('./store.js').createAccountStore>,
 *   keys: ReturnType<typeof import('./secrets.js').createSecrets>,
 *   now: () => number,
 * }} deps
 */
export function createSessionActions({ db, keys, now }) {
  /**
   * Verifica la sesión de la solicitud.
   * @param {Request} req
   * @returns {Promise<({ok: true} & Autenticado) | {ok: false, response: Response}>}
   */
  async function authenticate(req) {
    if (!keys.ready) return { ok: false, response: fail(503, 'no_configurado', 'Cuentas no configuradas en el servidor.') };
    const p = keys.readToken(bearer(req));
    const t = now();
    const expired = fail(401, 'sesion_invalida', 'La sesión terminó. Vuelve a entrar con tu RUT y clave.');
    if (!p || p.e < t) return { ok: false, response: expired };
    const ses = await db.getSession(p.s);
    if (!ses || ses.uid !== p.u) return { ok: false, response: expired };
    // Primero la cuenta: si se desactivó, la persona debe saberlo (no solo que su sesión terminó).
    const user = await db.getUser(p.u);
    if (!user || user.estado !== 'activo') {
      return { ok: false, response: fail(403, 'cuenta_desactivada', 'Tu cuenta está desactivada. Habla con un administrador.') };
    }
    if (ses.fin) return { ok: false, response: expired };
    if (t - ses.ultimo > 60_000) await db.putSession(p.s, { ...ses, ultimo: t });
    return { ok: true, user, sid: p.s, mustChange: Boolean(user.debeCambiar) };
  }

  /** @param {PeticionConSesion} p */
  async function salir({ b, t, a, me }) {
    const ses = await db.getSession(a.sid);
    const motivo = logoutReason(b.motivo);
    if (ses && !ses.fin) await db.putSession(a.sid, { ...ses, fin: t, motivo });
    await db.audit({ ev: 'sesion.fin', u: me.id, s: a.sid, det: { motivo } });
    return json(200, { ok: true });
  }

  /** @param {PeticionConSesion} p */
  async function clave({ b, t, a, me }) {
    const { accesoActual } = b;
    if (!isCredentials(b)) return fail(400, 'datos_invalidos', 'Datos inválidos');
    // Fuera del primer ingreso, cambiar la clave exige la actual.
    if (!me.debeCambiar && !(typeof accesoActual === 'string' && safeEqual(keys.verifierOf(accesoActual), me.verificador))) {
      return fail(401, 'credenciales', 'La clave actual no es correcta.');
    }
    if (safeEqual(keys.verifierOf(b.acceso), me.verificador)) {
      return fail(400, 'clave_igual', 'La clave nueva debe ser distinta de la actual.');
    }
    await db.putUser({
      ...me,
      sal: b.sal,
      iter: b.iter,
      verificador: keys.verifierOf(b.acceso),
      envuelta: b.envuelta,
      debeCambiar: false,
      tempExpira: null,
      claveCambiada: t,
      actualizado: t,
    });
    await db.audit({ ev: 'sesion.clave', u: me.id, s: a.sid });
    // La sesión existe: authenticate acaba de leerla.
    const ses = /** @type {Sesion} */ (await db.getSession(a.sid));
    return json(200, { token: keys.signToken({ u: me.id, s: a.sid, e: ses.exp, c: false }), exp: ses.exp });
  }

  /** Eventos de lectura que informa la app (fichas vistas, PDF, exportaciones…). @param {PeticionConSesion} p */
  async function eventos({ b, t, a, me }) {
    const list = eventBatch(b.eventos);
    if (!list) return fail(400, 'lote_invalido', `Se esperan hasta ${MAX_EVENTS} eventos`);
    let n = 0;
    for (const e of list) {
      const valid = clientEvent(e, t);
      if (!valid) continue;
      const { ev, ...rest } = valid;
      await db.audit({ ev, u: me.id, s: a.sid, ...rest });
      n++;
    }
    return json(200, { registrados: n });
  }

  return { authenticate, salir, clave, eventos };
}
