/**
 * Sincronización en la interfaz: activar/desactivar, sincronizar en segundo
 * plano y mostrar el estado.
 *
 * Cuándo sincroniza (si está activa): al abrir la app, 4 s después de
 * guardar o eliminar, cada 2 minutos y al recuperar la conexión.
 */
import { syncMerge, syncFingerprint } from '../core/merge.js';
import { clock } from '../core/clock.js';
import { ESPECIALIDAD } from '../config/catalogs.js';
import { fmtDateTime } from '../core/format.js';
import {
  cryptoAvailable,
  deriveTeamKeys,
  tokenHash,
  importEncKey,
  generatePassphrase,
  passphraseProblem,
  DecryptError,
} from '../sync/crypto.js';
import { createSyncApi, syncOnce, SyncHttpError, createSyncCache } from '../sync/client.js';
import { PROTOCOL_VERSION } from '../sync/protocol.js';
import { logError } from './errorLog.js';
import { attachmentsPending, syncAttachmentContent } from '../sync/attachments.js';
import { readPatientItems, writePatientItems, readSpecialtyItems, writeSpecialtyItems, opaqueInSpecialty } from '../app/syncData.js';
import { $, toast, copyText } from './dom.js';
import { uiAlert, uiConfirm } from './modal.js';
import { html } from './html.js';

const INTERVAL_MS = 2 * 60 * 1000;
/** Espacio del servidor con las fichas de pacientes, compartido por todas las especialidades. */
export const PATIENTS_SPACE = 'pacientes';
const DEBOUNCE_MS = 4000;

