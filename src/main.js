/**
 * Punto de entrada. Crea el almacenamiento y el contexto, inicializa vistas y
 * enlaza la barra inferior y las pestañas.
 */
import TEMPLATE_PDF_B64 from './specialties/activa/plantilla.js';
import { createStore, memoryStorage, readLegacyData, clearLegacyData } from './storage/store.js';
import { createRepo } from './storage/repo.js';
import { idbBackend, localStorageBackend } from './storage/backends.js';
import { sealedBackend, sealedStorage } from './storage/sealed.js';
import { createPcVault } from './storage/pcVault.js';
import { blankRecord } from './core/record.js';
import { STORAGE_KEYS as K, SEALED_KEYS } from './config/catalogs.js';
import { createContext } from './ui/context.js';
import { $, $$, toast } from './ui/dom.js';
import { initAttentionView, syncAttentionView } from './ui/attentionView.js';
import { initRegistryView } from './ui/registryView.js';
import { initFilter } from './ui/statsView.js';
import { initExportView } from './ui/exportView.js';
import { initSettingsView, renderSettings } from './ui/settingsView.js';
import { createSyncController } from './ui/syncController.js';
import { initSyncView, renderSyncView } from './ui/syncView.js';
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
import { initHeaderFit } from './ui/headerFit.js';
import { initAttachmentsView } from './ui/attachmentsView.js';
import { createAccountsController } from './ui/accounts.js';
import { initUsersView } from './ui/usersView.js';
import { initSettingsSections } from './ui/settingsSections.js';
import { initAuditView } from './ui/auditView.js';
import { applyPermissions, guardActions } from './ui/permissionsView.js';
import { TOPICS } from './ui/events.js';

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
 * El motor elegido queda en `repo.backendName` ('indexeddb' | 'localstorage').
 * Con la llave del PC (ADR 0016) IndexedDB va cifrado; si está cerrada, no se
 * carga nada hasta entrar (`repo.init` lo llama quien la abre).
 * @param {import('./storage/store.js').KeyValueStorage} storage
 * @param {boolean} practice
 * @param {boolean} locked
 */
async function openRepo(storage, practice, locked) {
  /** @param {Error} e */
  const onError = (e) => {
    toast('No se pudo guardar en este equipo: ' + (e?.message || e), 6000);
    logError('almacenamiento', e);
    window.dispatchEvent(new Event('hhr:storage-error'));
  };
  try {
    const sealed = sealedBackend(await idbBackend(dbName(practice)), { locked });
    const repo = createRepo(sealed.backend, { onError });
    if (!locked) {
      const { migrated } = await repo.init(
        practice ? {} : { legacy: readLegacyData(storage), clearLegacy: () => clearLegacyData(storage) },
      );
      if (migrated) toast(`Datos actualizados al nuevo almacenamiento (${migrated} atenciones).`, 4000);
    }
    return { repo, sealed };
  } catch (e) {
    console.warn('IndexedDB no disponible; se usa localStorage:', e);
    const repo = createRepo(
      localStorageBackend(storage, {
        atenciones: K.records,
        eliminadas: K.tombstones,
        bitacora: K.audit,
        pacientes: K.patients,
        adjuntos: K.attachments,
      }),
      {
        onError,
      },
    );
    if (!locked) await repo.init();
    // Sin IndexedDB, las colecciones están en claves de localStorage, que el almacenamiento cifrado ya cubre.
    return { repo, sealed: null };
  }
}

