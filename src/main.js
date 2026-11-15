/**
 * Punto de entrada. Crea el almacenamiento y el contexto, inicializa vistas y
 * enlaza la barra inferior y las pestañas.
 */
import TEMPLATE_PDF_B64 from './specialties/activa/plantilla.js';
import { createStore, memoryStorage, readLegacyData, clearLegacyData } from './storage/store.js';
import { createRepo } from './storage/repo.js';
import { idbBackend, localStorageBackend } from './storage/backends.js';
import { STORAGE_KEYS as K } from './config/catalogs.js';
import { createContext } from './ui/context.js';
import { $, $$, toast } from './ui/dom.js';
import { initAttentionView, syncAttentionView } from './ui/attentionView.js';
import { initRegistryView } from './ui/registryView.js';
import { initFilter } from './ui/statsView.js';
import { initExportView, exportStatsXlsx } from './ui/exportView.js';
import { initSettingsView, renderSettings } from './ui/settingsView.js';
import { createSyncController } from './ui/syncController.js';
import { createClock, setClock } from './core/clock.js';
import { initCatalogView, renderCatalogSettings } from './ui/catalogView.js';
import { initIntakeView } from './ui/intakeView.js';
import { initRutMarks } from './ui/rut.js';
import { initUserView } from './ui/userView.js';
import { isPractice, prefixedStorage, dbName, seedPractice, resetPractice, practiceUrl } from './ui/practice.js';
import { uiConfirm } from './ui/modal.js';
import { initCheckView, autoCheck } from './ui/checkView.js';
import { createLock } from './ui/lock.js';
import { startUpdateWatcher } from './ui/updateNotice.js';
import { initErrorLog, logError } from './ui/errorLog.js';

function getStorage() {
  try {
    const k = '__oft_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return { storage: localStorage, persistent: true };
  } catch {
    return { storage: memoryStorage(), persistent: false };
  }
}

/**
 * Abre el almacenamiento de datos clínicos: IndexedDB (preferido) o, si no
 * está disponible, localStorage. La primera vez migra los datos antiguos.
 */
async function openRepo(storage, practice) {
  const onError = (e) => {
    toast('No se pudo guardar en este equipo: ' + (e?.message || e), 6000);
    logError('almacenamiento', e);
  };
  try {
    const repo = createRepo(await idbBackend(dbName(practice)), { onError });
    repo.kind = 'indexeddb';
    const { migrated } = await repo.init(practice ? {} : { legacy: readLegacyData(storage), clearLegacy: () => clearLegacyData(storage) });
    if (migrated) toast(`Datos actualizados al nuevo almacenamiento (${migrated} atenciones).`, 4000);
    return repo;
  } catch (e) {
    console.warn('IndexedDB no disponible; se usa localStorage:', e);
    const repo = createRepo(
      localStorageBackend(storage, { atenciones: K.records, eliminadas: K.tombstones, bitacora: K.audit, pacientes: K.patients }),
      {
        onError,
      },
    );
    await repo.init();
    repo.kind = 'localstorage';
    return repo;
  }
}

async function main() {
  const base = getStorage();
  const practice = isPractice();
  const { persistent } = base;
  // Modo práctica: almacenamiento propio (los datos reales no se tocan).
  const storage = practice ? prefixedStorage(base.storage) : base.storage;
  const repo = await openRepo(storage, practice);
  const store = createStore(storage, repo);
  if (practice) {
    seedPractice(store);
    document.body.classList.add('practice');
    $('.brand small').textContent = 'Modo práctica';
    $('#practiceBar').hidden = false;
    $('#practiceExit').addEventListener('click', () => location.assign(practiceUrl(false)));
    $('#practiceReset').addEventListener('click', async () => {
      const ok = await uiConfirm({
        title: 'Reiniciar práctica',
        message: 'Se borra lo hecho en el modo práctica y se vuelven a cargar los datos de ejemplo. Los datos reales no cambian.',
        okLabel: 'Reiniciar',
      });
      if (!ok) return;
      await repo.flush();
      await resetPractice();
      location.reload();
    });
  }
  // Reloj lógico persistente: una edición posterior a otra recibida siempre queda con fecha posterior.
  setClock(createClock({ load: () => store.loadClock(), save: (t) => ctx.persist(() => store.saveClock(t)) }));
  const ctx = createContext(store, TEMPLATE_PDF_B64);
  ctx.practice = practice;
  ctx.storageKind = repo.kind;
  initErrorLog(ctx);
  // Bloqueo con PIN: antes de mostrar datos.
  ctx.lock = createLock(ctx);
  ctx.lock.lock({ broadcast: false }); // abrir una pestaña nueva no bloquea las otras
  $('#practiceEnter').addEventListener('click', () => location.assign(practiceUrl(true)));
  $('#appVersion').textContent = 'v' + ctx.version;
  $('#appVersionAj').textContent = ctx.version;

  initAttentionView(ctx);
  initRegistryView(ctx);
  initFilter(ctx);
  initExportView(ctx);
  initSettingsView(ctx);
  initCatalogView(ctx);
  initIntakeView(ctx);
  initUserView(ctx);
  initCheckView(ctx);
  initRutMarks();
  ctx.seedCatalogs();

  $$('nav button').forEach((b) => b.addEventListener('click', () => ctx.showTab(b.dataset.tab)));
  // Teclado en las pestañas (patrón WAI-ARIA): flechas, Inicio y Fin.
  $('nav').addEventListener('keydown', (e) => {
    const tabs = $$('nav button');
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    ctx.showTab(t.dataset.tab);
    t.focus();
  });
  $('#bNew').addEventListener('click', () => ctx.newAttention());
  $('#bSave').addEventListener('click', () => ctx.save());
  $('#bCopy').addEventListener('click', () => ctx.copyNote(ctx.rec));
  $('#bPdf').addEventListener('click', (e) => ctx.downloadPdf(ctx.rec, e.currentTarget));
  $('#stXlsx').addEventListener('click', (e) => exportStatsXlsx(ctx, e.currentTarget));

  // Ctrl/Cmd + S guarda la atención.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (ctx.currentTab === 't-at') ctx.save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (ctx.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  ctx.sync = createSyncController(ctx);
  ctx.sync.init();

  ctx.ensurePatients();
  ctx.restoreDraft();
  renderSettings(ctx);
  renderCatalogSettings(ctx);
  syncAttentionView(ctx);
  ctx.refreshLists();
  ctx.showTab('t-at');
  ctx.sync.start();
  registerServiceWorker();
  if (location.protocol !== 'file:') startUpdateWatcher(ctx);
  ctx.lock.whenUnlocked(() => autoCheck(ctx));
  // Termina de escribir lo pendiente al ocultar o cerrar la página.
  window.addEventListener('pagehide', () => void repo.flush());
  if (!persistent) toast('Este navegador no permite guardar datos: las atenciones se perderán al cerrar.', 6000);
}

/** Permite usar la app sin conexión cuando se abre desde la web (Netlify). */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker no registrado:', e));
}

main().catch((e) => {
  console.error(e);
  logError('inicio', e);
  const banner = document.createElement('div');
  banner.className = 'banner warn';
  banner.style.margin = '16px';
  banner.textContent = 'No se pudo iniciar la aplicación. Recarga la página; si persiste, avisa al equipo de soporte.';
  document.body.prepend(banner);
});
