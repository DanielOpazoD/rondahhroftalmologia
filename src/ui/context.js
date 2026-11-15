/**
 * Controlador de la aplicación: estado en memoria + acciones que usan las vistas.
 *
 * Flujo de datos:
 *   evento de UI -> acción del contexto -> store (localStorage) -> render de vistas
 * Las vistas nunca escriben en localStorage directamente.
 */
import { APP, ESPECIALIDAD } from '../config/catalogs.js';
import { blankRecord, normalizeRecord, newRecordId, validateRecord, findDuplicate, applyBirthDate } from '../core/record.js';
import { buildNote, filterRecords, buildAttentionPdf, pdfFileName } from '../specialties/activa/index.js';
import { fmtDate } from '../core/format.js';
import { createSecret } from '../core/pseudonym.js';
import { StorageError } from '../storage/store.js';
import { $$, toast, download, copyText, withBusy, base64ToBytes } from './dom.js';
import { syncAttentionView, renderProcList, showValidation, renderToolbar } from './attentionView.js';
import { renderRegistry } from './registryView.js';
import { renderStats, renderFilter, placeFilter } from './statsView.js';
import { renderExportView } from './exportView.js';
import { renderSettings } from './settingsView.js';
import { uiConfirm, uiCopy, uiChoose } from './modal.js';
import { stampChanges, mergeRecords, sameContent } from '../core/merge.js';
import { patientIdFor, patientFields, missingPatients, isAttended, PATIENT_FIELDS } from '../core/patient.js';
import { renderIntake } from './intakeView.js';
import { clock } from '../core/clock.js';
import { makeAuditEntry } from '../core/audit.js';
import { renderCatalogSelects, renderCatalogSettings } from './catalogView.js';
import { seedCatalogs, upsert, byName } from '../core/catalog.js';

/**
 * @typedef {ReturnType<typeof createContext>} AppContext
 */

