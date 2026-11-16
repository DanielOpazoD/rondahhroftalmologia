/**
 * Controlador de la aplicación: estado en memoria + acciones que usan las vistas.
 * Las acciones están en ui/actions/ (atención, pacientes, catálogos, salidas);
 * aquí queda el estado y lo transversal (persistir, re-dibujar, pestañas).
 *
 * Flujo de datos:
 *   evento de UI -> acción del contexto -> store (localStorage) -> render de vistas
 * Las vistas nunca escriben en localStorage directamente.
 */
import { APP, ESPECIALIDAD } from '../config/catalogs.js';
import { blankRecord, normalizeRecord } from '../core/record.js';
import { buildNote, filterRecords } from '../specialties/activa/index.js';
import { StorageError } from '../storage/store.js';
import { stampChanges } from '../core/merge.js';
import { clock } from '../core/clock.js';
import { $, $$, toast, base64ToBytes } from './dom.js';
import { logError } from './errorLog.js';
import { createBus, TOPICS } from './events.js';
import { syncAttentionView, renderProcList, showValidation, renderToolbar } from './attentionView.js';
import { renderRegistry } from './registryView.js';
import { renderStats, renderFilter, placeFilter } from './statsView.js';
import { renderExportView } from './exportView.js';
import { renderSettings } from './settingsView.js';
import { renderIntake } from './intakeView.js';
import { renderCatalogSettings } from './catalogView.js';
import { attentionActions } from './actions/attention.js';
import { patientActions } from './actions/patients.js';
import { catalogActions } from './actions/catalogs.js';
import { outputActions } from './actions/outputs.js';
import { attachmentActions } from './actions/attachments.js';
import { formActions } from './actions/forms.js';

/** Pausa al escribir tras la que se guarda solo (ms). */
export const AUTOSAVE_MS = 1200;

/**
 * @typedef {ReturnType<typeof createContext>} AppContext
 */

/**
 * @param {ReturnType<import('../storage/store.js').createStore>} store
 * @param {string} templateB64 plantilla PDF en base64
 */
