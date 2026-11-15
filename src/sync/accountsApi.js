/**
 * Cliente de la API de cuentas (/api/cuentas/:accion; ver src/sync/accounts.js).
 * Los errores llevan el estado HTTP y el código estable del servidor; estado 0
 * = sin conexión.
 */
import { SyncHttpError } from './client.js';

/**
 * @param {{baseUrl?: string, fetchFn?: typeof fetch, timeoutMs?: number}} [o]
 */
export function createAccountsApi({ baseUrl = '/api/cuentas', fetchFn = globalThis.fetch?.bind(globalThis), timeoutMs = 15_000 } = {}) {
  /**
   * @param {string} path
   * @param {{body?: unknown, token?: string, query?: string}} [o]
   * @returns {Promise<any>} respuesta JSON
   */
  async function call(path, { body, token, query = '' } = {}) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}/${path}${query ? '?' + query : ''}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new SyncHttpError(res.status, data.error || `Error del servidor (${res.status})`, data.code || '');
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
    /** @param {string} rut @param {string} acceso */
    entrar: (rut, acceso) => call('entrar', { body: { rut, acceso } }),
    /** @param {string} token @param {object} body */
    clave: (token, body) => call('clave', { token, body }),
    /** @param {string} token @param {string} motivo */
    salir: (token, motivo) => call('salir', { token, body: { motivo } }),
    /** @param {string} token @param {object[]} eventos */
    eventos: (token, eventos) => call('eventos', { token, body: { eventos } }),
    /**
     * @param {string} token sesión de administrador o contraseña del equipo (antes de activar)
     * @param {string} id
     * @param {boolean} [existente] para restablecer la clave de una cuenta que ya existe
     */
    preparar: (token, id, existente = false) => call('preparar', { token, body: { id, ...(existente ? { existente: true } : {}) } }),
    /** @param {string} teamToken @param {object} usuario */
    activar: (teamToken, usuario) => call('activar', { token: teamToken, body: { usuario } }),
    /** @param {string} token */
    usuarios: (token) => call('usuarios', { token }),
    /** @param {string} token @param {object} body */
    crear: (token, body) => call('crear', { token, body }),
    /** @param {string} token @param {object} body */
    editar: (token, body) => call('editar', { token, body }),
    /** @param {string} token @param {object} body */
    restablecer: (token, body) => call('restablecer', { token, body }),
    /** @param {string} token @param {string} desde AAAA-MM-DD @param {string} hasta */
    auditoria: (token, desde, hasta) => call('auditoria', { token, query: `desde=${desde}&hasta=${hasta}` }),
  };
}