async function main() {
  const base = getStorage();
  const practice = isPractice();
  const { persistent } = base;
  // Modo práctica: almacenamiento propio (los datos reales no se tocan).
  const plain = practice ? prefixedStorage(base.storage) : base.storage;
  // Datos de este PC cifrados con la clave personal (ADR 0016): con llave, todo empieza cerrado hasta entrar.
  const locked = !practice && !!plain.getItem(K.pcKey);
  const sealedLs = sealedStorage(plain, SEALED_KEYS, { locked, onError: (e) => logError('almacenamiento', e) });
  const storage = sealedLs.storage;
  const { repo, sealed } = await openRepo(storage, practice, locked);
  /** Carga lo cifrado al abrir la llave tras entrar (se asigna cuando existe el contexto). */
  let afterUnlock = async () => {};
  const pcVault = createPcVault({
    storage: plain,
    name: K.pcKey,
    targets: sealed ? [sealedLs, sealed] : [sealedLs],
    // La primera vez los datos ya estaban cargados (legibles): solo se cifraron.
    onOpen: ({ first }) => (first ? undefined : afterUnlock()),
  });
  // Otra pestaña creó la llave: esta (sin llave) recarga para no seguir guardando legible.
  window.addEventListener('storage', (e) => {
    if (e.key === K.pcKey && e.newValue && pcVault.state === 'clear') void repo.flush().then(() => location.reload());
  });
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
  ctx.storageKind = repo.backendName;
  // Pide al navegador no borrar los datos si le falta espacio (sin preguntar al usuario).
  if (!practice) void navigator.storage?.persist?.().catch(() => {});
  // Escrituras que fallaron (p. ej. disco lleno un momento): se reintentan cada minuto.
  const saveBar = () => {
    const n = repo.failedCount?.() || 0;
    $('#saveBar').hidden = !n;
    $('#saveText').textContent =
      `${n} ${n === 1 ? 'cambio no se pudo' : 'cambios no se pudieron'} guardar en este equipo (¿almacenamiento lleno?). Se reintenta solo; no cierres la app.`;
  };
  ctx.storageHealth = () => ({ pending: repo.failedCount?.() || 0 });
  setInterval(() => {
    repo.retryFailed?.();
    repo.flush().then(saveBar);
  }, 60_000);
  $('#saveRetry').addEventListener('click', () => repo.flush().then(saveBar));
  // Tras cada escritura que falla (aviso del repositorio), se muestra la barra.
  window.addEventListener('hhr:storage-error', () => setTimeout(saveBar, 0));
  initErrorLog(ctx);
  // Cuentas de usuario (ADR 0014) y bloqueo: antes de mostrar datos.
  afterUnlock = async () => {
    await repo.init();
    ctx.rec = blankRecord(store.loadMedico());
    ctx.snap = null;
    ctx.dirty = false;
    ctx.reload();
    ctx.restoreDraft();
    syncAttentionView(ctx);
    ctx.refreshLists();
  };
  ctx.accounts = createAccountsController(ctx, { vault: pcVault });
  const lock = createLock(ctx);
  ctx.lock = lock;
  ctx.accounts.start(); // con cuentas activadas, muestra el ingreso (o recupera la sesión de la pestaña)
  // Con PIN: abrir una pestaña nueva no bloquea las otras. Con cuentas, el ingreso ya protege.
  if (!ctx.accounts.active) lock.lock({ broadcast: false });
  $('#practiceEnter').addEventListener('click', () => location.assign(practiceUrl(true)));
  $('#appVersion').textContent = 'v' + ctx.version;
  $('#appVersionAj').textContent = ctx.version;

  initAttentionView(ctx);
  initRegistryView(ctx);
  initFilter(ctx);
  initExportView(ctx);
  initSettingsView(ctx);
  initSettingsSections(ctx);
  initCatalogView(ctx);
  initIntakeView(ctx);
  initUserView(ctx);
  initCheckView(ctx);
  initRutMarks();
  initHeaderFit();
  initAttachmentsView(ctx);
  initUsersView(ctx);
  initAuditView(ctx);
  guardActions(ctx);
  ctx.applyPermissions = () => applyPermissions(ctx);
  ctx.on(TOPICS.CUENTA, () => applyPermissions(ctx));
  ctx.seedCatalogs();

  $$('nav button').forEach((b) => b.addEventListener('click', () => ctx.showTab(b.dataset.tab)));
  // Teclado en las pestañas (patrón WAI-ARIA): flechas, Inicio y Fin.
  $('nav').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    const tabs = $$('nav button');
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    /** @type {Record<string, number | undefined>} */
    const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    ctx.showTab(t.dataset.tab);
    t.focus();
  });
  $('#bNew').addEventListener('click', () => ctx.newAttention());
  $('#bSave').addEventListener('click', () => ctx.save());
  $('#bCopy').addEventListener('click', () => ctx.copyNote(ctx.rec));
  $('#bPdf').addEventListener('click', (/** @type {MouseEvent} */ e) =>
    ctx.downloadPdf(ctx.rec, /** @type {HTMLButtonElement} */ (e.currentTarget)),
  );
  $('#brandBtn').addEventListener('click', () => ctx.showTab('t-aj'));
  $('#bForms').addEventListener('click', (/** @type {MouseEvent} */ e) =>
    ctx.openForms(/** @type {HTMLButtonElement} */ (e.currentTarget)),
  );

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

  ctx.sync = createSyncController(ctx, { onChange: () => renderSyncView(ctx), notify: (m, ms) => toast(m, ms) });
  initSyncView(ctx);
  ctx.sync.init();

  ctx.ensurePatients();
  ctx.restoreDraft();
  renderSettings(ctx);
  renderCatalogSettings(ctx);
  syncAttentionView(ctx);
  ctx.refreshLists();
  ctx.showTab('t-at');
  applyPermissions(ctx);
  ctx.sync.start();
  registerServiceWorker();
  if (location.protocol !== 'file:') startUpdateWatcher(ctx);
  // Primero quién registra (si hay perfiles), luego el chequeo si hace días que no se usa.
  ctx.accounts.whenReady(() => lock.whenUnlocked(() => void ctx.askUserAtStart().then(() => autoCheck(ctx))));
  // Termina de escribir lo pendiente al ocultar o cerrar la página.
  window.addEventListener('pagehide', () => {
    ctx.flushAutosave();
    void repo.flush();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && ctx.flushAutosave());
  if (!persistent) toast('Este navegador no permite guardar datos: las atenciones se perderán al cerrar.', 6000);
  // Marca de «app lista» (la usa scripts/perf.mjs para medir el inicio).
  performance.mark('hhr:listo');
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
