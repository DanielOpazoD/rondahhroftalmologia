/**
 * Cuentas (servidor): administración — activar las cuentas (primer
 * administrador, con la contraseña del equipo), preparar credenciales, crear,
 * editar y restablecer cuentas, leer el registro de accesos y recuperar un
 * administrador sin sesión (script de operación).
 */
import { json, fail, bearer } from './http.js';
import { isUserId, isCredentials, newAccountData, accountChanges, auditRange, DAY_MS, MAX_AUDIT_DAYS } from './validate.js';
import { dayOf } from './store.js';
import { accountRut, newUserId, INITIAL_PASSWORD_HOURS } from '../../core/accounts.js';

/** @typedef {import('./store.js').Cuenta} Cuenta */
/** @typedef {import('./validate.js').AltaCuenta} AltaCuenta */
/** @typedef {import('./validate.js').Credenciales} Credenciales */
/** @typedef {import('./http.js').Peticion} Peticion */
/** @typedef {import('./http.js').PeticionConSesion} PeticionConSesion */

/** Lo que ve un administrador de una cuenta (sin secretos). @param {Cuenta} u */
const publicUser = (u) => ({
  id: u.id,
  rol: u.rol,
  admin: u.admin,
  estado: u.estado,
  debeCambiar: u.debeCambiar,
  tempExpira: u.tempExpira,
  perfil: u.perfil,
  creado: u.creado,
  actualizado: u.actualizado,
  ultimoIngreso: u.ultimoIngreso,
  bloqueadaHasta: u.bloqueadaHasta || 0,
});

/** Administradores activos. @param {Cuenta[]} users */
const activeAdmins = (users) => users.filter((u) => u.admin && u.estado === 'activo');

/**
 * @param {{
 *   db: ReturnType<typeof import('./store.js').createAccountStore>,
 *   keys: ReturnType<typeof import('./secrets.js').createSecrets>,
 *   attempts: ReturnType<typeof import('../attempts.js').createAttempts>,
 *   now: () => number,
 *   rand: (n: number) => Uint8Array,
 * }} deps
 */
