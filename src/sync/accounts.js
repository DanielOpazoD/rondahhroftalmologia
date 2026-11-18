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
 * Almacén (mismo de la sincronización; las claves con `_` no son datos):
 *   _cuentas/config                 {activas, creado}
 *   _cuentas/u/<uid>                cuenta
 *   _cuentas/rut/<huella del RUT>   {uid}
 *   _cuentas/s/<AAAAMMDD>/<sid>     sesión {uid, inicio, ultimo, exp, fin?, motivo?}
 *   _auditoria/<AAAAMMDD>/<t>.<r>   evento (solo se agregan)
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
import { sha256, hmacSha256, toHex } from '../lib/sha256.js';
import { bytesToB64 } from './crypto.js';
import { createAttempts, waitMs } from './attempts.js';
import { accountRut, loginState, newUserId, USER_ID_RE, INITIAL_PASSWORD_HOURS, ACCOUNT_LOCK, SESSION_MS } from '../core/accounts.js';
import { ROLES } from '../config/catalogs.js';

/** @typedef {import('./server.js').BlobStore} BlobStore */

/**
 * @typedef {{
 *   id: string, rutHash: string, rol: string, admin: boolean, estado: 'activo' | 'desactivado',
 *   debeCambiar: boolean, tempExpira: number | null, sal: string, iter: number, verificador: string,
 *   envuelta: {iv: string, ct: string}, perfil: {iv: string, ct: string},
 *   fallos: number, bloqueadaHasta: number, creado: number, creadoPor: string | null,
 *   actualizado: number, ultimoIngreso: number | null, claveCambiada: number | null,
 * }} Cuenta
 */
/** @typedef {{uid: string, inicio: number, ultimo: number, exp: number, fin?: number, motivo?: string}} Sesion */
/** @typedef {{user: Cuenta, sid: string, mustChange: boolean}} Autenticado */

const ACCOUNT_IP_LIMIT = Object.freeze({ maxFails: 30, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });
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
const MAX_AUDIT_DAYS = 62;
const MAX_EVENTS = 100;
const ID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROLE_KEYS = ROLES.map((r) => r.key);
const DAY_MS = 24 * 3600_000;

/**
 * Evento de lectura informado por la app, ya validado: solo tipos conocidos,
 * un objeto con id seguro y números dentro de rango (lo demás se descarta).
 * null si no es un evento válido.
 * @param {any} e lo que llegó en el cuerpo de la petición
 * @param {number} t hora del servidor
 */
function clientEvent(e, t) {
  if (!e || !CLIENT_EVENTS.includes(e.ev)) return null;
  if (e.obj !== undefined && !(typeof e.obj === 'string' && ID_RE.test(e.obj))) return null;
  return {
    ev: e.ev,
    obj: e.obj,
    n: Number.isSafeInteger(e.n) && e.n >= 0 && e.n < 1e6 ? e.n : undefined,
    at: Number.isSafeInteger(e.at) && Math.abs(e.at - t) < 90 * DAY_MS ? e.at : undefined,
    off: e.off === true ? true : undefined,
  };
}
/** @param {number} t */
const dayOf = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

/** @type {(status: number, body: unknown) => Response} */
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
/** @type {(status: number, code: string, error: string, extra?: Record<string, unknown>) => Response} */
const fail = (status, code, error, extra = {}) => json(status, { error, code, ...extra });

/** @param {unknown} a @param {unknown} b */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** @param {string} s */
const b64url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** @param {string} s */
const unb64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

/** Cifrado válido (perfil o clave envuelta). @param {any} p */
const validSealed = (p) =>
  p &&
  typeof p === 'object' &&
  typeof p.iv === 'string' &&
  p.iv.length === 16 &&
  B64_RE.test(p.iv) &&
  typeof p.ct === 'string' &&
  p.ct.length > 0 &&
  p.ct.length <= 4000 &&
  B64_RE.test(p.ct);

/** Credenciales válidas de una clave (calculadas en el PC). @param {any} c */
const validCredentials = (c) =>
  c &&
  typeof c.sal === 'string' &&
  c.sal.length === 24 &&
  B64_RE.test(c.sal) &&
  Number.isSafeInteger(c.iter) &&
  c.iter >= 100_000 &&
  c.iter <= 5_000_000 &&
  typeof c.acceso === 'string' &&
  HEX64.test(c.acceso) &&
  validSealed(c.envuelta);

