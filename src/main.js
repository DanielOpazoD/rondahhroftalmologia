/**
 * Punto de entrada. Crea el almacenamiento y el contexto, inicializa vistas y
 * enlaza la barra inferior y las pestañas.
 */
import TEMPLATE_PDF_B64 from '../assets/plantilla_hoja_atencion.pdf';
import { createStore, memoryStorage } from './storage/store.js';
import { createContext } from './ui/context.js';
import { $, $$, toast } from './ui/dom.js';
import { initAttentionView, syncAttentionView } from './ui/attentionView.js';
import { initRegistryView } from './ui/registryView.js';
import { initFilter } from './ui/statsView.js';
import { initExportView, exportStatsXlsx } from './ui/exportView.js';
import { initSettingsView, renderSettings } from './ui/settingsView.js';
import { createSyncController } from './ui/syncController.js';

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

function main() {
  const { storage, persistent } = getStorage();
  const ctx = createContext(createStore(storage), TEMPLATE_PDF_B64);
  $('#appVersion').textContent = 'v' + ctx.version;

  initAttentionView(ctx);
  initRegistryView(ctx);
  initFilter(ctx);
  initExportView(ctx);
  initSettingsView(ctx);

  $$('nav button').forEach((b) => b.addEventListener('click', () => ctx.showTab(b.dataset.tab)));
  $('#bNew').addEventListener('click', () => ctx.newAttention());
  $('#bSave').addEventListener('click', () => ctx.save());
  $('#bCopy').addEventListener('click', () => ctx.copyNote(ctx.rec));
  $('#copyNote2').addEventListener('click', () => ctx.copyNote(ctx.rec));
  $('#bPdf').addEventListener('click', (e) => ctx.downloadPdf(ctx.rec, e.currentTarget));
  $('#stXlsx').addEventListener('click', (e) => exportStatsXlsx(ctx, e.currentTarget));
  $('#printSt').addEventListener('click', () => {
    $('#t-est').classList.add('printme');
    window.print();
    setTimeout(() => $('#t-est').classList.remove('printme'), 500);
  });

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

  ctx.restoreDraft();
  renderSettings(ctx);
  syncAttentionView(ctx);
  ctx.refreshLists();
  ctx.showTab('t-at');
  ctx.sync.start();
  registerServiceWorker();
  if (!persistent) toast('Este navegador no permite guardar datos: las atenciones se perderán al cerrar.', 6000);
}

/** Permite usar la app sin conexión cuando se abre desde la web (Netlify). */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker no registrado:', e));
}

main();
