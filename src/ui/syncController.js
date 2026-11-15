/**
 * Sincronización en la interfaz: activar/desactivar, sincronizar en segundo
 * plano y mostrar el estado.
 *
 * Cuándo sincroniza (si está activa): al abrir la app, 4 s después de
 * guardar o eliminar, cada 2 minutos y al recuperar la conexión.
 */
import { sortRecords } from '../core/record.js';
import { fmtDateTime } from '../core/format.js';
import {
  cryptoAvailable, deriveTeamKeys, tokenHash, importEncKey, generatePassphrase, passphraseProblem, DecryptError,
} from '../sync/crypto.js';
import { createSyncApi, syncOnce, SyncHttpError } from '../sync/client.js';
import { $, toast, copyText } from './dom.js';

const INTERVAL_MS = 2 * 60 * 1000;
const DEBOUNCE_MS = 4000;

/** @param {import('./context.js').AppContext} ctx */
export function createSyncController(ctx) {
  const { store } = ctx;
  const st = {
    config: store.loadSyncConfig(),
    key: null,
    running: false,
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

  /** Aplica cambios que llegaron de otros equipos al estado de la app. */
  function writeLocal(records, tombstones) {
    store.saveRecords(sortRecords(records));
    store.saveTombstones(tombstones);
    ctx.records = store.loadRecords();
    if (ctx.rec.id && !ctx.dirty) {
      const fresh = ctx.records.find((r) => r.id === ctx.rec.id);
      if (fresh && fresh.updated !== ctx.rec.updated) ctx.loadIntoForm(fresh);
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
        api: createSyncApi({ token: st.config.token }),
        key: await getKey(),
        readLocal: () => ({ records: store.loadRecords(), tombstones: store.loadTombstones() }),
        writeLocal,
      });
      st.config = { ...st.config, lastSync: Date.now() };
      store.saveSyncConfig(st.config);
      setStatus('idle');
      const got = res.added + res.updated + res.deleted;
      if (!quiet || got) {
        toast(got ? `Sincronizado: ${res.added} nuevas, ${res.updated} actualizadas, ${res.deleted} eliminadas desde otros equipos` : `Sincronizado (${res.pushed} enviadas)`, got ? 4000 : 2200);
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
      try {
        await createSyncApi({ token: keys.token }).list();
      } catch (e) {
        if (e.status === 401) {
          setStatus('off');
          return alert('Esta contraseña no coincide con la configurada en el servidor. Usa la misma contraseña que en los otros PC.');
        }
        if (e.status !== 503 && e.status !== 0 && e.status !== 404) throw e;
        // 503/404: servidor aún sin configurar; 0: sin conexión. Se activa igual.
      }
      st.config = { encKey: keys.encKey, token: keys.token, hash, activatedAt: Date.now(), lastSync: null };
      st.key = null;
      store.saveSyncConfig(st.config);
      $('#syncPass').value = '';
      start();
    } catch (e) {
      setStatus('error', e.message || String(e));
    }
  }

  function deactivate() {
    if (!confirm('¿Desactivar la sincronización en este PC? Los datos locales se conservan; los cambios dejarán de compartirse.')) return;
    clearInterval(st.interval);
    st.config = null;
    st.key = null;
    store.saveSyncConfig(null);
    setStatus('off');
  }

  function init() {
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
    $('#syncActive').hidden = !on || !available();
    $('#syncState').textContent = LABELS[st.status];
    const badge = $('#syncBadge');
    badge.hidden = !on || !available();
    badge.className = 'syncBadge ' + st.status;
    badge.textContent = st.status === 'idle' ? '● Sincronizado' : '● ' + LABELS[st.status];
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
