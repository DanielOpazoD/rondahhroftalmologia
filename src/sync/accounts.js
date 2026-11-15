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
 *   GET  auditoria 🔒admin ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD → {eventos, sesiones}
 */
import { sha256, hmacSha256, toHex } from '../lib/sha256.js';
import { bytesToB64 } from './crypto.js';
import { accountRut, loginState, USER_ID_RE, INITIAL_PASSWORD_DAYS, ACCOUNT_LOCK, SESSION_MS } from '../core/accounts.js';
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

export const ACCOUNT_IP_LIMIT = Object.freeze({ maxFails: 30, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });
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

/** Lee el cuerpo JSON (pequeño). @param {Request} req */
async function readBody(req) {
  const text = await req.text();
  if (text.length > 600_000) throw new Error('demasiado_grande');
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
    ipLimit: (h) => `_limites/cuentas/${h}`,
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
    return /** @type {Cuenta[]} */ (out.filter(Boolean));
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

  /** @param {Request} req */
  async function ipBlocked(req) {
    const key = K.ipLimit(mac('ip', clientIp(req)).slice(0, 32));
    const cur = /** @type {{until?: number} | null} */ (await store.get(key, { type: 'json' }));
    return cur?.until && cur.until > now() ? cur.until - now() : 0;
  }
  /** @param {Request} req */
  async function ipFailure(req) {
    const key = K.ipLimit(mac('ip', clientIp(req)).slice(0, 32));
    const t = now();
    const cur = /** @type {{first?: number, fails?: number, until?: number} | null} */ (await store.get(key, { type: 'json' }));
    const fresh = !cur?.first || t - cur.first > ACCOUNT_IP_LIMIT.windowMs || (cur.until && cur.until <= t);
    const next = { first: fresh ? t : cur?.first, fails: (fresh ? 0 : cur?.fails || 0) + 1, until: 0 };
    if (next.fails >= ACCOUNT_IP_LIMIT.maxFails) next.until = t + ACCOUNT_IP_LIMIT.blockMs;
    await store.setJSON(key, next);
  }

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
      tempExpira: t + INITIAL_PASSWORD_DAYS * DAY_MS,
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

  /** Administradores activos. @param {Cuenta[]} users */
  const activeAdmins = (users) => users.filter((u) => u.admin && u.estado === 'activo');

  /* -------------------------------------------------------- handler */

  /** Rutas: método y si requiere sesión de administrador. */
  const ROUTES = /** @type {const} */ ({
    estado: 'GET',
    sal: 'POST',
    entrar: 'POST',
    clave: 'POST',
    salir: 'POST',
    eventos: 'POST',
    preparar: 'POST',
    activar: 'POST',
    usuarios: 'GET',
    crear: 'POST',
    editar: 'POST',
    restablecer: 'POST',
    auditoria: 'GET',
  });

  /** ¿Es la contraseña del equipo? (activar y preparar el primer administrador) @param {Request} req */
  const isTeamToken = (req) => {
    const tk = bearer(req);
    return Boolean(tk) && !tk.startsWith('s1.') && safeEqual(toHex(sha256(tk)), secret);
  };

  /**
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async function handle(req) {
    const url = new URL(req.url);
    const action = /** @type {keyof typeof ROUTES} */ (url.pathname.split('/').filter(Boolean).pop() || '');
    if (!Object.hasOwn(ROUTES, action)) return fail(404, 'ruta', 'Ruta no encontrada');
    if (req.method !== ROUTES[action]) return fail(405, 'metodo', `Usa ${ROUTES[action]} para ${action}`);
    if (!ready) return fail(503, 'no_configurado', 'Cuentas no configuradas en el servidor (falta SYNC_TOKEN_SHA256).');
    const t = now();

    if (action === 'estado') return json(200, { activas: await isActive() });

    const b = req.method === 'POST' ? await readBody(req) : null;
    if (req.method === 'POST' && (!b || typeof b !== 'object')) return fail(400, 'json_invalido', 'JSON inválido');

    if (action === 'sal') {
      if (!accountRut(b.rut)) return fail(400, 'rut_invalido', 'RUT inválido');
      const u = await userByRut(b.rut);
      // Para un RUT sin cuenta, una sal ficticia estable: no revela si existe.
      const sal = u ? u.sal : bytesToB64(hmacSha256(/** @type {string} */ (secret), 'sal-ficticia:' + rutHashOf(b.rut)).slice(0, 16));
      return json(200, { sal, iter: u ? u.iter : 310_000 });
    }

    if (action === 'entrar') {
      const blocked = await ipBlocked(req);
      if (blocked) {
        const r = fail(429, 'demasiados_intentos', 'Demasiados intentos desde esta red. Espera unos minutos.');
        r.headers.set('retry-after', String(Math.ceil(blocked / 1000)));
        return r;
      }
      if (!(await isActive())) return fail(409, 'cuentas_inactivas', 'Las cuentas de usuario aún no están activadas.');
      if (!accountRut(b.rut) || typeof b.acceso !== 'string' || !HEX64.test(b.acceso)) {
        return fail(400, 'datos_invalidos', 'Datos inválidos');
      }
      const u = await userByRut(b.rut);
      if (u && loginState(u, t) === 'bloqueada') {
        const min = Math.ceil((u.bloqueadaHasta - t) / 60_000);
        return fail(
          423,
          'cuenta_bloqueada',
          `Cuenta bloqueada por intentos fallidos. Espera ${min} min o pide a un administrador que restablezca tu clave.`,
        );
      }
      if (!u || !safeEqual(verifierOf(b.acceso), u.verificador)) {
        await ipFailure(req);
        if (u) {
          const fallos = (u.fallos || 0) + 1;
          const lock = fallos >= ACCOUNT_LOCK.maxFails;
          await putUser({ ...u, fallos: lock ? 0 : fallos, bloqueadaHasta: lock ? t + ACCOUNT_LOCK.lockMs : u.bloqueadaHasta || 0 });
          await audit({ ev: lock ? 'sesion.bloqueada' : 'sesion.fallida', u: u.id });
        } else await audit({ ev: 'sesion.fallida' });
        return fail(401, 'credenciales', 'RUT o clave incorrectos.');
      }
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
      return json(200, {
        token: signToken({ u: u.id, s: sid, e: exp, c: u.debeCambiar }),
        exp,
        sesion: sid,
        usuario: {
          id: u.id,
          rol: u.rol,
          admin: u.admin,
          debeCambiar: u.debeCambiar,
          tempExpira: u.tempExpira,
          perfil: u.perfil,
          envuelta: u.envuelta,
          complemento: complementOf(u.id),
        },
      });
    }

    if (action === 'activar') {
      if (!isTeamToken(req)) return fail(401, 'token_invalido', 'Contraseña del equipo incorrecta.');
      if (await isActive()) return fail(409, 'ya_activas', 'Las cuentas ya están activadas.');
      const u = b.usuario;
      const problem = accountProblem(u);
      if (problem) return fail(400, 'datos_invalidos', problem);
      const acc = newAccount({ ...u, admin: true }, null);
      if (!(await insertAccount(acc))) return fail(409, 'rut_existe', 'Ya existe una cuenta con ese RUT.');
      await store.setJSON(K.config, { activas: true, creado: t });
      await audit({ ev: 'cuentas.activar', obj: acc.id });
      await audit({ ev: 'usuario.crear', obj: acc.id, det: { rol: acc.rol, admin: true } });
      return json(200, { ok: true });
    }

    if (action === 'preparar' && !(await isActive())) {
      if (!isTeamToken(req)) return fail(401, 'token_invalido', 'Contraseña del equipo incorrecta.');
      if (!USER_ID_RE.test(b.id) || (await getUser(b.id))) return fail(400, 'id_invalido', 'Id de cuenta inválido');
      return json(200, { complemento: complementOf(b.id) });
    }

    // Desde aquí, todo requiere sesión.
    const a = await authenticate(req);
    if ('response' in a) return a.response;
    const me = a.user;

    if (action === 'salir') {
      const key = K.session(a.sid);
      const ses = /** @type {Sesion | null} */ (await store.get(key, { type: 'json' }));
      const motivo = ['salir', 'inactividad', 'cierre'].includes(b.motivo) ? b.motivo : 'salir';
      if (ses && !ses.fin) await store.setJSON(key, { ...ses, fin: t, motivo });
      await audit({ ev: 'sesion.fin', u: me.id, s: a.sid, det: { motivo } });
      return json(200, { ok: true });
    }

    if (action === 'clave') {
      if (!validCredentials(b)) return fail(400, 'datos_invalidos', 'Datos inválidos');
      // Fuera del primer ingreso, cambiar la clave exige la actual.
      if (!me.debeCambiar && !(typeof b.accesoActual === 'string' && safeEqual(verifierOf(b.accesoActual), me.verificador))) {
        return fail(401, 'credenciales', 'La clave actual no es correcta.');
      }
      if (safeEqual(verifierOf(b.acceso), me.verificador)) {
        return fail(400, 'clave_igual', 'La clave nueva debe ser distinta de la actual.');
      }
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

    if (a.mustChange) return fail(403, 'debe_cambiar_clave', 'Primero cambia tu clave inicial.');

    if (action === 'eventos') {
      const list = Array.isArray(b.eventos) ? b.eventos : null;
      if (!list || list.length > MAX_EVENTS) return fail(400, 'lote_invalido', `Se esperan hasta ${MAX_EVENTS} eventos`);
      let n = 0;
      for (const e of list) {
        if (!e || !CLIENT_EVENTS.includes(e.ev)) continue;
        if (e.obj !== undefined && !(typeof e.obj === 'string' && ID_RE.test(e.obj))) continue;
        await audit({
          ev: e.ev,
          u: me.id,
          s: a.sid,
          obj: e.obj,
          n: Number.isSafeInteger(e.n) && e.n >= 0 && e.n < 1e6 ? e.n : undefined,
          at: Number.isSafeInteger(e.at) && Math.abs(e.at - t) < 90 * DAY_MS ? e.at : undefined,
          off: e.off === true ? true : undefined,
        });
        n++;
      }
      return json(200, { registrados: n });
    }

    if (!me.admin) return fail(403, 'sin_permiso', 'Solo un administrador puede hacer esto.');

    if (action === 'preparar') {
      // Para restablecer la clave de una cuenta existente (`existente: true`) o para una cuenta nueva.
      const exists = USER_ID_RE.test(b.id) && Boolean(await getUser(b.id));
      if (!USER_ID_RE.test(b.id) || exists !== (b.existente === true)) return fail(400, 'id_invalido', 'Id de cuenta inválido');
      return json(200, { complemento: complementOf(b.id) });
    }

    if (action === 'usuarios') return json(200, { usuarios: (await allUsers()).map(publicUser) });

    if (action === 'crear') {
      const problem = accountProblem(b);
      if (problem) return fail(400, 'datos_invalidos', problem);
      const acc = newAccount(b, me.id);
      if (!(await insertAccount(acc))) return fail(409, 'rut_existe', 'Ya existe una cuenta con ese RUT.');
      await audit({ ev: 'usuario.crear', u: me.id, s: a.sid, obj: acc.id, det: { rol: acc.rol, admin: acc.admin } });
      return json(200, { usuario: publicUser(acc) });
    }

    if (action === 'editar' || action === 'restablecer') {
      const u = await getUser(b.id);
      if (!u) return fail(404, 'no_existe', 'La cuenta no existe.');
      if (action === 'restablecer') {
        if (!validCredentials(b)) return fail(400, 'datos_invalidos', 'Credenciales inválidas');
        await putUser({
          ...u,
          sal: b.sal,
          iter: b.iter,
          verificador: verifierOf(b.acceso),
          envuelta: b.envuelta,
          debeCambiar: true,
          tempExpira: t + INITIAL_PASSWORD_DAYS * DAY_MS,
          fallos: 0,
          bloqueadaHasta: 0,
          actualizado: t,
        });
        await closeSessionsOf(u.id, 'clave_restablecida');
        await audit({ ev: 'usuario.restablecer', u: me.id, s: a.sid, obj: u.id });
        return json(200, { ok: true });
      }
      /** @type {Partial<Cuenta>} */
      const changes = {};
      if (b.rol !== undefined) {
        if (!ROLE_KEYS.includes(b.rol)) return fail(400, 'datos_invalidos', 'Profesión inválida');
        changes.rol = b.rol;
      }
      if (b.admin !== undefined) changes.admin = b.admin === true;
      if (b.estado !== undefined) {
        if (!['activo', 'desactivado'].includes(b.estado)) return fail(400, 'datos_invalidos', 'Estado inválido');
        changes.estado = b.estado;
      }
      if (b.perfil !== undefined) {
        if (!validSealed(b.perfil)) return fail(400, 'datos_invalidos', 'Perfil inválido');
        changes.perfil = b.perfil;
      }
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

    if (action === 'auditoria') {
      const desde = Date.parse(url.searchParams.get('desde') || '');
      const hasta = Date.parse(url.searchParams.get('hasta') || '') || t;
      if (!Number.isFinite(desde) || hasta < desde || (hasta - desde) / DAY_MS > MAX_AUDIT_DAYS) {
        return fail(400, 'rango_invalido', `Elige un rango de hasta ${MAX_AUDIT_DAYS} días.`);
      }
      const eventos = [];
      const sesiones = [];
      for (let d = desde; d <= hasta + DAY_MS - 1; d += DAY_MS) {
        const day = dayOf(d);
        const [ev, ses] = await Promise.all([store.list({ prefix: `_auditoria/${day}/` }), store.list({ prefix: `_cuentas/s/${day}/` })]);
        for (const x of ev.blobs) eventos.push(await store.get(x.key, { type: 'json' }));
        for (const x of ses.blobs) {
          const s = /** @type {Sesion | null} */ (await store.get(x.key, { type: 'json' }));
          if (s) sesiones.push({ id: x.key.split('/').pop(), ...s });
        }
      }
      await audit({ ev: 'auditoria.ver', u: me.id, s: a.sid });
      return json(200, {
        eventos: eventos.filter(Boolean).sort((x, y) => /** @type {any} */ (x).t - /** @type {any} */ (y).t),
        sesiones,
      });
    }

    return fail(404, 'ruta', 'Ruta no encontrada');
  }

  return {
    /** ¿Están activadas las cuentas? (desde ese momento la sincronización exige sesión) */
    active: isActive,
    authenticate,
    audit,
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

/** Utilidad de pruebas: el hash de la contraseña del equipo es el secreto del servidor. */
export const secretFromTeamToken = (/** @type {string} */ token) => toHex(sha256(token));
