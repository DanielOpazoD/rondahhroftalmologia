/**
 * Acciones sobre la atención en edición: guardar, abrir, nueva, combinar con
 * otra del mismo paciente, recibir cambios de otro equipo y eliminar.
 */
import { blankRecord, normalizeRecord, validateRecord, findDuplicate } from '../../core/record.js';
import { fmtDate } from '../../core/format.js';
import { mergeRecords } from '../../core/merge.js';
import { isAttended } from '../../core/patient.js';
import { prepareSave } from '../../app/attentions.js';
import { clock } from '../../core/clock.js';
import { makeAuditEntry, auditChanges, changesSummary } from '../../core/audit.js';
import { toast } from '../dom.js';
import { syncAttentionView, showValidation, renderToolbar, renderHistory, flashFields, showRemoteNotice } from '../attentionView.js';
import { uiConfirm, uiChoose } from '../modal.js';

/** Pregunta antes de descartar cambios sin guardar. */
export const confirmDiscard = (what) =>
  uiConfirm({
    title: 'Cambios sin guardar',
    message: `La atención actual tiene cambios sin guardar. ¿Descartarlos y ${what}?`,
    tone: 'warn',
    okLabel: 'Descartar',
  });

/**
 * @param {any} ctx contexto de la aplicación (ver ui/context.js)
 * @param {ReturnType<import('../../storage/store.js').createStore>} store
 */
export function attentionActions(ctx, store) {
  return {
    /**
     * Guarda la atención en edición.
     * `auto`: guardado automático tras una pausa al escribir. Es silencioso:
     * no muestra errores ni mensajes, y si la atención aún no se puede guardar
     * (falta nombre/RUT o fecha) o duplicaría otra del mismo día, espera (la
     * barra de estado dice por qué).
     * @param {{auto?: boolean}} [o]
     */
    async save({ auto = false } = {}) {
      const v = validateRecord(ctx.rec);
      if (v.errors.length) {
        if (auto) return false;
        showValidation(ctx, { showErrors: true });
        toast(v.errors[0]);
        return false;
      }
      // Atención NUEVA de un paciente que ya tiene una ese día (p. ej. creada en otro equipo).
      const dup = !ctx.rec.id && findDuplicate(ctx.rec, ctx.records);
      if (dup && auto) return false; // la barra ofrece continuar en la existente
      await ctx.ensureUser();
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
      const stored = ctx.records.find((r) => r.id === ctx.rec.id) || null;
      const rec = prepareSave({ rec: ctx.rec, stored, patients: store.loadPatients(), procs: ctx.procs, now: clock.tick() });
      const ok = ctx.persist(() => {
        ctx.records = store.upsertRecord(rec);
        ctx.syncPatientFromRecord(rec);
        // Bitácora: qué cambió, cuándo y desde qué equipo.
        const entry = makeAuditEntry({
          tipo: stored ? 'editada' : 'creada',
          before: stored,
          after: rec,
          at: rec.updated,
          ...ctx.author(),
        });
        if (entry) store.addAuditEntry(rec.id, entry);
        store.saveMedico({ n: rec.f.medico_nombre, r: rec.f.medico_rut, op: rec.f.operativo });
        store.saveDraft(rec);
      });
      if (!ok) return false;
      ctx.rec = rec;
      ctx.snap = structuredClone(rec);
      ctx.dirty = false;
      if (auto) {
        // Sin re-dibujar el formulario mientras se escribe: solo estado e historial.
        renderToolbar(ctx);
        renderHistory(ctx);
      } else syncAttentionView(ctx);
      ctx.emit('datos');
      ctx.sync?.schedule();
      if (auto) return true;
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
     * Se avisa QUÉ cambió (y quién) y se resaltan esos campos un momento.
     */
    absorbRemote(fresh) {
      const before = ctx.rec;
      if (!ctx.dirty) ctx.loadIntoForm(fresh);
      else {
        ctx.rec = normalizeRecord(mergeRecords(fresh, ctx.rec));
        ctx.snap = structuredClone(ctx.rec);
        ctx.persist(() => store.saveDraft(ctx.rec));
        syncAttentionView(ctx);
      }
      const cambios = auditChanges(before, ctx.rec);
      if (!cambios.length) return;
      // Quién: la última entrada de la bitácora hecha en otro equipo.
      const me = store.loadDeviceId();
      const last = store.auditFor(ctx.rec.id).find((e) => e.equipoId !== me);
      const who = last ? last.autor || last.equipo : 'otro equipo';
      showRemoteNotice(ctx.rec.id, `Cambios de ${who}: ${changesSummary(cambios, ctx.procs)}`);
      flashFields(cambios.map((c) => c.c));
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
      await ctx.ensureUser();
      const done = ctx.persist(() => {
        ctx.records = store.deleteRecord(id);
        const at = clock.tick();
        store.addAuditEntry(id, makeAuditEntry({ tipo: 'eliminada', at, ...ctx.author() }));
        // La "lápida" permite propagar la eliminación a los otros equipos.
        store.addTombstone(id, Math.max(clock.tick(), (r.updated || 0) + 1));
      });
      if (!done) return;
      // Sus adjuntos se eliminan con ella (en todos los equipos).
      ctx.removeAttachmentsOf(store.loadAttachments(id));
      ctx.sync?.schedule();
      if (ctx.rec.id === id) {
        ctx.rec.id = null;
        syncAttentionView(ctx);
      }
      ctx.emit('datos');
      toast('Atención eliminada');
    },
  };
}
