/**
 * Acciones sobre la atención en edición: guardar, abrir, nueva, combinar con
 * otra del mismo paciente, recibir cambios de otro equipo y eliminar.
 */
import { blankRecord, normalizeRecord, newRecordId, validateRecord, findDuplicate } from '../../core/record.js';
import { fmtDate } from '../../core/format.js';
import { mergeRecords, ensureFt } from '../../core/merge.js';
import { resolvePatientId, isAttended } from '../../core/patient.js';
import { clock } from '../../core/clock.js';
import { makeAuditEntry } from '../../core/audit.js';
import { toast } from '../dom.js';
import { syncAttentionView, showValidation } from '../attentionView.js';
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
    async save() {
      const v = validateRecord(ctx.rec);
      if (v.errors.length) {
        showValidation(ctx, { showErrors: true });
        toast(v.errors[0]);
        return false;
      }
      await ctx.ensureUser();
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
      // Por RUT entre las fichas (si se le agregó o corrigió el RUT, pasa a la ficha de ese RUT).
      const prevPid = rec.pacienteId;
      rec.pacienteId = resolvePatientId(rec.f, store.loadPatients(), rec.pacienteId) || undefined;
      ensureFt(rec);
      rec.updated = Math.max(now, (stored?.updated || 0) + 1);
      // El vínculo con el paciente es un campo más: su cambio se fecha para que la fusión entre equipos lo respete.
      if (rec.pacienteId !== prevPid) rec.ft.pacienteId = rec.updated;
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
      await ctx.ensureUser();
      const done = ctx.persist(() => {
        ctx.records = store.deleteRecord(id);
        const at = clock.tick();
        store.addAuditEntry(id, makeAuditEntry({ tipo: 'eliminada', at, ...ctx.author() }));
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
  };
}