/** @param {import('./context.js').AppContext} ctx */
export function createSyncController(ctx) {
  const { store } = ctx;
  const st = {
    config: store.loadSyncConfig(),
    key: null,
    running: false,
    server: 'unknown', // configured | unconfigured | unknown
    again: false,
    status: 'off', // off | idle | syncing | offline | error
    message: '',
    timer: null,
    interval: null,
    /** Estado entre sincronizaciones por espacio (solo cambios, huellas verificadas). */
    caches: { pacientes: createSyncCache(), especialidad: createSyncCache() },
  };
  const resetCaches = () => {
    st.caches = { pacientes: createSyncCache(), especialidad: createSyncCache() };
  };

  // En modo práctica nunca se sincroniza: los datos de ejemplo no salen del equipo.
  const available = () => !ctx.practice && cryptoAvailable() && /^https?:$/.test(location.protocol);

  const setStatus = (status, message = '') => {
    st.status = status;
    st.message = message;
    render();
  };

  async function getKey() {
    st.key ||= await importEncKey(st.config.encKey);
    return st.key;
  }

  /**
   * Compara la hora del PC con la del servidor. Un reloj desajustado no rompe
   * la sincronización (ver core/clock.js), pero puede decidir mal qué edición
   * simultánea es la más reciente: se avisa para corregirlo.
   */
  function checkClock(serverDate) {
    const server = Date.parse(serverDate || '');
    if (!Number.isFinite(server)) return;
    const skew = Date.now() - server;
    st.skewMin = Math.abs(skew) > 3 * 60 * 1000 ? Math.round(skew / 60000) : 0;
    if (st.skewMin && !st.skewWarned) {
      st.skewWarned = true;
      toast(
        `La hora de este equipo está ${Math.abs(st.skewMin)} min ${st.skewMin > 0 ? 'adelantada' : 'atrasada'}. Ajústala en el sistema.`,
        6000,
      );
    }
  }

  /** Fichas de pacientes (espacio común). */
  const readPatients = () => readPatientItems(store);
  function writePatients(items) {
    writePatientItems(store, items);
    for (const i of items) clock.observe(i.updated);
    ctx.emit('datos');
  }

  /** Todo lo que se sincroniza de la especialidad (ver app/syncData.js). */
  const readLocal = () => readSpecialtyItems(store);

  /** Aplica cambios que llegaron de otros equipos al estado de la app. */
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
      if (!fresh) toast('La atención abierta fue eliminada en otro equipo', 4000);
    }
    ctx.emit('datos');
  }

  /**
   * Contenido de los adjuntos (espacio `<especialidad>-adjuntos`): solo si hay
   * algo que subir, bajar o borrar. Ver sync/attachments.js.
   */
  async function syncAttachments(key, token) {
    if (!store.supportsAttachments()) return;
    const metas = store.loadAttachments();
    const purges = store.loadAttachmentPurges();
    const uploaded = store.loadAttachmentsUploaded();
    if (!attachmentsPending(metas, await store.attachmentDataIds(), (id) => uploaded.has(id), purges)) return;
    const r = await syncAttachmentContent({
      api: createSyncApi({ token, esp: `${ESPECIALIDAD.id}-adjuntos` }),
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
    if (r.bajados) ctx.emit('adjuntos');
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

  async function syncNow({ quiet = true } = {}) {
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
    st.running = true;
    setStatus('syncing');
    try {
      const key = await getKey();
      const common = { key, mergeFn: syncMerge, fingerprint: syncFingerprint, encKey: st.config.encKey };
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
      const res = { added: resP.added + resE.added, updated: resP.updated + resE.updated, deleted: resP.deleted + resE.deleted };
      ctx.ensurePatients();
      await syncAttachments(key, token);
      void ctx.accounts?.flushEvents();
      checkClock(api.serverDate);
      // El servidor habla una versión de protocolo más nueva: hay una app más nueva publicada.
      if (api.serverProtocol > PROTOCOL_VERSION && !st.newerWarned) {
        st.newerWarned = true;
        ctx.showUpdate();
      }
      st.config = { ...st.config, lastSync: Date.now() };
      store.saveSyncConfig(st.config);
      setStatus('idle');
      // Silenciosa: solo se informa si se pidió con «Sincronizar ahora». Lo que
      // cambie en la atención abierta se avisa en ella (absorbRemote).
      const got = res.added + res.updated + res.deleted;
      if (!quiet) {
        toast(
          got ? `Sincronizado: ${got} ${got === 1 ? 'cambio recibido' : 'cambios recibidos'} de otros equipos` : 'Sincronizado',
          got ? 3500 : 1800,
        );
      }
    } catch (e) {
      const authCodes = ['sesion_invalida', 'cuenta_desactivada', 'debe_cambiar_clave'];
      if (e instanceof SyncHttpError && authCodes.includes(e.code)) {
        // La sesión ya no sirve, o (con la contraseña del equipo) las cuentas se activaron: hay que entrar.
        setStatus('off', e.message);
        ctx.accounts?.onAuthError(e.code);
        return;
      }
      if (e instanceof SyncHttpError && e.status === 0) setStatus('offline', 'Sin conexión: se sincronizará al volver internet.');
      else if (e instanceof SyncHttpError && e.status === 426) {
        setStatus('error', 'Esta versión de la app es antigua para el servidor: recarga la página para actualizarla.');
      } else if (e instanceof DecryptError) {
        setStatus(
          'error',
          'Hay datos en el servidor que no se pueden descifrar con esta contraseña. Revisa que sea la misma en todos los PC.',
        );
      } else setStatus('error', e.message || String(e));
      if (!(e instanceof SyncHttpError && e.status === 0)) logError('sincronización', e);
      if (!quiet) toast(st.message, 4000);
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

  async function activate(passphrase) {
    if (ctx.practice) return;
    const problem = passphraseProblem(passphrase);
    if (problem) return toast(problem, 4000);
    setStatus('syncing', 'Preparando claves…');
    try {
      const keys = await deriveTeamKeys(passphrase);
      const hash = tokenHash(keys.token);
      let serverReady = true;
      try {
        await createSyncApi({ token: keys.token, esp: ESPECIALIDAD.id }).list();
      } catch (e) {
        if (e.status === 401) {
          setStatus('off');
          st.server = 'configured';
          render();
          $('#syncPass').select();
          return uiAlert({
            title: 'Contraseña incorrecta',
            tone: 'danger',
            html: html`Esta no es la contraseña del equipo. El servidor ya tiene una configurada: escribe <b>la misma que usan los otros PC</b>; no generes una nueva.<br><br>Si nadie la tiene, hay que reemplazarla en el servidor (ver «Cambiar la contraseña» en la documentación).`,
          });
        }
        if (e.status !== 503 && e.status !== 0 && e.status !== 404) throw e;
        // 503/404: servidor aún sin configurar; 0: sin conexión. Se activa igual.
        serverReady = e.status === 0;
      }
      st.config = { encKey: keys.encKey, token: keys.token, hash, activatedAt: Date.now(), lastSync: null };
      st.key = null;
      resetCaches();
      store.saveSyncConfig(st.config);
      $('#syncPass').value = '';
      start();
      if (!serverReady) {
        $('#syncActive details.setup').open = true;
        uiAlert({
          title: 'Falta configurar el servidor',
          tone: 'warn',
          html: html`La sincronización quedó activa en este PC, pero el servidor aún no tiene contraseña. Copia el valor de <b>Configuración del servidor</b> y créalo en Netlify como <code>SYNC_TOKEN_SHA256</code>; luego vuelve a publicar el sitio.`,
        });
      } else {
        toast('Sincronización activada en este PC');
      }
    } catch (e) {
      setStatus('error', e.message || String(e));
    }
  }

  async function deactivate() {
    const ok = await uiConfirm({
      title: 'Desactivar sincronización',
      message: 'Los datos de este PC se conservan, pero sus cambios dejarán de compartirse con los otros equipos.',
      tone: 'warn',
      okLabel: 'Desactivar',
    });
    if (!ok) return;
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
    render();
  }

  function init() {
    probeServer();
    $('#syncGen').addEventListener('click', () => {
      $('#syncPass').value = generatePassphrase();
      $('#syncPass').type = 'text';
    });
    $('#syncShow').addEventListener('click', () => ($('#syncPass').type = $('#syncPass').type === 'password' ? 'text' : 'password'));
    $('#syncOn').addEventListener('click', () => activate($('#syncPass').value));
    $('#syncOff').addEventListener('click', deactivate);
    $('#syncNowBtn').addEventListener('click', () => syncNow({ quiet: false }));
    $('#syncCopyHash').addEventListener('click', async () =>
      toast((await copyText(st.config?.hash || '')) ? 'Valor copiado' : 'No se pudo copiar'),
    );
    $('#syncBadge').addEventListener('click', () => ctx.showTab('t-aj'));
    window.addEventListener('online', () => syncNow());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow());
  }

  const LABELS = { off: 'Desactivada', idle: 'Activa', syncing: 'Sincronizando…', offline: 'Sin conexión', error: 'Error' };

  function render() {
    const on = !!st.config;
    $('#syncUnavailable').hidden = available();
    $('#syncUnavailable').textContent = ctx.practice
      ? 'En el modo práctica no hay sincronización: los datos de ejemplo quedan solo en este equipo.'
      : 'La sincronización solo funciona al abrir la app desde su dirección web (https). Con el archivo abierto con doble clic, usa el respaldo.';
    const acc = Boolean(ctx.accounts?.active);
    // Con cuentas de usuario, la sincronización va con la sesión: no hay contraseña del equipo que configurar.
    $('#syncSetup').hidden = on || !available() || acc;
    $('#syncOff').hidden = acc;
    $('#syncActive details.setup').hidden = acc;
    ctx.accounts?.render(); // «Activar cuentas» depende de que haya contraseña del equipo
    // «Generar» solo en la primera configuración: si el servidor ya tiene
    // contraseña, generar otra solo produce una que no coincide.
    const firstSetup = st.server === 'unconfigured';
    $('#syncGen').hidden = !firstSetup;
    $('#syncPassLabel').textContent = firstSetup ? 'Nueva contraseña del equipo' : 'Contraseña del equipo';
    $('#syncSetupHint').textContent = firstSetup
      ? 'Primera configuración: genera la contraseña del equipo, anótala en un lugar seguro y actívala. Luego se usa la misma en todos los PC.'
      : 'Escribe la contraseña del equipo, la misma de los otros PC (formato XXXXX-XXXXX-XXXXX-XXXXX). Si se pierde, los datos del servidor no se pueden descifrar.';
    $('#syncActive').hidden = !on || !available();
    $('#syncState').textContent = LABELS[st.status];
    const badge = $('#syncBadge');
    badge.hidden = !on || !available();
    badge.className = 'syncBadge ' + st.status;
    badge.textContent = st.status === 'idle' ? 'Sincronizado' : LABELS[st.status];
    badge.title = st.message || (st.config?.lastSync ? 'Última sincronización: ' + fmtDateTime(new Date(st.config.lastSync)) : '');
    if (on) {
      $('#syncInfo').textContent =
        (st.config.lastSync ? `Última sincronización: ${fmtDateTime(new Date(st.config.lastSync))}.` : 'Aún no se ha sincronizado.') +
        (st.message ? ' ' + st.message : '') +
        (st.skewMin ? ` Atención: la hora de este equipo difiere ${Math.abs(st.skewMin)} min de la del servidor; ajústala.` : '');
      $('#syncHash').textContent = st.config.hash;
    }
  }

  return {
    init,
    start,
    render,
    schedule,
    syncNow,
    get enabled() {
      return !!st.config;
    },
    /** ¿Es la contraseña del equipo? (desbloquear si se olvidó el PIN). */
    async verifyTeamPassword(pass) {
      if (!st.config || passphraseProblem(pass)) return false;
      const keys = await deriveTeamKeys(pass);
      return tokenHash(keys.token) === st.config.hash;
    },
    /** Estado para el chequeo antes del operativo. */
    get state() {
      return {
        available: available(),
        configured: !!st.config,
        status: st.status,
        message: st.message,
        lastSync: st.config?.lastSync || null,
        skewMin: st.skewMin || 0,
      };
    },
  };
}
