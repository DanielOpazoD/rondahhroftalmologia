/** Menú de formularios y guardado en la atención activa del paciente. */
import { can, PERMISSIONS } from '../../core/permissions.js';
import { rememberClinicalForm } from '../../core/clinicalForms.js';
import { mergeRecords } from '../../core/merge.js';
import { normalizeRecord, patientIdentityKey } from '../../core/record.js';
import { makeAuditEntry } from '../../core/audit.js';
import { clock } from '../../core/clock.js';
import { attentionsOf } from '../../core/patient.js';
import { GES_PATOLOGIAS } from '../../specialties/activa/config.js';
import recetaTemplate from '../../specialties/activa/recetaPlantilla.js';
import { downloadGes } from '../gesDialog.js';
import { downloadIpd } from '../ipdDialog.js';
import { downloadReceta } from '../recetaDialog.js';
import { openMenu } from '../menu.js';
import { renderToolbar, renderHistory } from '../attentionView.js';
import { toast } from '../dom.js';

export const HAS_CLINICAL_FORMS = !!(GES_PATOLOGIAS.length || recetaTemplate);

/** @param {any} ctx @param {ReturnType<import('../../storage/store.js').createStore>} store */
export function formActions(ctx, store) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let refreshTimer;
  const allowed = () =>
    can(ctx.accounts?.user, PERMISSIONS.EDITAR_CLINICO) &&
    !ctx.lock?.state.locked &&
    !document.documentElement.classList.contains('locked');
  return {
    hasClinicalForms: HAS_CLINICAL_FORMS,
    /** El menú siempre opera sobre la atención que se muestra al profesional. */
    async openForms(button) {
      if (!HAS_CLINICAL_FORMS || !allowed()) return;
      const accountId = ctx.accounts?.user?.id;
      if (ctx.currentTab === 't-reg' && ctx.openPatientId) {
        if (ctx.dirty) await ctx.save({ auto: true });
        if (!allowed() || ctx.accounts?.user?.id !== accountId) return;
        const patientId = ctx.openPatientId;
        const selected = attentionsOf(ctx.records, patientId)[0];
        if (ctx.rec.pacienteId === patientId && (!selected || ctx.rec.id === selected.id)) ctx.showTab('t-at');
        else if (selected) await ctx.openRecord(selected.id);
        else await ctx.newAttentionFor(patientId);
        if (ctx.currentTab !== 't-at' || ctx.rec.pacienteId !== patientId) return;
      } else ctx.showTab('t-at');
      if (!ctx.rec.f.paciente_nombre?.trim() && !ctx.rec.f.paciente_rut?.trim()) {
        toast('Selecciona o ingresa un paciente para completar sus formularios.');
        return;
      }
      // Da una identidad estable a la atención antes de abrir el formulario.
      if ((!ctx.rec.id || ctx.dirty) && !(await ctx.save())) return;
      if (!allowed() || ctx.accounts?.user?.id !== accountId) return;
      const attentionId = ctx.rec.id;
      const patient = patientIdentityKey(ctx.rec);
      const choice = await openMenu(
        button,
        [
          ...(GES_PATOLOGIAS.length
            ? [
                { value: 'ges', label: 'Constancia GES', hint: 'Completar, descargar o imprimir' },
                { value: 'ipd', label: 'IPD · Proceso diagnóstico', hint: 'Completar, descargar o imprimir' },
              ]
            : []),
          ...(recetaTemplate ? [{ value: 'receta', label: 'Receta para lentes', hint: 'Completar, descargar o imprimir' }] : []),
        ],
        { label: 'Formularios del paciente' },
      );
      if (!allowed() || ctx.accounts?.user?.id !== accountId || ctx.rec.id !== attentionId || patientIdentityKey(ctx.rec) !== patient) {
        return;
      }
      const rec = ctx.rec;
      if (choice === 'ges') return downloadGes(ctx, rec, button);
      if (choice === 'ipd') return downloadIpd(ctx, rec, button);
      if (choice === 'receta') return downloadReceta(ctx, rec, button);
    },

    /** Persiste sin esperar al autoguardado ni reemplazar correcciones remotas de otros campos.
     * @param {import('../../domain').Atencion} owner @param {import('../../core/clinicalForms.js').FormKind} kind
     * @param {Record<string, string>} previous @param {Record<string, string>} values
     */
    rememberForm(owner, kind, previous, values) {
      if (!allowed() || !owner.id || ctx.rec.id !== owner.id || patientIdentityKey(ctx.rec) !== patientIdentityKey(owner)) return false;
      const stored = store.loadRecords().find((r) => r.id === owner.id);
      if (!stored) return false;
      const base = normalizeRecord(mergeRecords(stored, ctx.rec));
      const at = Math.max(clock.tick(), (stored.updated || 0) + 1, (ctx.rec.updated || 0) + 1);
      const next = rememberClinicalForm(base, kind, previous, values, at);
      if (next === base) return true;
      next.updated = at;
      const ok = ctx.persist(() => {
        store.saveDraft(next);
        ctx.records = store.upsertRecord(next);
        const entry = makeAuditEntry({ tipo: 'editada', before: stored, after: next, at, ...ctx.author() });
        if (entry) store.addAuditEntry(owner.id, entry);
      });
      if (!ok) return false;
      ctx.rec = next;
      ctx.snap = structuredClone(next);
      ctx.dirty = false;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        renderToolbar(ctx);
        renderHistory(ctx);
        ctx.emit('datos');
      }, 250);
      ctx.sync?.schedule();
      return true;
    },
  };
}
