/**
 * Cliente de la API de cuentas (/api/cuentas/:accion; ver src/sync/accounts.js).
 * Los errores llevan el estado HTTP y el código estable del servidor; estado 0
 * = sin conexión.
 */
import { SyncHttpError } from './client.js';

/** Cifrado hecho en un PC (perfil o clave envuelta). @typedef {{iv: string, ct: string}} Sellado */
/**
 * Cuenta tal como la entrega el servidor: sin secretos y con el perfil cifrado.
 * @typedef {{id: string, rol: string, admin: boolean, estado: 'activo' | 'desactivado', debeCambiar: boolean,
 *   tempExpira: number | null, perfil: Sellado, creado: number, actualizado: number, ultimoIngreso: number | null,
 *   bloqueadaHasta: number}} CuentaPublica
 */
/**
 * Respuesta de `entrar`: la sesión y lo que el PC necesita para abrir la clave del equipo.
 * @typedef {{token: string, exp: number, sesion: string, usuario: {id: string, rol: string, admin: boolean,
 *   debeCambiar: boolean, tempExpira: number | null, perfil: Sellado, envuelta: Sellado, complemento: string}}} RespuestaEntrar
 */

/**
 * Opciones de fetch (sin la señal): GET sin cuerpo, POST con JSON; con la sesión si la hay.
 * @param {unknown} body
 * @param {string | undefined} token
 */
const requestInit = (body, token) => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
  cache: /** @type {const} */ ('no-store'),
});

/**
 * Error de una respuesta no exitosa, con el mensaje y el código del servidor si los trae.
 * @param {Response} res
 * @param {{error?: string, code?: string}} data cuerpo de la respuesta
 */
const httpError = (res, data) => new SyncHttpError(res.status, data.error || `Error del servidor (${res.status})`, data.code || '');

/**
 * @param {{baseUrl?: string, fetchFn?: typeof fetch, timeoutMs?: number}} [o]
 */
export function createAccountsApi({ baseUrl = '/api/cuentas', fetchFn = globalThis.fetch?.bind(globalThis), timeoutMs = 15_000 } = {}) {
  /**
   * Solicitud a la API. Devuelve el JSON de la respuesta con la forma que
   * declara cada método de abajo (la que responde src/sync/accounts/).
   * @template T
   * @param {string} path
   * @param {{body?: unknown, token?: string, query?: string}} [o]
   * @returns {Promise<T>} respuesta JSON
   */
  async function call(path, { body, token, query = '' } = {}) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}/${path}${query ? '?' + query : ''}`, { ...requestInit(body, token), signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      return data;
    } catch (e) {
      if (e instanceof SyncHttpError) throw e;
      throw new SyncHttpError(0, timedOut ? 'El servidor no respondió a tiempo' : 'Sin conexión con el servidor');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** @returns {Promise<{activas: boolean}>} */
    estado: () => call('estado'),
    /** @param {string} rut @returns {Promise<{sal: string, iter: number}>} */
    sal: (rut) => call('sal', { body: { rut } }),
    /** @param {string} rut @param {string} acceso @returns {Promise<RespuestaEntrar>} */
    entrar: (rut, acceso) => call('entrar', { body: { rut, acceso } }),
    /** @param {string} token @param {object} body @returns {Promise<{token: string, exp: number}>} */
    clave: (token, body) => call('clave', { token, body }),
    /** @param {string} token @param {string} motivo @returns {Promise<{ok: true}>} */
    salir: (token, motivo) => call('salir', { token, body: { motivo } }),
    /** @param {string} token @param {object[]} eventos @returns {Promise<{registrados: number}>} */
    eventos: (token, eventos) => call('eventos', { token, body: { eventos } }),
    /**
     * @param {string} token sesión de administrador o contraseña del equipo (antes de activar)
     * @param {string} id
     * @param {boolean} [existente] para restablecer la clave de una cuenta que ya existe
     * @returns {Promise<{complemento: string}>}
     */
    preparar: (token, id, existente = false) => call('preparar', { token, body: { id, ...(existente ? { existente: true } : {}) } }),
    /** @param {string} teamToken @param {object} usuario @returns {Promise<{ok: true}>} */
    activar: (teamToken, usuario) => call('activar', { token: teamToken, body: { usuario } }),
    /** @param {string} token @returns {Promise<{usuarios: CuentaPublica[]}>} */
    usuarios: (token) => call('usuarios', { token }),
    /** @param {string} token @param {object} body @returns {Promise<{usuario: CuentaPublica}>} */
    crear: (token, body) => call('crear', { token, body }),
    /** @param {string} token @param {object} body @returns {Promise<{usuario: CuentaPublica}>} */
    editar: (token, body) => call('editar', { token, body }),
    /** @param {string} token @param {object} body @returns {Promise<{ok: true}>} */
    restablecer: (token, body) => call('restablecer', { token, body }),
    /**
     * @param {string} token @param {number} desde ms @param {number} hasta ms (inicio y fin del rango, hora local del PC)
     * @returns {Promise<{eventos: import('../core/accessLog.js').EventoAcceso[], sesiones: import('../core/accessLog.js').SesionAcceso[]}>}
     */
    auditoria: (token, desde, hasta) => call('auditoria', { token, query: `desde=${Math.floor(desde)}&hasta=${Math.floor(hasta)}` }),
  };
}
