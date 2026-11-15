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
import { $$, toast, base64ToBytes } from './dom.js';
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

/**
 * @typedef {ReturnType<typeof createContext>} AppContext
 */

/**
 * @param {ReturnType<import('../storage/store.js').createStore>} store
 * @param {string} templateB64 plantilla PDF en base64
 */
export function createContext(store, templateB64) {
  let templateCache = null;

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
    /** Modo práctica (datos de ejemplo, sin sincronización; ver practice.js). */
    practice: false,
    /** Dónde se guardan los datos clínicos: 'indexeddb' o 'localstorage' (lo asigna main.js). */
    storageKind: 'indexeddb',
    /** Bloqueo con PIN (lo asigna lock.js). */
    lock: /** @type {{lock: (o?: {broadcast?: boolean}) => void, whenUnlocked: (fn: () => void) => void, state: {enabled: boolean, minutes: number, locked: boolean}} | null} */ (
      null
    ),
    /** Perfil que registra en esta sesión (ver userView.js); null si no se eligió. */
    userId: /** @type {string | null} */ (null),
    /** Ya se preguntó quién registra en esta sesión. */
    userAsked: false,
    /** Pregunta quién registra si hace falta (lo asigna userView.js). */
    ensureUser: /** @type {() => Promise<void>} */ (async () => {}),
    currentUser: () => (ctx.userId && ctx.medicos.find((m) => m.id === ctx.userId)) || null,
    /** Quién y desde dónde, para la bitácora. */
    author: () => {
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
        if (e instanceof StorageError) toast(e.message, 4000);
        else throw e;
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
      if (silent) {
        showValidation(ctx);
        renderToolbar(ctx);
      } else syncAttentionView(ctx);
    },

    onFilterChange() {
      renderFilter(ctx);
      if (ctx.currentTab === 't-est') renderStats(ctx);
      if (ctx.currentTab === 't-exp') renderExportView(ctx);
    },

    /** Re-dibuja listas que dependen de los registros guardados. */
    refreshLists() {
      renderFilter(ctx);
      renderRegistry(ctx);
      renderIntake(ctx);
      if (ctx.currentTab === 't-est') renderStats(ctx);
      if (ctx.currentTab === 't-exp') renderExportView(ctx);
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
      ctx.refreshLists();
    },

    showTab(id) {
      ctx.currentTab = id;
      $$('nav button').forEach((b) => {
        b.classList.toggle('on', b.dataset.tab === id);
        b.setAttribute('aria-selected', String(b.dataset.tab === id));
        // Patrón de pestañas: solo la activa entra en el orden de Tab; las flechas cambian de pestaña.
        b.tabIndex = b.dataset.tab === id ? 0 : -1;
      });
      $$('.tab').forEach((t) => t.classList.toggle('on', t.id === id));
      if (id === 't-reg') renderRegistry(ctx);
      if (id === 't-ing') renderIntake(ctx);
      if (id === 't-est' || id === 't-exp') {
        placeFilter(id);
        renderFilter(ctx);
      }
      if (id === 't-est') renderStats(ctx);
      if (id === 't-exp') renderExportView(ctx);
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
  Object.assign(ctx, attentionActions(ctx, store), patientActions(ctx, store), catalogActions(ctx, store), outputActions(ctx, store));
  ctx.snap = structuredClone(ctx.rec);
  return /** @type {typeof ctx & ReturnType<typeof attentionActions> & ReturnType<typeof patientActions> & ReturnType<typeof catalogActions> & ReturnType<typeof outputActions>} */ (
    ctx
  );
}