export function createContext(store, templateB64) {
  let templateCache = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let autosaveTimer;
  const bus = createBus();

  /** Dibuja el contenido de una pestaña que depende de los datos. @param {string} id */
  function renderTab(id) {
    if (id === 't-reg') renderRegistry(ctx);
    else if (id === 't-ing') renderIntake(ctx);
    else if (id === 't-est') {
      renderStats(ctx);
      renderExportView(ctx);
    }
  }

  const ctx = {
    store,
    /** Atención en edición. */
    rec: blankRecord(store.loadMedico()),
    /** Copia de `rec` tras la última edición: sirve para saber qué campos cambian (sellos por campo). */
    snap: null,
    /** Hay cambios no guardados. */
    dirty: false,
    records: store.loadRecords(),
    procs: store.loadProcs(),
    /** Catálogos compartidos (perfiles de médico y operativos). */
    medicos: store.loadMedicos(),
    operativos: store.loadOperativos(),
    settings: store.loadSettings(),
    /** Filtro compartido de Estadística y Exportar. */
    filter: { operativo: '', desde: '', hasta: '' },
    currentTab: 't-at',

    filtered: () => filterRecords(ctx.records, ctx.filter),
    templateBytes: () => (templateCache ||= base64ToBytes(templateB64)),
    pdfOptions: () => ({ flatten: !!ctx.settings.pdfFlatten, footer: !!ctx.settings.pdfFooter }),
    note: (rec) => buildNote(rec, ctx.procs, { pie: ctx.settings.notaPie }),
    /** Muestra el aviso de versión nueva (lo asigna updateNotice.js). */
    showUpdate: /** @type {(version?: string) => void} */ (() => {}),
    /** Modo práctica (datos de ejemplo, sin sincronización; ver practice.js). */
    practice: false,
    /** Dónde se guardan los datos clínicos: 'indexeddb' o 'localstorage' (lo asigna main.js). */
    storageKind: 'indexeddb',
    /** Escrituras pendientes por fallos (lo asigna main.js). */
    storageHealth: () => ({ pending: 0 }),
    /** Lleva a un elemento de Ajustes, abriendo su sección (lo asigna settingsSections.js). @type {(selector: string) => HTMLElement | null} */
    showSettings: (/** @type {string} */ _selector) => /** @type {HTMLElement | null} */ (null),
    /** Cuentas con nombre (lo asigna usersView.js; solo administradores). @type {() => Promise<any[]>} */
    loadAccountUsers: async () => [],
    /** Aplica los permisos de la sesión a la interfaz (lo asigna main.js; ver permissionsView.js). */
    applyPermissions: /** @type {() => void} */ (() => {}),
    /** Bloqueo con PIN (lo asigna lock.js). */
    lock: /** @type {{lock: (o?: {broadcast?: boolean}) => void, whenUnlocked: (fn: () => void) => void, state: {enabled: boolean, minutes: number, locked: boolean}} | null} */ (
      null
    ),
    /** Ficha abierta en la pestaña Pacientes (null: la lista). @type {string | null} */
    openPatientId: null,
    /** Sexo elegido en el formulario de Ingreso. */
    intakeSexo: '',

    /* ---------------------------------------------------------------
     * SERVICIOS: se declaran aquí y los asigna main.js al arrancar (en este
     * orden): cuentas → bloqueo → vistas → sincronización. Ninguna vista
     * agrega propiedades nuevas al contexto: si hace falta una, se declara aquí.
     * --------------------------------------------------------------- */
    /** Cuentas de usuario (lo asigna main.js; ver accounts.js y ADR 0014). @type {ReturnType<typeof import('./accounts.js').createAccountsController> | null} */
    accounts: null,
    /** Perfil que registra en esta sesión (ver userView.js); null si no se eligió. */
    userId: /** @type {string | null} */ (null),
    /** Ya se preguntó quién registra en esta sesión. */
    userAsked: false,
    /** Pregunta quién registra si hace falta (lo asigna userView.js). */
    ensureUser: /** @type {() => Promise<void>} */ (async () => {}),
    askUserAtStart: /** @type {() => Promise<void>} */ (async () => {}),
    currentUser: () => (ctx.userId && ctx.medicos.find((m) => m.id === ctx.userId)) || null,
    /** Quién y desde dónde, para la bitácora. */
    author: () => {
      // Con cuentas de usuario, el autor es la persona que entró (identidad verificada).
      const acc = ctx.accounts?.user;
      if (acc) return { equipo: ctx.deviceName(), equipoId: store.loadDeviceId(), autor: acc.nombre, autorId: acc.id };
      const u = ctx.currentUser();
      return {
        equipo: ctx.deviceName(),
        equipoId: store.loadDeviceId(),
        ...(u ? { autor: u.nombre, autorId: u.id } : {}),
      };
    },
    /** Nombre de este equipo en la bitácora. */
    deviceName: () => ctx.settings.deviceName?.trim() || 'Equipo ' + store.loadDeviceId().slice(-4).toUpperCase(),

    /** Guarda en localStorage informando al usuario si falla. Devuelve true si funcionó. */
    persist(fn) {
      try {
        fn();
        return true;
      } catch (e) {
        if (!(e instanceof StorageError)) throw e;
        toast(e.message, 4000);
        logError('almacenamiento', e);
        return false;
      }
    },

    /** Llamar tras modificar `ctx.rec`. `silent`: no re-dibujar el formulario (escritura en curso). */
    changed({ silent = false } = {}) {
      // Marca con la hora actual los campos que acaban de cambiar (fusión entre equipos).
      stampChanges(ctx.rec, ctx.snap || {}, clock.tick());
      ctx.snap = structuredClone(ctx.rec);
      ctx.dirty = true;
      ctx.persist(() => store.saveDraft(ctx.rec));
      ctx.scheduleAutosave();
      if (silent) {
        showValidation(ctx);
        renderToolbar(ctx);
      } else syncAttentionView(ctx);
    },

    onFilterChange() {
      renderFilter(ctx);
      if (ctx.currentTab === 't-est') renderTab('t-est');
    },

    /**
     * Guardado automático: cada cambio se guarda solo tras una pausa de
     * AUTOSAVE_MS al escribir (si la atención ya se puede guardar).
     */
    scheduleAutosave() {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        if (ctx.dirty) void ctx.save({ auto: true });
      }, AUTOSAVE_MS);
    },
    /** Guarda ya lo pendiente (al ocultar o cerrar la página). */
    flushAutosave() {
      clearTimeout(autosaveTimer);
      if (ctx.dirty) void ctx.save({ auto: true });
    },

    /** Anuncia un cambio (ver ui/events.js): las vistas suscritas se re-dibujan una vez. */
    emit: (topic) => bus.emit(topic),
    on: (topic, fn) => bus.on(topic, fn),

    /**
     * Re-dibuja lo que depende de los registros guardados. Solo la pestaña
     * visible: las demás se dibujan al abrirlas (showTab), así un cambio que
     * llega por sincronización no re-dibuja listas ocultas.
     */
    refreshLists() {
      renderFilter(ctx);
      renderTab(ctx.currentTab);
    },

    /** Recarga todo desde el almacenamiento (tras importar o borrar). */
    reload() {
      ctx.records = store.loadRecords();
      ctx.procs = store.loadProcs();
      ctx.settings = store.loadSettings();
      ctx.medicos = store.loadMedicos();
      ctx.operativos = store.loadOperativos();
      ctx.seedCatalogs();
      ctx.ensurePatients(); // respaldos anteriores a la 2.9.0 no traen fichas
      renderCatalogSettings(ctx);
      renderProcList(ctx);
      renderSettings(ctx);
      syncAttentionView(ctx);
      ctx.emit(TOPICS.DATOS);
    },

    showTab(id) {
      ctx.currentTab = id;
      // Ajustes no es una pestaña: se abre con el logo, que queda marcado.
      $('#brandBtn').classList.toggle('on', id === 't-aj');
      $('#brandBtn').setAttribute('aria-current', id === 't-aj' ? 'page' : 'false');
      $$('nav button').forEach((b) => {
        b.classList.toggle('on', b.dataset.tab === id);
        b.setAttribute('aria-selected', String(b.dataset.tab === id));
        // Patrón de pestañas: solo la activa entra en el orden de Tab; las flechas cambian de pestaña.
        b.tabIndex = b.dataset.tab === id ? 0 : -1;
      });
      $$('.tab').forEach((t) => t.classList.toggle('on', t.id === id));
      ctx.emit('tab:' + id);
      if (id === 't-est') {
        placeFilter(id);
        renderFilter(ctx);
      }
      renderTab(id);
    },

    /** Restaura el borrador que quedó al cerrar la página. */
    restoreDraft() {
      const d = store.loadDraft();
      if (d && d.f) {
        ctx.rec = normalizeRecord({ ...blankRecord(store.loadMedico()), ...d });
        ctx.snap = structuredClone(ctx.rec);
        ctx.dirty = !!(d.f.paciente_nombre || d.f.paciente_rut) && !d.id;
      }
    },

    version: APP.version,
    especialidadNombre: ESPECIALIDAD.nombre,
    /** Controlador de sincronización (se asigna en main.js). */
    sync: null,
  };
  Object.assign(
    ctx,
    attentionActions(ctx, store),
    patientActions(ctx, store),
    catalogActions(ctx, store),
    outputActions(ctx, store),
    attachmentActions(ctx, store),
    formActions(ctx, store),
  );
  // Las listas se re-dibujan cuando cambian los datos (agrupado por el bus).
  bus.on(TOPICS.DATOS, () => ctx.refreshLists());
  ctx.snap = structuredClone(ctx.rec);
  return /** @type {typeof ctx & ReturnType<typeof attentionActions> & ReturnType<typeof patientActions> & ReturnType<typeof catalogActions> & ReturnType<typeof outputActions> & ReturnType<typeof formActions>} */ (
    ctx
  );
}
