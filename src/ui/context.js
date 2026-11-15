/**
 * Controlador de la aplicación: estado en memoria + acciones que usan las vistas.
 *
 * Flujo de datos:
 *   evento de UI -> acción del contexto -> store (localStorage) -> render de vistas
 * Las vistas nunca escriben en localStorage directamente.
 */
import { APP } from '../config/catalogs.js';
import { blankRecord, normalizeRecord, newRecordId, validateRecord, findDuplicate } from '../core/record.js';
import { buildNote } from '../core/note.js';
import { filterRecords, operativosOf } from '../core/stats.js';
import { fmtDate, escapeHtml } from '../core/format.js';
import { createSecret } from '../core/anonymize.js';
import { buildAttentionPdf, pdfFileName } from '../pdf/attentionPdf.js';
import { StorageError } from '../storage/store.js';
import { $, $$, toast, download, copyText, withBusy, base64ToBytes } from './dom.js';
import { syncAttentionView, renderProcList, showValidation, renderToolbar } from './attentionView.js';
import { renderRegistry } from './registryView.js';
import { renderStats, renderFilter, placeFilter } from './statsView.js';
import { renderExportView } from './exportView.js';
import { renderSettings } from './settingsView.js';

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
    /** Hay cambios no guardados. */
    dirty: false,
    records: store.loadRecords(),
    procs: store.loadProcs(),
    settings: store.loadSettings(),
    /** Filtro compartido de Estadística y Exportar. */
    filter: { operativo: '', desde: '', hasta: '' },
    currentTab: 't-at',

    filtered: () => filterRecords(ctx.records, ctx.filter),
    templateBytes: () => (templateCache ||= base64ToBytes(templateB64)),
    pdfOptions: () => ({ flatten: !!ctx.settings.pdfFlatten, footer: !!ctx.settings.pdfFooter }),
    note: (rec) => buildNote(rec, ctx.procs, { pie: ctx.settings.notaPie }),

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
      ctx.dirty = true;
      ctx.persist(() => store.saveDraft(ctx.rec));
      if (silent) {
        showValidation(ctx);
        renderToolbar(ctx);
      } else syncAttentionView(ctx);
    },

    save() {
      const v = validateRecord(ctx.rec);
      if (v.errors.length) {
        showValidation(ctx, { showErrors: true });
        toast(v.errors[0]);
        return false;
      }
      const dup = findDuplicate(ctx.rec, ctx.records);
      if (dup && !confirm(`Ya existe una atención de ${dup.f.paciente_nombre || dup.f.paciente_rut} el ${fmtDate(dup.f.fecha_atencion)}. ¿Guardar otra atención igual?`)) {
        return false;
      }
      const now = Date.now();
      const rec = normalizeRecord(ctx.rec);
      if (!rec.id) {
        rec.id = newRecordId(now);
        rec.created = now;
      }
      rec.updated = now;
      rec.procNames = Object.fromEntries(Object.keys(rec.proc).map((id) => [id, ctx.procs.find((p) => p.id === id)?.n || rec.procNames?.[id] || id]));
      const ok = ctx.persist(() => {
        ctx.records = store.upsertRecord(rec);
        store.saveMedico({ n: rec.f.medico_nombre, r: rec.f.medico_rut, op: rec.f.operativo });
        store.saveDraft(rec);
      });
      if (!ok) return false;
      ctx.rec = rec;
      ctx.dirty = false;
      syncAttentionView(ctx);
      ctx.refreshLists();
      ctx.sync?.schedule();
      toast(v.warnings.length ? `Guardada con ${v.warnings.length} advertencia(s): ${v.warnings[0]}` : 'Atención guardada', v.warnings.length ? 3500 : 2200);
      return true;
    },

    newAttention() {
      if (ctx.dirty && !confirm('Hay cambios sin guardar. ¿Empezar una atención nueva igual?')) return;
      ctx.rec = blankRecord(store.loadMedico());
      ctx.dirty = false;
      ctx.persist(() => store.saveDraft(ctx.rec));
      syncAttentionView(ctx);
      ctx.showTab('t-at');
      scrollTo(0, 0);
    },

    openRecord(id) {
      const r = ctx.records.find((x) => x.id === id);
      if (!r) return;
      if (ctx.dirty && !confirm('Hay cambios sin guardar. ¿Abrir otra atención igual?')) return;
      ctx.loadIntoForm(r);
      ctx.showTab('t-at');
      scrollTo(0, 0);
    },

    /** Carga una atención guardada en el formulario (sin cambios pendientes). */
    loadIntoForm(r) {
      ctx.rec = normalizeRecord(r);
      ctx.dirty = false;
      syncAttentionView(ctx);
    },

    deleteRecord(id) {
      const r = ctx.records.find((x) => x.id === id);
      if (!r || !confirm(`¿Eliminar la atención de ${r.f.paciente_nombre || r.f.paciente_rut} (${fmtDate(r.f.fecha_atencion)})? No se puede deshacer.`)) return;
      const ok = ctx.persist(() => {
        ctx.records = store.deleteRecord(id);
        // La "lápida" permite propagar la eliminación a los otros equipos.
        store.addTombstone(id, Math.max(Date.now(), (r.updated || 0) + 1));
      });
      if (!ok) return;
      ctx.sync?.schedule();
      if (ctx.rec.id === id) {
        ctx.rec.id = null;
        syncAttentionView(ctx);
      }
      ctx.refreshLists();
      toast('Atención eliminada');
    },

    downloadPdf(rec, button) {
      return withBusy(button, async () => {
        const r = await buildAttentionPdf(ctx.templateBytes(), rec, ctx.procs, ctx.pdfOptions());
        download(r.bytes, pdfFileName(rec), 'application/pdf');
        toast(r.overflow.length ? `PDF descargado (con hoja complementaria: ${r.overflow.join(', ')})` : 'PDF descargado', r.overflow.length ? 4000 : 2200);
      });
    },

    async copyNote(rec) {
      const text = ctx.note(rec);
      if (await copyText(text)) toast('Nota para Eloísa copiada');
      else window.prompt('No se pudo copiar automáticamente. Copia el texto (Ctrl/⌘ + C):', text);
    },

    setProcs(procs) {
      if (!ctx.persist(() => store.saveProcs(procs))) return;
      ctx.procs = procs;
      renderProcList(ctx);
      renderSettings(ctx);
      syncAttentionView(ctx);
    },

    /** Clave de seudonimización del equipo (se crea si no existe). */
    ensureSecret() {
      let s = store.loadSecret();
      if (!s) {
        s = createSecret();
        ctx.persist(() => store.saveSecret(s));
      }
      return s;
    },

    onFilterChange() {
      renderFilter(ctx);
      if (ctx.currentTab === 't-est') renderStats(ctx);
      if (ctx.currentTab === 't-exp') renderExportView(ctx);
    },

    /** Re-dibuja listas que dependen de los registros guardados. */
    refreshLists() {
      $('#opsList').innerHTML = operativosOf(ctx.records)
        .map((o) => `<option value="${escapeHtml(o)}">`)
        .join('');
      renderFilter(ctx);
      renderRegistry(ctx);
      if (ctx.currentTab === 't-est') renderStats(ctx);
      if (ctx.currentTab === 't-exp') renderExportView(ctx);
    },

    /** Recarga todo desde el almacenamiento (tras importar o borrar). */
    reload() {
      ctx.records = store.loadRecords();
      ctx.procs = store.loadProcs();
      ctx.settings = store.loadSettings();
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
      });
      $$('.tab').forEach((t) => t.classList.toggle('on', t.id === id));
      if (id === 't-reg') renderRegistry(ctx);
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
        ctx.dirty = !!(d.f.paciente_nombre || d.f.paciente_rut) && !d.id;
      }
    },

    version: APP.version,
    /** Controlador de sincronización (se asigna en main.js). */
    sync: null,
  };
  return ctx;
}
