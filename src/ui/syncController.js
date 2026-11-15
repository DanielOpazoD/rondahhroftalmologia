/**
 * Sincronización en la interfaz: activar/desactivar, sincronizar en segundo
 * plano y mostrar el estado.
 *
 * Cuándo sincroniza (si está activa): al abrir la app, 4 s después de
 * guardar o eliminar, cada 2 minutos y al recuperar la conexión.
 */
import { sortRecords } from '../core/record.js';
import { makeMedico, makeOperativo, byName } from '../core/catalog.js';
import { syncMerge } from '../core/merge.js';
import { ESPECIALIDAD } from '../config/catalogs.js';
import { fmtDateTime } from '../core/format.js';
import {
  cryptoAvailable, deriveTeamKeys, tokenHash, importEncKey, generatePassphrase, passphraseProblem, DecryptError,
} from '../sync/crypto.js';
import { createSyncApi, syncOnce, SyncHttpError } from '../sync/client.js';
import { $, toast, copyText } from './dom.js';
import { uiAlert, uiConfirm } from './modal.js';

const INTERVAL_MS = 2 * 60 * 1000;
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
  };

  const available = () => cryptoAvailable() && /^https?:$/.test(location.protocol);

  const setStatus = (status, message = '') => {
    st.status = status;
    st.message = message;
    render();
  };

  async function getKey() {
    st.key ||= await importEncKey(st.config.encKey);
    return st.key;
  }

  /** Todo lo que se sincroniza: atenciones, perfiles de médico y operativos. */
  function readLocal() {
    const wrap = (kind) => (x) => ({ id: x.id, updated: x.updated, kind, data: x });
    return {
      items: [
        ...store.loadRecords().filter((r) => r.updated).map(wrap('atencion')),
        ...store.loadMedicos().map(wrap('medico')),
        ...store.loadOperativos().map(wrap('operativo')),
      ],
      tombstones: store.loadTombstones(),
    };
  }

  /** Aplica cambios que llegaron de otros equipos al estado de la app. */
  function writeLocal(items, tombstones) {
    const of = (kind) => items.filter((i) => i.kind === kind).map((i) => ({ ...i.data, id: i.id, updated: i.updated }));
    store.saveRecords(sortRecords(of('atencion')));
    store.saveMedicos(byName(of('medico').map((m) => makeMedico(m)).filter(Boolean)));
    store.saveOperativos(byName(of('operativo').map((o) => makeOperativo(o)).filter(Boolean)));
    store.saveTombstones(tombstones);
    ctx.reloadCatalogs();
    ctx.records = store.loadRecords();
    // Atención abierta en el formulario: incorporar lo que otro equipo grabó en ella
    // (si se está editando, se fusiona campo a campo sin perder lo escrito).
    if (ctx.rec.id) {
      const fresh = ctx.records.find((r) => r.id === ctx.rec.id);
      if (fresh && fresh.updated !== ctx.rec.updated) ctx.absorbRemote(fresh);
      if (!fresh) toast('La atención abierta fue eliminada en otro equipo', 4000);
    }
    ctx.refreshLists();
  }

  async function syncNow({ quiet = true } = {}) {
    if (!st.config || !available()) return;
    if (st.running) {
      st.again = true;
      return;
    }
    st.running = true;
    setStatus('syncing');
    try {
      const res = await syncOnce({
        api: createSyncApi({ token: st.config.token, esp: ESPECIALIDAD.id }),
        key: await getKey(),
        readLocal,
        writeLocal,
        mergeFn: syncMerge,
      });
      st.config = { ...st.config, lastSync: Date.now() };
      store.saveSyncConfig(st.config);
      setStatus('idle');
      const got = res.added + res.updated + res.deleted;
      if (!quiet || got) {
        toast(got ? `Sincronizado: ${got} ${got === 1 ? 'cambio recibido' : 'cambios recibidos'} de otros equipos` : 'Sincronizado', got ? 3500 : 1800);
      }
    } catch (e) {
      if (e instanceof SyncHttpError && e.status === 0) setStatus('offline', 'Sin conexión: se sincronizará al volver internet.');
      else if (e instanceof DecryptError) setStatus('error', 'Hay datos en el servidor que no se pueden descifrar con esta contraseña. Revisa que sea la misma en todos los PC.');
      else setStatus('error', e.message || String(e));
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
            html:
              'Esta no es la contraseña del equipo. El servidor ya tiene una configurada: escribe <b>la misma que usan los otros PC</b>; no generes una nueva.' +
              '<br><br>Si nadie la tiene, hay que reemplazarla en el servidor (ver «Cambiar la contraseña» en la documentación).',
          });
        }
        if (e.status !== 503 && e.status !== 0 && e.status !== 404) throw e;
        // 503/404: servidor aún sin configurar; 0: sin conexión. Se activa igual.
        serverReady = e.status === 0;
      }
      st.config = { encKey: keys.encKey, token: keys.token, hash, activatedAt: Date.now(), lastSync: null };
      st.key = null;
      store.saveSyncConfig(st.config);
      $('#syncPass').value = '';
      start();
      if (!serverReady) {
        $('#syncActive details.setup').open = true;
        uiAlert({
          title: 'Falta configurar el servidor',
          tone: 'warn',
          html:
            'La sincronización quedó activa en este PC, pero el servidor aún no tiene contraseña. ' +
            'Copia el valor de <b>Configuración del servidor</b> y créalo en Netlify como <code>SYNC_TOKEN_SHA256</code>; luego vuelve a publicar el sitio.',
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
    $('#syncCopyHash').addEventListener('click', async () => toast((await copyText(st.config?.hash || '')) ? 'Valor copiado' : 'No se pudo copiar'));
    $('#syncBadge').addEventListener('click', () => ctx.showTab('t-aj'));
    window.addEventListener('online', () => syncNow());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow());
  }

  const LABELS = { off: 'Desactivada', idle: 'Activa', syncing: 'Sincronizando…', offline: 'Sin conexión', error: 'Error' };

  function render() {
    const on = !!st.config;
    $('#syncUnavailable').hidden = available();
    $('#syncSetup').hidden = on || !available();
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
        (st.message ? ' ' + st.message : '');
      $('#syncHash').textContent = st.config.hash;
    }
  }

  return { init, start, render, schedule, syncNow, get enabled() { return !!st.config; } };
}