/** Pregunta antes de descartar cambios sin guardar. */
const confirmDiscard = (what) =>
  uiConfirm({
    title: 'Cambios sin guardar',
    message: `La atención actual tiene cambios sin guardar. ¿Descartarlos y ${what}?`,
    tone: 'warn',
    okLabel: 'Descartar',
  });

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

    async save() {
      const v = validateRecord(ctx.rec);
      if (v.errors.length) {
        showValidation(ctx, { showErrors: true });
        toast(v.errors[0]);
        return false;
      }
      // Atención NUEVA de un paciente que ya tiene una ese día (p. ej. creada en otro equipo).
      const dup = !ctx.rec.id && findDuplicate(ctx.rec, ctx.records);
      if (dup) {
        const name = dup.f.paciente_nombre || dup.f.paciente_rut;
        const choice = await uiChoose({
          title: 'Este paciente ya tiene una atención ese día',
          message: `${name} ya tiene una atención el ${fmtDate(dup.f.fecha_atencion)}, quizás registrada en otro equipo. Combinar junta los datos de ambas en una sola atención, sin perder lo que cada una tiene.`,
          tone: 'warn',
          okLabel: 'Combinar',
          altLabel: 'Guardar aparte',
        });
        if (!choice) return false;
        if (choice === 'ok') ctx.joinExisting(dup.id, { silent: true });
      }
      const now = clock.tick();
      let rec = normalizeRecord(ctx.rec);
      if (!rec.id) {
        rec.id = newRecordId(now);
        rec.created = now;
      }
      // Si otro equipo cambió esta atención mientras se editaba, se fusiona campo a campo.
      const stored = ctx.records.find((r) => r.id === rec.id);
      if (stored) rec = normalizeRecord(mergeRecords(stored, rec));
      // Vínculo con la ficha del paciente (unidad que agrupa sus atenciones).
      rec.pacienteId ||= patientIdFor(rec.f) || undefined;
      rec.updated = Math.max(now, (stored?.updated || 0) + 1);
      rec.procNames = Object.fromEntries(
        Object.keys(rec.proc).map((id) => [id, ctx.procs.find((p) => p.id === id)?.n || rec.procNames?.[id] || id]),
      );
      const ok = ctx.persist(() => {
        ctx.records = store.upsertRecord(rec);
        ctx.syncPatientFromRecord(rec);
        // Bitácora: qué cambió, cuándo y desde qué equipo.
        const entry = makeAuditEntry({
          tipo: stored ? 'editada' : 'creada',
          before: stored,
          after: rec,
          at: rec.updated,
          equipo: ctx.deviceName(),
          equipoId: store.loadDeviceId(),
        });
        if (entry) store.addAuditEntry(rec.id, entry);
        store.saveMedico({ n: rec.f.medico_nombre, r: rec.f.medico_rut, op: rec.f.operativo });
        store.saveDraft(rec);
      });
      if (!ok) return false;
      ctx.rec = rec;
      ctx.snap = structuredClone(rec);
      ctx.dirty = false;
      syncAttentionView(ctx);
      ctx.refreshLists();
      ctx.sync?.schedule();
      toast(
        v.warnings.length ? `Guardada con ${v.warnings.length} advertencia(s): ${v.warnings[0]}` : 'Atención guardada',
        v.warnings.length ? 3500 : 2200,
      );
      return true;
    },

    async newAttention() {
      if (ctx.dirty && !(await confirmDiscard('empezar una atención nueva'))) return;
      ctx.rec = blankRecord(store.loadMedico());
      ctx.snap = structuredClone(ctx.rec);
      ctx.dirty = false;
      ctx.persist(() => store.saveDraft(ctx.rec));
      syncAttentionView(ctx);
      ctx.showTab('t-at');
      scrollTo(0, 0);
    },

    async openRecord(id) {
      const r = ctx.records.find((x) => x.id === id);
      if (!r) return;
      if (ctx.dirty && ctx.rec.id !== id && !(await confirmDiscard('abrir otra atención'))) return;
      ctx.loadIntoForm(r);
      // Paciente preingresado sin médico: se propone el médico habitual de este equipo.
      const remembered = store.loadMedico();
      if (!isAttended(ctx.rec) && !ctx.rec.f.medico_nombre && remembered.n) {
        ctx.rec.f.medico_nombre = remembered.n;
        ctx.rec.f.medico_rut = remembered.r || '';
        ctx.changed();
      }
      ctx.showTab('t-at');
      scrollTo(0, 0);
    },

    /**
     * Preingreso: registra (o actualiza) al paciente y lo agrega a la lista de
     * atención de una fecha, sin datos clínicos. Si ya está en la lista de esa
     * fecha, no se duplica.
     * @param {Record<string, string>} data campos paciente_*
     * @param {{fecha: string, operativo?: string}} where
     * @returns {{ok: boolean, id?: string}}
     */
    admitPatient(data, { fecha, operativo = '' }) {
      const f = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ''));
      if (!f.paciente_nombre && !f.paciente_rut) {
        toast('Escribe al menos el nombre o el RUT');
        return { ok: false };
      }
      const pacienteId = patientIdFor(f);
      const existing = ctx.records.find((r) => r.pacienteId === pacienteId && r.f.fecha_atencion === fecha);
      if (existing) {
        toast(`${existing.f.paciente_nombre || existing.f.paciente_rut} ya está en la lista de ese día`, 3500);
        return { ok: true, id: existing.id };
      }
      const now = clock.tick();
      const master = store.getPatient(pacienteId);
      const rec = blankRecord({ op: operativo });
      rec.f.fecha_atencion = fecha;
      Object.assign(rec.f, patientFields(master?.f), f);
      applyBirthDate(rec);
      Object.assign(rec, { id: newRecordId(now), created: now, updated: now, pacienteId });
      stampChanges(rec, { f: {} }, now);
      const saved = normalizeRecord(rec);
      const ok = ctx.persist(() => {
        ctx.records = store.upsertRecord(saved);
        ctx.syncPatientFromRecord(saved);
        const entry = makeAuditEntry({
          tipo: 'ingresada',
          after: saved,
          at: now,
          equipo: ctx.deviceName(),
          equipoId: store.loadDeviceId(),
        });
        if (entry) store.addAuditEntry(saved.id, entry);
      });
      if (!ok) return { ok: false };
      ctx.refreshLists();
      ctx.sync?.schedule();
      toast(`${saved.f.paciente_nombre || saved.f.paciente_rut} agregado a la lista`);
      return { ok: true, id: saved.id };
    },

    /** Nueva atención (otro día u otra consulta) para un paciente ya registrado. */
    async newAttentionFor(pacienteId) {
      const p = store.getPatient(pacienteId);
      if (!p) return;
      if (ctx.dirty && !(await confirmDiscard('empezar una atención nueva'))) return;
      ctx.rec = blankRecord(store.loadMedico());
      Object.assign(ctx.rec.f, patientFields(p.f));
      ctx.rec.pacienteId = pacienteId;
      applyBirthDate(ctx.rec);
      ctx.snap = structuredClone(ctx.rec);
      ctx.dirty = true;
      ctx.persist(() => store.saveDraft(ctx.rec));
      syncAttentionView(ctx);
      ctx.showTab('t-at');
      scrollTo(0, 0);
    },

    /**
     * Si la atención nueva corresponde a un paciente ya registrado, completa
     * sus datos vacíos desde la ficha (sin sobrescribir lo escrito).
     */
    fillFromPatient() {
      if (ctx.rec.id) return false;
      const id = ctx.rec.pacienteId || patientIdFor(ctx.rec.f);
      const p = id && store.getPatient(id);
      if (!p) return false;
      let changed = false;
      for (const [k, v] of Object.entries(patientFields(p.f))) {
        if (!ctx.rec.f[k]) {
          ctx.rec.f[k] = v;
          changed = true;
        }
      }
      ctx.rec.pacienteId = id;
      if (changed) {
        applyBirthDate(ctx.rec);
        ctx.changed();
      }
      return changed;
    },

    /**
     * Continúa en la atención existente `id` del mismo paciente, llevándose lo
     * escrito en la atención actual (fusión campo a campo; queda sin guardar).
     */
    joinExisting(id, { silent = false } = {}) {
      const existing = ctx.records.find((r) => r.id === id);
      if (!existing) return;
      ctx.rec = normalizeRecord(mergeRecords(existing, { ...ctx.rec, id: existing.id, created: existing.created }));
      ctx.snap = structuredClone(ctx.rec);
      ctx.dirty = true;
      ctx.persist(() => store.saveDraft(ctx.rec));
      if (!silent) {
        syncAttentionView(ctx);
        toast('Datos combinados con la atención existente. Revisa y guarda.', 3500);
      }
    },

    /**
     * Llegaron cambios de otro equipo para la atención abierta: se incorporan
     * sin perder lo que se está escribiendo (lo local editado después gana).
     */
    absorbRemote(fresh) {
      if (!ctx.dirty) return ctx.loadIntoForm(fresh);
      ctx.rec = normalizeRecord(mergeRecords(fresh, ctx.rec));
      ctx.snap = structuredClone(ctx.rec);
      ctx.persist(() => store.saveDraft(ctx.rec));
      syncAttentionView(ctx);
      toast('Se agregaron datos registrados en otro equipo', 3000);
    },

    /** Carga una atención guardada en el formulario (sin cambios pendientes). */
    loadIntoForm(r) {
      ctx.rec = normalizeRecord(r);
      ctx.snap = structuredClone(ctx.rec);
      ctx.dirty = false;
      syncAttentionView(ctx);
    },

    async deleteRecord(id) {
      const r = ctx.records.find((x) => x.id === id);
      if (!r) return;
      const ok = await uiConfirm({
        title: 'Eliminar atención',
        message: `Se eliminará la atención de ${r.f.paciente_nombre || r.f.paciente_rut} (${fmtDate(r.f.fecha_atencion)})${ctx.sync?.enabled ? ' en todos los equipos' : ''}. No se puede deshacer.`,
        tone: 'danger',
        okLabel: 'Eliminar',
      });
      if (!ok) return;
      const done = ctx.persist(() => {
        ctx.records = store.deleteRecord(id);
        const at = clock.tick();
        store.addAuditEntry(id, makeAuditEntry({ tipo: 'eliminada', at, equipo: ctx.deviceName(), equipoId: store.loadDeviceId() }));
        // La "lápida" permite propagar la eliminación a los otros equipos.
        store.addTombstone(id, Math.max(clock.tick(), (r.updated || 0) + 1));
      });
      if (!done) return;
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
        toast(
          r.overflow.length ? `PDF descargado (con hoja complementaria: ${r.overflow.join(', ')})` : 'PDF descargado',
          r.overflow.length ? 4000 : 2200,
        );
      });
    },

    async copyNote(rec) {
      const text = ctx.note(rec);
      if (await copyText(text)) toast('Nota para Eloísa copiada');
      else {
        uiCopy({
          title: 'Copiar nota',
          message: 'El navegador no permitió copiar automáticamente. El texto ya está seleccionado: cópialo con Ctrl/⌘ + C.',
          copyText: text,
        });
      }
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
      renderFilter(ctx);
      renderRegistry(ctx);
      renderIntake(ctx);
      if (ctx.currentTab === 't-est') renderStats(ctx);
      if (ctx.currentTab === 't-exp') renderExportView(ctx);
    },

    /**
     * Actualiza la ficha del paciente con los datos de la atención. Se fusiona
     * campo a campo con la ficha existente (gana lo editado más recientemente),
     * así un cambio de teléfono hecho en el ingreso y otro dato corregido por
     * el médico se conservan ambos.
     */
    syncPatientFromRecord(rec) {
      if (!rec.pacienteId) return;
      const fields = patientFields(rec.f);
      const ft = {};
      for (const k of PATIENT_FIELDS) {
        const t = rec.ft?.['f.' + k] ?? (fields[k] ? rec.updated : undefined);
        if (t) ft['f.' + k] = t;
      }
      const candidate = {
        id: rec.pacienteId,
        created: rec.created || rec.updated,
        updated: rec.updated,
        f: fields,
        ft,
        checks: {},
        proc: {},
      };
      const current = store.getPatient(rec.pacienteId);
      const next = current ? mergeRecords(current, candidate) : candidate;
      if (current && sameContent(next, current)) return;
      next.updated = Math.max(current?.updated || 0, rec.updated || 0, clock.tick());
      store.upsertPatient(next);
    },

    /** Crea las fichas que falten (atenciones de versiones anteriores o recibidas antes que su ficha). */
    ensurePatients() {
      const existing = new Map(store.loadPatients().map((p) => [p.id, p]));
      const missing = missingPatients(ctx.records, existing);
      if (missing.length) store.savePatients(missing);
      return missing.length;
    },

    /** Completa los catálogos con médicos y operativos de atenciones antiguas (una vez por equipo). */
    seedCatalogs() {
      const r = seedCatalogs({ records: ctx.records, recordado: store.loadMedico(), medicos: ctx.medicos, operativos: ctx.operativos });
      if (!r.added) return;
      ctx.persist(() => {
        store.saveMedicos(r.medicos);
        store.saveOperativos(r.operativos);
      });
      ctx.medicos = r.medicos;
      ctx.operativos = r.operativos;
    },

    reloadCatalogs() {
      ctx.medicos = store.loadMedicos();
      ctx.operativos = store.loadOperativos();
      renderCatalogSelects(ctx);
      renderCatalogSettings(ctx);
    },

    /** Crea o actualiza un médico u operativo y lo comparte. Devuelve el elemento guardado. */
    saveCatalog(kind, item) {
      const key = kind === 'medico' ? 'medicos' : 'operativos';
      const list = byName(upsert(ctx[key], item));
      const ok = ctx.persist(() => {
        if (kind === 'medico') store.saveMedicos(list);
        else store.saveOperativos(list);
        const t = store.loadTombstones();
        if (t[item.id]) {
          delete t[item.id];
          store.saveTombstones(t);
        }
      });
      if (!ok) return undefined;
      ctx.reloadCatalogs();
      ctx.sync?.schedule();
      return item;
    },

    deleteCatalog(kind, id) {
      const key = kind === 'medico' ? 'medicos' : 'operativos';
      const item = ctx[key].find((x) => x.id === id);
      const list = ctx[key].filter((x) => x.id !== id);
      ctx.persist(() => {
        if (kind === 'medico') store.saveMedicos(list);
        else store.saveOperativos(list);
        store.addTombstone(id, Math.max(clock.tick(), (item?.updated || 0) + 1));
      });
      ctx.reloadCatalogs();
      ctx.sync?.schedule();
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
  ctx.snap = structuredClone(ctx.rec);
  return ctx;
}