/** IP de origen (Netlify / proxy). @param {Request} req */
const clientIp = (req) =>
  req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'desconocida';

/** Cuerpo de más de 600 KB: se rechaza con 413 sin leerlo como JSON. */
const TOO_LARGE = Symbol('demasiado grande');

/** Lee el cuerpo JSON (pequeño). @param {Request} req */
async function readBody(req) {
  const text = await req.text();
  if (text.length > 600_000) return TOO_LARGE;
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
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
  const ready = typeof secret === 'string' && HEX64.test(secret);
  /** @type {(label: string, value: string) => string} */
  const mac = (label, value) => toHex(hmacSha256(/** @type {string} */ (secret), `${label}:${value}`));
  /** @param {unknown} rut */
  const rutHashOf = (rut) => mac('rut', accountRut(rut)).slice(0, 40);
  /** @param {string} acceso */
  const verifierOf = (acceso) => mac('acceso', acceso);
  /** Complemento de la clave de envoltura de una cuenta (ver accountCrypto.js). @param {string} uid */
  const complementOf = (uid) => mac('complemento', uid);
  const randId = (n = 12) => Array.from(rand(n), (b) => (b % 36).toString(36)).join('');

  const K = {
    config: '_cuentas/config',
    /** @param {string} uid */
    user: (uid) => `_cuentas/u/${uid}`,
    /** @param {string} rh */
    rut: (rh) => `_cuentas/rut/${rh}`,
    /** @param {string} sid */
    session: (sid) => `_cuentas/s/${sid.slice(0, 8)}/${sid}`,
    /** @param {string} h */
  };

  /** @returns {Promise<Cuenta | null>} @param {string} uid */
  const getUser = async (uid) =>
    /** @type {Cuenta | null} */ (USER_ID_RE.test(uid) ? await store.get(K.user(uid), { type: 'json' }) : null);
  /** @param {Cuenta} u */
  const putUser = (u) => store.setJSON(K.user(u.id), u);
  /** @param {unknown} rut */
  async function userByRut(rut) {
    if (!accountRut(rut)) return null;
    const idx = /** @type {{uid?: string} | null} */ (await store.get(K.rut(rutHashOf(rut)), { type: 'json' }));
    return idx?.uid ? getUser(idx.uid) : null;
  }
  async function allUsers() {
    const { blobs } = await store.list({ prefix: '_cuentas/u/' });
    const out = await Promise.all(blobs.map((b) => /** @type {Promise<Cuenta | null>} */ (store.get(b.key, { type: 'json' }))));
    return out.filter((u) => u !== null);
  }
  const isActive = async () => {
    const c = /** @type {{activas?: boolean} | null} */ (await store.get(K.config, { type: 'json' }));
    return c?.activas === true;
  };

  /**
   * Agrega un evento al registro de accesos (hora del servidor).
   * @param {{ev: string, u?: string | null, s?: string | null, obj?: string, n?: number, esp?: string, at?: number, off?: boolean, det?: Record<string, unknown>}} e
   */
  async function audit(e) {
    const t = now();
    const entry = Object.fromEntries(Object.entries({ t, ...e }).filter(([, v]) => v !== undefined && v !== null));
    await store.setJSON(`_auditoria/${dayOf(t)}/${t}.${randId(6)}`, entry);
  }

  /* ------------------------------------------------------------ sesión */

  /** @param {{u: string, s: string, e: number, c: boolean}} payload */
  function signToken(payload) {
    const bodyPart = b64url(JSON.stringify(payload));
    return `s1.${bodyPart}.${mac('sesion', bodyPart)}`;
  }

  /** @param {string} token */
  function readToken(token) {
    const m = /^s1\.([A-Za-z0-9_-]{10,400})\.([0-9a-f]{64})$/.exec(token);
    if (!m || !safeEqual(mac('sesion', m[1]), m[2])) return null;
    try {
      const p = JSON.parse(unb64url(m[1]));
      return p && typeof p.u === 'string' && typeof p.s === 'string' && Number.isFinite(p.e) ? p : null;
    } catch {
      return null;
    }
  }

  /** ¿La solicitud trae un token de sesión (y no la contraseña del equipo)? @param {Request} req */
  const bearer = (req) => {
    const a = req.headers.get('authorization') || '';
    return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
  };

  /**
   * Verifica la sesión de la solicitud.
   * @param {Request} req
   * @returns {Promise<({ok: true} & Autenticado) | {ok: false, response: Response}>}
   */
  async function authenticate(req) {
    if (!ready) return { ok: false, response: fail(503, 'no_configurado', 'Cuentas no configuradas en el servidor.') };
    const p = readToken(bearer(req));
    const t = now();
    const expired = fail(401, 'sesion_invalida', 'La sesión terminó. Vuelve a entrar con tu RUT y clave.');
    if (!p || p.e < t) return { ok: false, response: expired };
    const ses = /** @type {Sesion | null} */ (await store.get(K.session(p.s), { type: 'json' }));
    if (!ses || ses.uid !== p.u) return { ok: false, response: expired };
    // Primero la cuenta: si se desactivó, la persona debe saberlo (no solo que su sesión terminó).
    const user = await getUser(p.u);
    if (!user || user.estado !== 'activo') {
      return { ok: false, response: fail(403, 'cuenta_desactivada', 'Tu cuenta está desactivada. Habla con un administrador.') };
    }
    if (ses.fin) return { ok: false, response: expired };
    if (t - ses.ultimo > 60_000) await store.setJSON(K.session(p.s), { ...ses, ultimo: t });
    return { ok: true, user, sid: p.s, mustChange: Boolean(user.debeCambiar) };
  }

  /** Cierra todas las sesiones abiertas de una cuenta. @param {string} uid @param {string} motivo */
  async function closeSessionsOf(uid, motivo) {
    const t = now();
    const { blobs } = await store.list({ prefix: '_cuentas/s/' });
    for (const b of blobs) {
      const s = /** @type {Sesion | null} */ (await store.get(b.key, { type: 'json' }));
      if (s && s.uid === uid && !s.fin && s.exp > t) await store.setJSON(b.key, { ...s, fin: t, motivo });
    }
  }

  /* ------------------------------------------------- límite por red */

  // Intentos anotados uno por uno (attempts.js): muchos a la vez no se pierden.
  const attempts = createAttempts(store, '_limites/cuentas/');
  /** Red de origen como HMAC (la IP no se guarda). @param {Request} req */
  const netId = (req) => mac('ip', clientIp(req)).slice(0, 32);

  /** ms que falta esperar si la red de origen está bloqueada (0 si no). @param {Request} req */
  async function ipBlocked(req) {
    const t = now();
    const times = await attempts.recent('red', netId(req), t, ACCOUNT_IP_LIMIT.windowMs);
    return waitMs(times, ACCOUNT_IP_LIMIT.maxFails, t, ACCOUNT_IP_LIMIT.windowMs);
  }
  /** @param {Request} req */
  const ipFailure = (req) => attempts.add('red', netId(req), now());

  /* ------------------------------------------------------- vistas */

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

  /**
   * Cuenta nueva (alta o primer administrador).
   * @param {any} b cuerpo validado parcialmente
   * @param {string | null} creadoPor
   * @returns {Cuenta}
   */
  const newAccount = (b, creadoPor) => {
    const t = now();
    return {
      id: b.id,
      rutHash: rutHashOf(b.rut),
      rol: b.rol,
      admin: b.admin === true,
      estado: 'activo',
      debeCambiar: true,
      tempExpira: t + INITIAL_PASSWORD_HOURS * 3600_000,
      sal: b.sal,
      iter: b.iter,
      verificador: verifierOf(b.acceso),
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

  /** Validación común de un alta. @param {any} b @returns {string | null} */
  const accountProblem = (b) => {
    if (!b || !USER_ID_RE.test(b.id)) return 'Id de cuenta inválido';
    if (!accountRut(b.rut)) return 'RUT inválido';
    if (!ROLE_KEYS.includes(b.rol)) return 'Profesión inválida';
    if (!validSealed(b.perfil)) return 'Perfil inválido';
    if (!validCredentials(b)) return 'Credenciales inválidas';
    return null;
  };

  /** Crea la cuenta y su índice por RUT (falla si el RUT ya tiene cuenta). @param {Cuenta} u */
  async function insertAccount(u) {
    const idx = K.rut(u.rutHash);
    if (await store.get(idx, { type: 'json' })) return false;
    if (await getUser(u.id)) return false;
    await putUser(u);
    await store.setJSON(idx, { uid: u.id });
    return true;
  }

  /**
   * Antes de activar no hay cuentas, salvo la de una activación que quedó a
   * medias (se guardó la cuenta y no la configuración). Si es de este RUT, se
   * descarta para que el reintento pueda crearla de nuevo.
   * @param {string} rutHash
   */
  async function discardUnactivated(rutHash) {
    const idx = /** @type {{uid?: string} | null} */ (await store.get(K.rut(rutHash), { type: 'json' }));
    if (!idx) return;
    if (idx.uid) await store.delete(K.user(idx.uid));
    await store.delete(K.rut(rutHash));
  }

  /** Administradores activos. @param {Cuenta[]} users */
  const activeAdmins = (users) => users.filter((u) => u.admin && u.estado === 'activo');

  /* -------------------------------------------------------- handler */

  /**
   * Una solicitud ya validada (ruta, método, cuerpo JSON).
   * @typedef {{req: Request, url: URL, b: any, t: number}} Peticion
   *   `b`: cuerpo JSON de un POST (lo valida cada acción campo a campo); null en GET.
   * @typedef {Peticion & {a: Autenticado, me: Cuenta}} PeticionConSesion
   * @typedef {'publica' | 'sesion' | 'usuario' | 'admin'} Acceso
   *   publica: sin sesión (cada acción verifica lo suyo, p. ej. la contraseña del equipo);
   *   sesion: con sesión, aunque aún deba cambiar la clave inicial;
   *   usuario: con sesión y clave ya cambiada; admin: además, administrador.
   */

  /** @param {Peticion} p */
  async function sal({ b }) {
    if (!accountRut(b.rut)) return fail(400, 'rut_invalido', 'RUT inválido');
    const u = await userByRut(b.rut);
    // Para un RUT sin cuenta, una sal ficticia estable: no revela si existe.
    const s = u ? u.sal : bytesToB64(hmacSha256(/** @type {string} */ (secret), 'sal-ficticia:' + rutHashOf(b.rut)).slice(0, 16));
    return json(200, { sal: s, iter: u ? u.iter : 310_000 });
  }

  /**
   * Respuesta a un intento fallido. El intento ya quedó anotado (ver `entrar`):
   * con `tries` (los recientes, incluido este) al máximo, la cuenta se bloquea.
   * @param {Request} req @param {Cuenta | null} u @param {number} t @param {number} tries
   */
  async function loginFailed(req, u, t, tries) {
    await ipFailure(req);
    if (!u) {
      await audit({ ev: 'sesion.fallida' });
    } else if (tries >= ACCOUNT_LOCK.maxFails) {
      await lockAccount(u, t);
    } else await audit({ ev: 'sesion.fallida', u: u.id });
    return fail(401, 'credenciales', 'RUT o clave incorrectos.');
  }

  /** Bloquea la cuenta por intentos fallidos (si no lo estaba ya). @param {Cuenta} u @param {number} t */
  async function lockAccount(u, t) {
    if ((u.bloqueadaHasta || 0) > t) return;
    await putUser({ ...u, fallos: 0, bloqueadaHasta: t + ACCOUNT_LOCK.lockMs });
    await audit({ ev: 'sesion.bloqueada', u: u.id });
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
   * Lo que impide intentar entrar antes de mirar la cuenta: red bloqueada,
   * cuentas sin activar o datos mal formados. null si se puede seguir.
   * @param {Peticion} p
   */
  async function refusedLogin({ req, b }) {
    const blocked = await ipBlocked(req);
    if (blocked) {
      const r = fail(429, 'demasiados_intentos', 'Demasiados intentos desde esta red. Espera unos minutos.');
      r.headers.set('retry-after', String(Math.ceil(blocked / 1000)));
      return r;
    }
    if (!(await isActive())) return fail(409, 'cuentas_inactivas', 'Las cuentas de usuario aún no están activadas.');
    if (!accountRut(b.rut) || typeof b.acceso !== 'string' || !HEX64.test(b.acceso)) return fail(400, 'datos_invalidos', 'Datos inválidos');
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
    await store.setJSON(K.session(sid), { uid: u.id, inicio: t, ultimo: t, exp });
    await putUser({ ...u, fallos: 0, bloqueadaHasta: 0, ultimoIngreso: t });
    await audit({ ev: 'sesion.inicio', u: u.id, s: sid });
    const { id, rol, admin, debeCambiar, tempExpira, perfil, envuelta } = u;
    return json(200, {
      token: signToken({ u: u.id, s: sid, e: exp, c: u.debeCambiar }),
      exp,
      sesion: sid,
      usuario: { id, rol, admin, debeCambiar, tempExpira, perfil, envuelta, complemento: complementOf(u.id) },
    });
  }

  /** @param {Peticion} p */
  async function entrar(p) {
    const { req, b, t } = p;
    const refused = await refusedLogin(p);
    if (refused) return refused;
    const u = await userByRut(b.rut);
    if (!u) return loginFailed(req, null, t, 0);
    if (loginState(u, t) === 'bloqueada') return lockedResponse(u, t);
    const tries = await admitAttempt(u, t);
    if (tries === null) return lockedResponse({ ...u, bloqueadaHasta: t + ACCOUNT_LOCK.lockMs }, t);
    if (!safeEqual(verifierOf(b.acceso), u.verificador)) return loginFailed(req, u, t, tries);
    await attempts.clear('cuenta', u.id);
    return openSession(u, t);
  }

  /** Primer administrador: con la contraseña del equipo, antes de activar las cuentas. @param {Peticion} p */
  async function activar({ req, b, t }) {
    if (!isTeamToken(req)) return fail(401, 'token_invalido', 'Contraseña del equipo incorrecta.');
    if (await isActive()) return fail(409, 'ya_activas', 'Las cuentas ya están activadas.');
    const problem = accountProblem(b.usuario);
    if (problem) return fail(400, 'datos_invalidos', problem);
    const acc = newAccount({ ...b.usuario, admin: true }, null);
    await discardUnactivated(acc.rutHash);
    if (!(await insertAccount(acc))) return fail(409, 'rut_existe', 'Ya existe una cuenta con ese RUT.');
    // La configuración va al final: hasta aquí, un error deja las cuentas inactivas y se puede reintentar.
    await store.setJSON(K.config, { activas: true, creado: t });
    await audit({ ev: 'cuentas.activar', obj: acc.id });
    await audit({ ev: 'usuario.crear', obj: acc.id, det: { rol: acc.rol, admin: true } });
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
    if (!USER_ID_RE.test(b.id) || (await getUser(b.id))) return fail(400, 'id_invalido', 'Id de cuenta inválido');
    return json(200, { complemento: complementOf(b.id) });
  }
  /** @param {PeticionConSesion} p */
  async function preparar({ b }) {
    const exists = USER_ID_RE.test(b.id) && Boolean(await getUser(b.id));
    if (!USER_ID_RE.test(b.id) || exists !== (b.existente === true)) return fail(400, 'id_invalido', 'Id de cuenta inválido');
    return json(200, { complemento: complementOf(b.id) });
  }

  /** @param {PeticionConSesion} p */
  async function salir({ b, t, a, me }) {
    const key = K.session(a.sid);
    const ses = /** @type {Sesion | null} */ (await store.get(key, { type: 'json' }));
    const motivo = ['salir', 'inactividad', 'cierre'].includes(b.motivo) ? b.motivo : 'salir';
    if (ses && !ses.fin) await store.setJSON(key, { ...ses, fin: t, motivo });
    await audit({ ev: 'sesion.fin', u: me.id, s: a.sid, det: { motivo } });
    return json(200, { ok: true });
  }

  /** @param {PeticionConSesion} p */
  async function clave({ b, t, a, me }) {
    if (!validCredentials(b)) return fail(400, 'datos_invalidos', 'Datos inválidos');
    // Fuera del primer ingreso, cambiar la clave exige la actual.
    if (!me.debeCambiar && !(typeof b.accesoActual === 'string' && safeEqual(verifierOf(b.accesoActual), me.verificador))) {
      return fail(401, 'credenciales', 'La clave actual no es correcta.');
    }
    if (safeEqual(verifierOf(b.acceso), me.verificador)) return fail(400, 'clave_igual', 'La clave nueva debe ser distinta de la actual.');
    await putUser({
      ...me,
      sal: b.sal,
      iter: b.iter,
      verificador: verifierOf(b.acceso),
      envuelta: b.envuelta,
      debeCambiar: false,
      tempExpira: null,
      claveCambiada: t,
      actualizado: t,
    });
    await audit({ ev: 'sesion.clave', u: me.id, s: a.sid });
    const ses = /** @type {Sesion} */ (await store.get(K.session(a.sid), { type: 'json' }));
    return json(200, { token: signToken({ u: me.id, s: a.sid, e: ses.exp, c: false }), exp: ses.exp });
  }

  /** Eventos de lectura que informa la app (fichas vistas, PDF, exportaciones…). @param {PeticionConSesion} p */
  async function eventos({ b, t, a, me }) {
    const list = Array.isArray(b.eventos) ? b.eventos : null;
    if (!list || list.length > MAX_EVENTS) return fail(400, 'lote_invalido', `Se esperan hasta ${MAX_EVENTS} eventos`);
    let n = 0;
    for (const e of list) {
      const valid = clientEvent(e, t);
      if (!valid) continue;
      const { ev, ...rest } = valid;
      await audit({ ev, u: me.id, s: a.sid, ...rest });
      n++;
    }
    return json(200, { registrados: n });
  }

  /** @param {PeticionConSesion} p */
  async function crear({ b, a, me }) {
    const problem = accountProblem(b);
    if (problem) return fail(400, 'datos_invalidos', problem);
    const acc = newAccount(b, me.id);
    if (!(await insertAccount(acc))) return fail(409, 'rut_existe', 'Ya existe una cuenta con ese RUT.');
    await audit({ ev: 'usuario.crear', u: me.id, s: a.sid, obj: acc.id, det: { rol: acc.rol, admin: acc.admin } });
    return json(200, { usuario: publicUser(acc) });
  }

  /** Nueva clave inicial para una cuenta (el administrador la entrega en persona). @param {PeticionConSesion} p */
  async function restablecer({ b, t, a, me }) {
    const u = await getUser(b.id);
    if (!u) return fail(404, 'no_existe', 'La cuenta no existe.');
    if (!validCredentials(b)) return fail(400, 'datos_invalidos', 'Credenciales inválidas');
    await putUser({
      ...u,
      sal: b.sal,
      iter: b.iter,
      verificador: verifierOf(b.acceso),
      envuelta: b.envuelta,
      debeCambiar: true,
      tempExpira: t + INITIAL_PASSWORD_HOURS * 3600_000,
      fallos: 0,
      bloqueadaHasta: 0,
      actualizado: t,
    });
    await attempts.clear('cuenta', u.id);
    await closeSessionsOf(u.id, 'clave_restablecida');
    await audit({ ev: 'usuario.restablecer', u: me.id, s: a.sid, obj: u.id });
    return json(200, { ok: true });
  }

  /**
   * Cambios pedidos a una cuenta (profesión, administrador, estado, perfil), validados.
   * @param {any} b
   * @returns {{changes: Partial<Cuenta>} | {error: string}}
   */
  function accountChanges(b) {
    /** @type {Partial<Cuenta>} */
    const changes = {};
    if (b.rol !== undefined) {
      if (!ROLE_KEYS.includes(b.rol)) return { error: 'Profesión inválida' };
      changes.rol = b.rol;
    }
    if (b.admin !== undefined) changes.admin = b.admin === true;
    if (b.estado !== undefined) {
      if (!['activo', 'desactivado'].includes(b.estado)) return { error: 'Estado inválido' };
      changes.estado = b.estado;
    }
    if (b.perfil !== undefined) {
      if (!validSealed(b.perfil)) return { error: 'Perfil inválido' };
      changes.perfil = b.perfil;
    }
    return { changes };
  }

  /** @param {PeticionConSesion} p */
  async function editar({ b, t, a, me }) {
    const u = await getUser(b.id);
    if (!u) return fail(404, 'no_existe', 'La cuenta no existe.');
    const r = accountChanges(b);
    if ('error' in r) return fail(400, 'datos_invalidos', r.error);
    const { changes } = r;
    const next = { ...u, ...changes, actualizado: t };
    // Siempre debe quedar al menos un administrador activo.
    const users = (await allUsers()).map((x) => (x.id === u.id ? next : x));
    if (!activeAdmins(users).length) return fail(409, 'ultimo_admin', 'Debe quedar al menos un administrador activo.');
    await putUser(next);
    if (changes.estado === 'desactivado' && u.estado !== 'desactivado') await closeSessionsOf(u.id, 'cuenta_desactivada');
    const campos = Object.keys(changes).filter(
      (k) => JSON.stringify(changes[/** @type {keyof Cuenta} */ (k)]) !== JSON.stringify(u[/** @type {keyof Cuenta} */ (k)]),
    );
    await audit({
      ev: 'usuario.editar',
      u: me.id,
      s: a.sid,
      obj: u.id,
      det: { campos, ...(changes.estado ? { estado: changes.estado } : {}) },
    });
    return json(200, { usuario: publicUser(next) });
  }

  /**
   * Rango pedido para la auditoría, en ms. Acepta ms (inicio y fin del día
   * LOCAL del PC: el servidor guarda por día UTC y en Rapa Nui, de tarde, ya es
   * el día siguiente en UTC) o AAAA-MM-DD (días UTC completos).
   * @param {URLSearchParams} q @param {number} t
   * @returns {{desde: number, hasta: number} | null}
   */
  function auditRange(q, t) {
    /** @param {string | null} v @param {boolean} end */
    const when = (v, end) => (/^\d{10,16}$/.test(v || '') ? Number(v) : Date.parse(v || '') + (end ? DAY_MS - 1 : 0));
    const desde = when(q.get('desde'), false);
    const hasta = q.get('hasta') ? when(q.get('hasta'), true) : t;
    const ok = Number.isFinite(desde) && Number.isFinite(hasta) && hasta >= desde && (hasta - desde) / DAY_MS <= MAX_AUDIT_DAYS;
    return ok ? { desde, hasta } : null;
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
      const day = dayOf(d);
      const [ev, ses] = await Promise.all([store.list({ prefix: `_auditoria/${day}/` }), store.list({ prefix: `_cuentas/s/${day}/` })]);
      for (const x of ev.blobs) {
        const e = /** @type {{t: number} | null} */ (await store.get(x.key, { type: 'json' }));
        if (e && inRange(e.t)) evs.push(e);
      }
      for (const x of ses.blobs) {
        const s = /** @type {Sesion | null} */ (await store.get(x.key, { type: 'json' }));
        if (s && inRange(s.inicio)) sesiones.push({ id: x.key.split('/').pop(), ...s });
      }
    }
    await audit({ ev: 'auditoria.ver', u: me.id, s: a.sid });
    return json(200, { eventos: evs.sort((x, y) => x.t - y.t), sesiones });
  }

  /**
   * Rutas: método, quién puede usarlas (ver `Acceso`) y la acción. Toda ruta
   * está aquí: lo que no figura responde 404.
   * @type {Record<string, {method: 'GET' | 'POST'} & ({acceso: 'publica', run: (p: Peticion) => Promise<Response>} | {acceso: Exclude<Acceso, 'publica'>, run: (p: PeticionConSesion) => Promise<Response>})>}
   */
  const ROUTES = {
    estado: { method: 'GET', acceso: 'publica', run: async () => json(200, { activas: await isActive() }) },
    sal: { method: 'POST', acceso: 'publica', run: sal },
    entrar: { method: 'POST', acceso: 'publica', run: entrar },
    activar: { method: 'POST', acceso: 'publica', run: activar },
    salir: { method: 'POST', acceso: 'sesion', run: salir },
    clave: { method: 'POST', acceso: 'sesion', run: clave },
    eventos: { method: 'POST', acceso: 'usuario', run: eventos },
    preparar: { method: 'POST', acceso: 'admin', run: preparar },
    usuarios: { method: 'GET', acceso: 'admin', run: async () => json(200, { usuarios: (await allUsers()).map(publicUser) }) },
    crear: { method: 'POST', acceso: 'admin', run: crear },
    editar: { method: 'POST', acceso: 'admin', run: editar },
    restablecer: { method: 'POST', acceso: 'admin', run: restablecer },
    auditoria: { method: 'GET', acceso: 'admin', run: auditoria },
  };

  /** ¿Es la contraseña del equipo? (activar y preparar el primer administrador) @param {Request} req */
  const isTeamToken = (req) => {
    const tk = bearer(req);
    return Boolean(tk) && !tk.startsWith('s1.') && safeEqual(toHex(sha256(tk)), secret);
  };

  /**
   * Valida ruta, método, cuerpo y acceso, y delega en la acción.
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async function handle(req) {
    const url = new URL(req.url);
    const { action, route } = routeOf(url);
    if (!route) return fail(404, 'ruta', 'Ruta no encontrada');
    const refused = refusedBeforeBody(req, route.method, action);
    if (refused) return refused;
    const b = req.method === 'POST' ? await readBody(req) : null;
    const badBody = bodyProblem(req, b);
    if (badBody) return badBody;
    /** @type {Peticion} */
    const p = { req, url, b, t: now() };
    if (route.acceso === 'publica') return route.run(p);
    // Antes de activar las cuentas no hay sesiones: el primer administrador se prepara con la contraseña del equipo.
    if (action === 'preparar' && !(await isActive())) return prepararPrimero(p);

    const a = await authenticate(req);
    if ('response' in a) return a.response;
    return accessDenied(route.acceso, a) || route.run({ ...p, a, me: a.user });
  }

  /**
   * Acción pedida (último tramo de la ruta) y su definición; `route` null si no existe.
   * @param {URL} url
   */
  function routeOf(url) {
    const action = url.pathname.split('/').filter(Boolean).pop() || '';
    return { action, route: Object.hasOwn(ROUTES, action) ? ROUTES[action] : null };
  }

  /**
   * Respuesta de error si el cuerpo leído no sirve: demasiado grande (413) o,
   * en un POST, JSON que no es un objeto (400). null si sirve.
   * @param {Request} req
   * @param {unknown} b cuerpo leído (null si no es POST)
   */
  function bodyProblem(req, b) {
    if (b === TOO_LARGE) return fail(413, 'demasiado_grande', 'La solicitud es demasiado grande');
    if (req.method === 'POST' && (!b || typeof b !== 'object')) return fail(400, 'json_invalido', 'JSON inválido');
    return null;
  }

  /**
   * Respuesta de error si la petición no puede seguir aunque la ruta exista:
   * método equivocado (405) o servidor sin configurar (503). null si puede.
   * @param {Request} req
   * @param {string} method método de la ruta
   * @param {string} action
   */
  function refusedBeforeBody(req, method, action) {
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
   * Recuperación de un administrador SIN sesión (si se olvidaron todas las
   * claves de administrador). Solo la usa un script con acceso al almacén y
   * la contraseña del equipo (scripts/recover-admin.mjs; docs/OPERACION.md):
   * la cuenta del RUT (o una nueva) queda como administradora activa con
   * clave inicial, y sus sesiones abiertas se cierran.
   * @param {{rut: string, rol?: string,
   *   credentials: (uid: string, complemento: string) => Promise<{sal: string, iter: number, acceso: string, envuelta: {iv: string, ct: string}}>,
   *   perfil?: (uid: string) => Promise<{iv: string, ct: string}>}} o
   * @returns {Promise<{uid: string, creada: boolean}>}
   */
  async function recoverAdmin({ rut, rol = 'medico', credentials, perfil }) {
    if (!ready) throw new Error('Falta el secreto del servidor');
    if (!accountRut(rut)) throw new Error('RUT inválido');
    if (!(await isActive())) throw new Error('Las cuentas de usuario no están activadas: no hay nada que recuperar.');
    const t = now();
    const u = await userByRut(rut);
    const uid = u?.id || newUserId(rand);
    const c = await credentials(uid, complementOf(uid));
    if (!validCredentials(c)) throw new Error('Credenciales inválidas');
    if (u) {
      await putUser({
        ...u,
        admin: true,
        estado: 'activo',
        sal: c.sal,
        iter: c.iter,
        verificador: verifierOf(c.acceso),
        envuelta: c.envuelta,
        debeCambiar: true,
        tempExpira: t + INITIAL_PASSWORD_HOURS * 3600_000,
        fallos: 0,
        bloqueadaHasta: 0,
        actualizado: t,
      });
      await attempts.clear('cuenta', uid);
      await closeSessionsOf(uid, 'clave_restablecida');
    } else {
      if (!perfil) throw new Error('No hay cuenta con ese RUT: indica el nombre para crearla.');
      const acc = newAccount({ id: uid, rut, rol, admin: true, perfil: await perfil(uid), ...c }, null);
      if (!(await insertAccount(acc))) throw new Error('No se pudo crear la cuenta');
    }
    await audit({ ev: 'usuario.recuperar', obj: uid });
    return { uid, creada: !u };
  }

  return {
    /** ¿Están activadas las cuentas? (desde ese momento la sincronización exige sesión) */
    active: isActive,
    authenticate,
    audit,
    recoverAdmin,
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