export function createAdmin({ db, keys, attempts, now, rand }) {
  /** @param {Request} req */
  const isTeamToken = (req) => keys.isTeamToken(bearer(req));

  /**
   * Cuenta nueva (alta o primer administrador).
   * @param {AltaCuenta} b alta validada
   * @param {string | null} creadoPor
   * @returns {Cuenta}
   */
  const newAccount = (b, creadoPor) => {
    const t = now();
    return {
      id: b.id,
      rutHash: keys.rutHashOf(b.rut),
      rol: b.rol,
      admin: b.admin === true,
      estado: 'activo',
      debeCambiar: true,
      tempExpira: t + INITIAL_PASSWORD_HOURS * 3600_000,
      sal: b.sal,
      iter: b.iter,
      verificador: keys.verifierOf(b.acceso),
      envuelta: b.envuelta,
      perfil: b.perfil,
      fallos: 0,
      bloqueadaHasta: 0,
      creado: t,
      creadoPor,
      actualizado: t,
      ultimoIngreso: null,
      claveCambiada: null,
    };
  };

  /**
   * La cuenta con una clave inicial nueva (restablecer o recuperar): debe
   * cambiarla al entrar, vence en INITIAL_PASSWORD_HOURS y se desbloquea.
   * @param {Cuenta} u @param {Credenciales} c @param {number} t
   * @returns {Cuenta}
   */
  const withInitialPassword = (u, c, t) => ({
    ...u,
    sal: c.sal,
    iter: c.iter,
    verificador: keys.verifierOf(c.acceso),
    envuelta: c.envuelta,
    debeCambiar: true,
    tempExpira: t + INITIAL_PASSWORD_HOURS * 3600_000,
    fallos: 0,
    bloqueadaHasta: 0,
    actualizado: t,
  });

  /** Primer administrador: con la contraseña del equipo, antes de activar las cuentas. @param {Peticion} p */
  async function activar({ req, b, t }) {
    if (!isTeamToken(req)) return fail(401, 'token_invalido', 'Contraseña del equipo incorrecta.');
    if (await db.isActive()) return fail(409, 'ya_activas', 'Las cuentas ya están activadas.');
    const r = newAccountData(b.usuario);
    if ('error' in r) return fail(400, 'datos_invalidos', r.error);
    const acc = newAccount({ ...r.alta, admin: true }, null);
    await db.discardUnactivated(acc.rutHash);
    if (!(await db.insertAccount(acc))) return fail(409, 'rut_existe', 'Ya existe una cuenta con ese RUT.');
    // La configuración va al final: hasta aquí, un error deja las cuentas inactivas y se puede reintentar.
    await db.markActive(t);
    await db.audit({ ev: 'cuentas.activar', obj: acc.id });
    await db.audit({ ev: 'usuario.crear', obj: acc.id, det: { rol: acc.rol, admin: true } });
    return json(200, { ok: true });
  }

  /**
   * Complemento del servidor para las credenciales de una cuenta. Antes de
   * activar (primer administrador): con la contraseña del equipo y para un id
   * nuevo. Después: solo un administrador, para una cuenta nueva o para
   * restablecer una existente (`existente: true`).
   * @param {Peticion} p
   */
  async function prepararPrimero({ req, b }) {
    if (!isTeamToken(req)) return fail(401, 'token_invalido', 'Contraseña del equipo incorrecta.');
    if (!isUserId(b.id) || (await db.getUser(b.id))) return fail(400, 'id_invalido', 'Id de cuenta inválido');
    return json(200, { complemento: keys.complementOf(b.id) });
  }
  /** @param {PeticionConSesion} p */
  async function preparar({ b }) {
    const { id } = b;
    if (!isUserId(id)) return fail(400, 'id_invalido', 'Id de cuenta inválido');
    const exists = Boolean(await db.getUser(id));
    if (exists !== (b.existente === true)) return fail(400, 'id_invalido', 'Id de cuenta inválido');
    return json(200, { complemento: keys.complementOf(id) });
  }

  /** @param {PeticionConSesion} p */
  async function crear({ b, a, me }) {
    const r = newAccountData(b);
    if ('error' in r) return fail(400, 'datos_invalidos', r.error);
    const acc = newAccount(r.alta, me.id);
    if (!(await db.insertAccount(acc))) return fail(409, 'rut_existe', 'Ya existe una cuenta con ese RUT.');
    await db.audit({ ev: 'usuario.crear', u: me.id, s: a.sid, obj: acc.id, det: { rol: acc.rol, admin: acc.admin } });
    return json(200, { usuario: publicUser(acc) });
  }

  /** Nueva clave inicial para una cuenta (el administrador la entrega en persona). @param {PeticionConSesion} p */
  async function restablecer({ b, t, a, me }) {
    const c = isCredentials(b) ? b : null;
    // Sobre la cuenta vigente al escribir: no pisa un cambio simultáneo (edición, bloqueo, ingreso).
    const r = isUserId(b.id) ? await db.updateUser(b.id, (cur) => (c ? withInitialPassword(cur, c, t) : null)) : null;
    if (!r) return fail(404, 'no_existe', 'La cuenta no existe.');
    if (!r.despues) return fail(400, 'datos_invalidos', 'Credenciales inválidas');
    const u = r.despues;
    await attempts.clear('cuenta', u.id);
    await db.closeSessionsOf(u.id, 'clave_restablecida');
    await db.audit({ ev: 'usuario.restablecer', u: me.id, s: a.sid, obj: u.id });
    return json(200, { ok: true });
  }

  /** @param {PeticionConSesion} p */
  async function editar({ b, t, a, me }) {
    const v = accountChanges(b);
    // Cambios válidos, o null: se rechazan después de ver que la cuenta existe (404 antes que 400).
    const valid = 'error' in v ? null : v.changes;
    const users = isUserId(b.id) && valid ? await db.allUsers() : [];
    /**
     * La cuenta con los cambios, aplicados sobre la versión vigente al escribir (dos ediciones
     * simultáneas no se pisan); null si no quedaría ningún administrador activo.
     * @param {Cuenta} cur
     */
    const edited = (cur) => {
      const next = { ...cur, ...valid, actualizado: t };
      return activeAdmins(users.map((x) => (x.id === cur.id ? next : x))).length ? next : null;
    };
    const r = isUserId(b.id) ? await db.updateUser(b.id, (cur) => (valid ? edited(cur) : null)) : null;
    if (!r) return fail(404, 'no_existe', 'La cuenta no existe.');
    if ('error' in v) return fail(400, 'datos_invalidos', v.error);
    if (!r.despues) return fail(409, 'ultimo_admin', 'Debe quedar al menos un administrador activo.');
    const { changes } = v;
    const { antes: u, despues: next } = r;
    if (changes.estado === 'desactivado' && u.estado !== 'desactivado') await db.closeSessionsOf(u.id, 'cuenta_desactivada');
    const campos = Object.keys(changes).filter(
      (k) => JSON.stringify(changes[/** @type {keyof typeof changes} */ (k)]) !== JSON.stringify(u[/** @type {keyof Cuenta} */ (k)]),
    );
    await db.audit({
      ev: 'usuario.editar',
      u: me.id,
      s: a.sid,
      obj: u.id,
      det: { campos, ...(changes.estado ? { estado: changes.estado } : {}) },
    });
    return json(200, { usuario: publicUser(next) });
  }

  /** @param {PeticionConSesion} p */
  async function auditoria({ url, t, a, me }) {
    const range = auditRange(url.searchParams, t);
    if (!range) return fail(400, 'rango_invalido', `Elige un rango de hasta ${MAX_AUDIT_DAYS} días.`);
    const { desde, hasta } = range;
    /** @type {{t: number}[]} */
    const evs = [];
    const sesiones = [];
    const inRange = (/** @type {number} */ x) => x >= desde && x <= hasta;
    for (let d = desde - (desde % DAY_MS); d <= hasta; d += DAY_MS) {
      const { events, sessions } = await db.auditDay(dayOf(d));
      evs.push(...events.filter((e) => inRange(e.t)));
      sesiones.push(...sessions.filter((s) => inRange(s.inicio)));
    }
    await db.audit({ ev: 'auditoria.ver', u: me.id, s: a.sid });
    return json(200, { eventos: evs.sort((x, y) => x.t - y.t), sesiones });
  }

  /** GET usuarios: todas las cuentas, sin secretos. */
  const usuarios = async () => json(200, { usuarios: (await db.allUsers()).map(publicUser) });

  /**
   * Recuperación de un administrador SIN sesión (si se olvidaron todas las
   * claves de administrador). Solo la usa un script con acceso al almacén y
   * la contraseña del equipo (scripts/recover-admin.mjs; docs/OPERACION.md):
   * la cuenta del RUT (o una nueva) queda como administradora activa con
   * clave inicial, y sus sesiones abiertas se cierran.
   * @param {{rut: string, rol?: string,
   *   credentials: (uid: string, complemento: string) => Promise<Credenciales>,
   *   perfil?: (uid: string) => Promise<{iv: string, ct: string}>}} o
   * @returns {Promise<{uid: string, creada: boolean}>}
   */
  async function recoverAdmin({ rut, rol = 'medico', credentials, perfil }) {
    if (!keys.ready) throw new Error('Falta el secreto del servidor');
    if (!accountRut(rut)) throw new Error('RUT inválido');
    if (!(await db.isActive())) throw new Error('Las cuentas de usuario no están activadas: no hay nada que recuperar.');
    const t = now();
    const u = await db.userByRut(rut);
    const uid = u?.id || newUserId(rand);
    const c = await credentials(uid, keys.complementOf(uid));
    if (!isCredentials(c)) throw new Error('Credenciales inválidas');
    if (u) {
      const r = await db.updateUser(uid, (cur) => withInitialPassword({ ...cur, admin: true, estado: 'activo' }, c, t));
      if (!r) throw new Error('La cuenta ya no existe');
      await attempts.clear('cuenta', uid);
      await db.closeSessionsOf(uid, 'clave_restablecida');
    } else {
      if (!perfil) throw new Error('No hay cuenta con ese RUT: indica el nombre para crearla.');
      const acc = newAccount({ id: uid, rut, rol, admin: true, perfil: await perfil(uid), ...c }, null);
      if (!(await db.insertAccount(acc))) throw new Error('No se pudo crear la cuenta');
    }
    await db.audit({ ev: 'usuario.recuperar', obj: uid });
    return { uid, creada: !u };
  }

  return { activar, prepararPrimero, preparar, crear, restablecer, editar, auditoria, usuarios, recoverAdmin };
}
