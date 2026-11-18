/**
 * Sincronización: el MOTOR (cuándo y cómo se sincroniza, activar con la
 * contraseña del equipo, estado). No toca la pantalla: avisa con `onChange`
 * (la vista vuelve a dibujar; ui/syncView.js) y `notify` (mensajes breves).
 *
 * Cuándo sincroniza (si está activa): al abrir la app, 4 s después de
 * guardar o eliminar, cada 2 minutos y al recuperar la conexión.
 */
import { syncMerge, syncFingerprint } from '../core/merge.js';
import { clock } from '../core/clock.js';
import { ESPECIALIDAD } from '../config/catalogs.js';
import { cryptoAvailable, deriveTeamKeys, tokenHash, importEncKey, passphraseProblem, DecryptError } from '../sync/crypto.js';
import { createSyncApi, syncOnce, SyncHttpError, createSyncCache } from '../sync/client.js';
import { PROTOCOL_VERSION } from '../sync/protocol.js';
import { logError } from './errorLog.js';
import { attachmentsPending, syncAttachmentContent } from '../sync/attachments.js';
import { readPatientItems, writePatientItems, readSpecialtyItems, writeSpecialtyItems, opaqueInSpecialty } from '../app/syncData.js';
import { TOPICS } from './events.js';

const INTERVAL_MS = 2 * 60 * 1000;
/** Espacio del servidor con las fichas de pacientes, compartido por todas las especialidades. */
const PATIENTS_SPACE = 'pacientes';
const DEBOUNCE_MS = 4000;

/** @typedef {import('../domain').ElementoSync} ElementoSync */

/**
 * Estado interno del motor.
 * @typedef {{
 *   config: ReturnType<import('./context.js').AppContext['store']['loadSyncConfig']>,
 *   key: CryptoKey | null,
 *   running: boolean,
 *   server: string,
 *   again: boolean,
 *   status: string,
 *   message: string,
 *   timer: ReturnType<typeof setTimeout> | undefined,
 *   interval: ReturnType<typeof setInterval> | undefined,
 *   caches: {pacientes: import('../sync/client.js').SyncCache, especialidad: import('../sync/client.js').SyncCache},
 *   damagedSeen: Set<string>,
 *   lastBackupAt?: number | null,
 *   skewMin?: number,
 *   skewWarned?: boolean,
 *   newerWarned?: boolean,
 * }} EstadoSync
 *   `skewMin`: minutos de desfase del reloj con el servidor; `skewWarned` / `newerWarned`: ya se avisó.
 */

export const STATUS_LABELS = Object.freeze({
  off: 'Desactivada',
  idle: 'Activa',
  syncing: 'Sincronizando…',
  offline: 'Sin conexión',
  error: 'Error',
});

/**
 * @param {import('./context.js').AppContext} ctx
 * @param {{onChange?: () => void, notify?: (message: string, ms?: number) => void}} [hooks]
 *   `onChange`: cambió el estado (la vista vuelve a dibujar); `notify`: mensaje breve para la persona.
 */
export function createSyncController(ctx, { onChange = () => {}, notify = () => {} } = {}) {
  const { store } = ctx;
  /** @type {EstadoSync} */
  const st = {
    config: store.loadSyncConfig(),
    key: null,
    running: false,
    server: 'unknown', // configured | unconfigured | unknown
    again: false,
    status: 'off', // off | idle | syncing | offline | error
    message: '',
    timer: undefined,
    interval: undefined,
    /** Estado entre sincronizaciones por espacio (solo cambios, huellas verificadas). */
    caches: { pacientes: createSyncCache(), especialidad: createSyncCache() },
    /** Datos dañados ya avisados en esta sesión. @type {Set<string>} */
    damagedSeen: new Set(),
  };
  const resetCaches = () => {
    st.caches = { pacientes: createSyncCache(), especialidad: createSyncCache() };
  };

  // En modo práctica nunca se sincroniza: los datos de ejemplo no salen del equipo.
  const available = () => !ctx.practice && cryptoAvailable() && /^https?:$/.test(location.protocol);

  /**
   * @param {string} status off | idle | syncing | offline | error
   * @param {string} [message]
   */
  const setStatus = (status, message = '') => {
    st.status = status;
    st.message = message;
    onChange();
  };

  /** @param {string} encKey clave del equipo (de la configuración vigente) @returns {Promise<CryptoKey>} */
  async function getKey(encKey) {
    st.key ||= await importEncKey(encKey);
    return st.key;
  }

  /**
   * Compara la hora del PC con la del servidor. Un reloj desajustado no rompe
   * la sincronización (ver core/clock.js), pero puede decidir mal qué edición
   * simultánea es la más reciente: se avisa para corregirlo.
   * @param {string | null} serverDate cabecera Date de la última respuesta (null si aún no hay)
   */
  function checkClock(serverDate) {
    const server = Date.parse(serverDate || '');
    if (!Number.isFinite(server)) return;
    const skew = Date.now() - server;
    st.skewMin = Math.abs(skew) > 3 * 60 * 1000 ? Math.round(skew / 60000) : 0;
    if (st.skewMin && !st.skewWarned) {
      st.skewWarned = true;
      notify(
        `La hora de este equipo está ${Math.abs(st.skewMin)} min ${st.skewMin > 0 ? 'adelantada' : 'atrasada'}. Ajústala en el sistema.`,
        6000,
      );
    }
  }

  /** Fichas de pacientes (espacio común). */
  const readPatients = () => readPatientItems(store);
  /** @param {ElementoSync[]} items */
  function writePatients(items) {
    writePatientItems(store, items);
    for (const i of items) clock.observe(i.updated);
    ctx.emit(TOPICS.DATOS);
  }

  /** Todo lo que se sincroniza de la especialidad (ver app/syncData.js). */
  const readLocal = () => readSpecialtyItems(store);

  /**
   * Aplica cambios que llegaron de otros equipos al estado de la app.
   * @param {ElementoSync[]} items
   * @param {Record<string, number>} tombstones
   */
  function writeLocal(items, tombstones) {
    writeSpecialtyItems(store, items, tombstones);
    // Reloj lógico: las ediciones siguientes quedarán después de todo lo recibido.
    for (const i of items) clock.observe(i.updated);
    ctx.reloadCatalogs();
    ctx.records = store.loadRecords();
    // Atención abierta en el formulario: incorporar lo que otro equipo grabó en ella
    // (si se está editando, se fusiona campo a campo sin perder lo escrito).
    if (ctx.rec.id) {
      const fresh = ctx.records.find((r) => r.id === ctx.rec.id);
      if (fresh && fresh.updated !== ctx.rec.updated) ctx.absorbRemote(fresh);
      if (!fresh) notify('La atención abierta fue eliminada en otro equipo', 4000);
    }
    ctx.emit(TOPICS.DATOS);
  }

  /**
   * Contenido de los adjuntos (espacio `<especialidad>-adjuntos`): solo si hay
   * algo que subir, bajar o borrar. Ver sync/attachments.js.
   * @param {CryptoKey} key
   * @param {string} token
   */
  async function syncAttachments(key, token) {
    if (!store.supportsAttachments()) return;
    const metas = store.loadAttachments();
    const purges = store.loadAttachmentPurges();
    const uploaded = store.loadAttachmentsUploaded();
    if (!attachmentsPending(metas, await store.attachmentDataIds(), (id) => uploaded.has(id), purges)) return;
    const r = await syncAttachmentContent({
      // sync/attachments.js describe `put` con object[]; el cliente pide SyncBlob[] (lo que esa capa le pasa).
      api: /** @type {import('../sync/attachments.js').AttSyncDeps['api']} */ (
        createSyncApi({ token, esp: `${ESPECIALIDAD.id}-adjuntos` })
      ),
      key,
      metas,
      purges,
      local: {
        ids: () => store.attachmentDataIds(),
        load: (id) => store.loadAttachmentData(id),
        save: (id, bytes) => store.saveAttachmentData(id, bytes),
        isUploaded: (id) => uploaded.has(id),
        markUploaded: (id) => uploaded.add(id),
      },
    });
    ctx.persist(() => {
      store.saveAttachmentsUploaded(uploaded);
      store.saveAttachmentPurges(store.loadAttachmentPurges().filter((id) => !r.borrados.includes(id)));
    });
    for (const id of r.fallidos) logError('adjuntos', new Error(`Contenido del adjunto ${id} no coincide con su huella`));
    if (r.bajados) ctx.emit(TOPICS.ADJUNTOS);
  }

  /**
   * Permiso para el servidor: la sesión de la cuenta (con cuentas de usuario,
   * ADR 0014) o la contraseña del equipo. null si no hay con qué sincronizar.
   */
  async function authToken() {
    if (!ctx.accounts?.active) return st.config?.token || null;
    if (!ctx.accounts.user) return null;
    return ctx.accounts.token() || (await ctx.accounts.ensureToken());
  }

  /**
   * Las dos pasadas de una sincronización: fichas de pacientes (espacio común a
   * todas las especialidades) y luego lo de la especialidad.
   * @param {string} token
   * @param {string} encKey
   */
  async function syncSpaces(token, encKey) {
    const key = await getKey(encKey);
    // Si esta clave ya sincronizó en este PC, lo que no se pueda descifrar es un dato dañado, no una clave equivocada.
    const common = { key, mergeFn: syncMerge, fingerprint: syncFingerprint, encKey, keyProven: Boolean(st.config?.lastSync) };
    // 1) Fichas de pacientes: espacio COMÚN a todas las especialidades.
    const resP = await syncOnce({
      ...common,
      api: createSyncApi({ token, esp: PATIENTS_SPACE }),
      // El id de una ficha es la huella del RUT: el servidor ve solo un id opaco.
      opaqueIds: true,
      cache: st.caches.pacientes,
      readLocal: readPatients,
      writeLocal: writePatients,
    });
    // 2) Atenciones, catálogos y bitácora: espacio de la especialidad.
    const api = createSyncApi({ token, esp: ESPECIALIDAD.id });
    // El id de un perfil de médico es la huella de su RUT: el servidor ve un id opaco.
    const resE = await syncOnce({
      ...common,
      api,
      readLocal,
      writeLocal,
      opaqueIds: opaqueInSpecialty,
      cache: st.caches.especialidad,
    });
    const got = resP.added + resP.updated + resP.deleted + resE.added + resE.updated + resE.deleted;
    reportDamaged([...resP.damaged, ...resE.damaged]);
    // El servidor informa su último respaldo diario en cada lista completa.
    if (api.lastBackupAt !== undefined) st.lastBackupAt = api.lastBackupAt;
    return { key, api, got };
  }

  /**
   * Datos del servidor que no se pudieron descifrar: se apartaron y la
   * sincronización siguió. Se avisa una vez por sesión (y queda en el registro de errores).
   * @param {string[]} ids
   */
  function reportDamaged(ids) {
    const fresh = ids.filter((id) => !st.damagedSeen.has(id));
    if (!fresh.length) return;
    for (const id of fresh) st.damagedSeen.add(id);
    logError(
      'sincronización',
      new Error(`${fresh.length} dato(s) del servidor no se pudieron descifrar y se apartaron: ${fresh.join(', ')}`),
    );
    notify(
      `${fresh.length === 1 ? 'Un dato' : `${fresh.length} datos`} del servidor no se pudo leer (dañado) y se omitió; lo demás se sincronizó. Avisa al administrador: se puede recuperar del respaldo diario.`,
      8000,
    );
  }

  /**
   * Lo que el servidor dijo de paso: hora (reloj del PC) y versión de protocolo
   * (si es más nueva, hay una app más nueva publicada).
   * @param {{serverDate: string | null, serverProtocol: number}} api
   */
  function checkServer(api) {
    checkClock(api.serverDate);
    if (api.serverProtocol > PROTOCOL_VERSION && !st.newerWarned) {
      st.newerWarned = true;
      ctx.showUpdate();
    }
  }

  /**
   * Estado y mensaje según el error de una sincronización.
   * @param {unknown} e
   * @returns {{error: string}}
   */
  function syncFailed(e) {
    const authCodes = ['sesion_invalida', 'cuenta_desactivada', 'debe_cambiar_clave'];
    if (e instanceof SyncHttpError && authCodes.includes(e.code)) {
      // La sesión ya no sirve, o (con la contraseña del equipo) las cuentas se activaron: hay que entrar.
      setStatus('off', e.message);
      ctx.accounts?.onAuthError(e.code);
      return { error: e.message };
    }
    const offline = e instanceof SyncHttpError && e.status === 0;
    if (offline) setStatus('offline', 'Sin conexión: se sincronizará al volver internet.');
    else if (e instanceof SyncHttpError && e.status === 426) {
      setStatus('error', 'Esta versión de la app es antigua para el servidor: recarga la página para actualizarla.');
    } else if (e instanceof DecryptError) {
      setStatus(
        'error',
        'Hay datos en el servidor que no se pueden descifrar con esta contraseña. Revisa que sea la misma en todos los PC.',
      );
    } else setStatus('error', /** @type {Error} */ (e).message || String(e));
    if (!offline) logError('sincronización', e);
    return { error: st.message };
  }

  /**
   * Sincroniza ahora. Devuelve qué pasó (para «Sincronizar ahora»): cuántos
   * cambios llegaron, o el error; undefined si no se pudo empezar.
   * @returns {Promise<{got: number} | {error: string} | undefined>}
   */
  async function syncNow() {
    if (!st.config || !available()) return;
    if (st.running) {
      st.again = true;
      return;
    }
    const token = await authToken();
    if (!token) {
      // Con cuentas: aún sin sesión, o entró sin conexión y la conexión no ha vuelto.
      if (ctx.accounts?.user) setStatus('offline', 'Sin conexión: se sincronizará al volver internet.');
      return;
    }
    // Pudo desactivarse mientras se obtenía la sesión.
    if (!st.config) return;
    st.running = true;
    setStatus('syncing');
    try {
      const { key, api, got } = await syncSpaces(token, st.config.encKey);
      ctx.ensurePatients();
      await syncAttachments(key, token);
      void ctx.accounts?.flushEvents();
      checkServer(api);
      // Si se desactivó durante la sincronización, sigue desactivada: no se guarda una configuración incompleta.
      if (st.config) {
        st.config = { ...st.config, lastSync: Date.now() };
        store.saveSyncConfig(st.config);
        setStatus('idle');
      }
      // Silenciosa: lo que cambie en la atención abierta se avisa en ella (absorbRemote).
      return { got };
    } catch (e) {
      return syncFailed(e);
    } finally {
      st.running = false;
      if (st.again) {
        st.again = false;
        schedule();
      }
    }
  }

  /** Sincroniza pronto (agrupa varios cambios seguidos). */
  function schedule() {
    if (!st.config) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => syncNow(), DEBOUNCE_MS);
  }

  function start() {
    // La configuración puede haber cambiado al entrar con una cuenta (clave del equipo de la cuenta).
    const fresh = store.loadSyncConfig();
    if (fresh?.encKey !== st.config?.encKey) {
      st.key = null;
      resetCaches();
    }
    st.config = fresh;
    clearInterval(st.interval);
    if (!st.config || !available()) {
      setStatus('off');
      return;
    }
    setStatus('idle');
    st.interval = setInterval(() => syncNow(), INTERVAL_MS);
    syncNow();
  }

  /**
   * Activa la sincronización con la contraseña del equipo.
   * @param {string} passphrase
   * @returns {Promise<{status: 'ok', serverReady: boolean} | {status: 'invalid' | 'wrong' | 'error', message: string} | undefined>}
   *   `wrong`: el servidor ya tiene otra contraseña; `serverReady: false`: falta configurar el servidor.
   */
  async function activate(passphrase) {
    if (ctx.practice) return;
    const problem = passphraseProblem(passphrase);
    if (problem) return { status: 'invalid', message: problem };
    setStatus('syncing', 'Preparando claves…');
    try {
      const keys = await deriveTeamKeys(passphrase);
      const hash = tokenHash(keys.token);
      let serverReady = true;
      try {
        await createSyncApi({ token: keys.token, esp: ESPECIALIDAD.id }).list();
      } catch (err) {
        // Error de la API (SyncHttpError): `status` 0 = sin conexión.
        const e = /** @type {{status?: number}} */ (err);
        if (e.status === 401) {
          st.server = 'configured';
          setStatus('off');
          return { status: 'wrong', message: 'Contraseña del equipo incorrecta' };
        }
        if (e.status !== 503 && e.status !== 0 && e.status !== 404) throw err;
        // 503/404: servidor aún sin configurar; 0: sin conexión. Se activa igual.
        serverReady = e.status === 0;
      }
      st.config = { encKey: keys.encKey, token: keys.token, hash, activatedAt: Date.now(), lastSync: null };
      st.key = null;
      resetCaches();
      store.saveSyncConfig(st.config);
      start();
      return { status: 'ok', serverReady };
    } catch (e) {
      const message = /** @type {Error} */ (e).message || String(e);
      setStatus('error', message);
      return { status: 'error', message };
    }
  }

  /** Desactiva la sincronización en este PC (los datos se conservan). */
  function deactivate() {
    clearInterval(st.interval);
    st.config = null;
    st.key = null;
    resetCaches();
    store.saveSyncConfig(null);
    setStatus('off');
  }

  /**
   * Pregunta al servidor, sin contraseña, si ya tiene una configurada:
   * 401 = sí (hay que usar la del equipo); 503 = no (primera configuración).
   */
  async function probeServer() {
    if (!available()) return;
    try {
      const res = await fetch(`/api/sync/list?esp=${ESPECIALIDAD.id}`, { cache: 'no-store' });
      st.server = res.status === 401 ? 'configured' : res.status === 503 ? 'unconfigured' : 'unknown';
    } catch {
      st.server = 'unknown';
    }
    onChange();
  }

  /** Al arrancar: pregunta al servidor y sincroniza al volver la conexión o la pestaña. */
  function init() {
    void probeServer();
    window.addEventListener('online', () => syncNow());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow());
  }

  return {
    init,
    start,
    schedule,
    syncNow,
    activate,
    deactivate,
    get enabled() {
      return !!st.config;
    },
    /**
     * ¿Es la contraseña del equipo? (desbloquear si se olvidó el PIN).
     * @param {string} pass
     */
    async verifyTeamPassword(pass) {
      if (!st.config || passphraseProblem(pass)) return false;
      const keys = await deriveTeamKeys(pass);
      return tokenHash(keys.token) === st.config.hash;
    },
    /** Estado (para la vista y el chequeo antes del operativo). */
    get state() {
      return {
        available: available(),
        configured: !!st.config,
        status: st.status,
        message: st.message,
        lastSync: st.config?.lastSync || null,
        skewMin: st.skewMin || 0,
        /** ¿El servidor ya tiene contraseña? configured | unconfigured | unknown */
        server: st.server,
        /** Valor para SYNC_TOKEN_SHA256 (configuración del servidor). */
        hash: st.config?.hash || '',
        /** Último respaldo diario del servidor (null: sin registro; undefined: aún no se sabe). */
        lastBackupAt: st.lastBackupAt,
      };
    },
  };
}
