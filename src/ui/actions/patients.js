/**
 * Acciones sobre pacientes: preingreso, nueva atención para un paciente,
 * completar datos desde su ficha y mantener las fichas al día.
 */
import { blankRecord, applyBirthDate } from '../../core/record.js';
import {
  patientFields,
  missingPatients,
  resolvePatientId,
  canonicalPatientId,
  mergePatients,
  patientLabel,
  deletePatient,
  restorePatient,
  isDeletedPatient,
} from '../../core/patient.js';
import { clock } from '../../core/clock.js';
import { makeAuditEntry } from '../../core/audit.js';
import { toast } from '../dom.js';
import { syncAttentionView } from '../attentionView.js';
import { confirmDiscard } from './attention.js';
import { buildAdmission, nonEmpty, relinkRecord, patientUpdateFromRecord, editPatientData, rutOwner } from '../../app/attentions.js';
import { SEXOS } from '../../config/catalogs.js';
import { formatRut, isValidRut } from '../../core/format.js';
import { openDialog } from '../dialog.js';
import { uiConfirm } from '../modal.js';
import { hasNameParts, NAME_PARTS, refreshNames } from '../../core/names.js';
import { profileNameFields, profileNameValues } from '../patientFields.js';

/**
 * @param {any} ctx contexto de la aplicación (ver ui/context.js)
 * @param {ReturnType<import('../../storage/store.js').createStore>} store
 */
export function patientActions(ctx, store) {
  /**
   * @param {import('../../domain').Paciente} p
   * @param {Record<string, string>} fields
   */
  async function applyPatientEdit(p, fields) {
    const other = fields.paciente_rut ? rutOwner(store.loadPatients(), fields.paciente_rut, p.id) : null;
    if (other) {
      const ok = await uiConfirm({
        title: 'Ese RUT ya tiene ficha',
        message: `El RUT ${fields.paciente_rut} ya pertenece a la ficha de ${patientLabel(other)}. Si es la misma persona, se unen las dos fichas (sus atenciones quedan juntas; nada se borra).`,
        okLabel: 'Unir las fichas',
      });
      if (ok) await ctx.mergePatients(other.id, p.id);
      return;
    }
    await ctx.ensureUser();
    const r = editPatientData({ patient: p, fields, records: ctx.records, now: clock.tick() });
    if (!r.changed.length) return toast('Sin cambios');
    const done = ctx.persist(() => {
      store.savePatients([r.patient]);
      for (const { before, after } of r.records) {
        ctx.records = store.upsertRecord(after);
        const entry = makeAuditEntry({ tipo: 'editada', before, after, at: after.updated, ...ctx.author() });
        if (entry) store.addAuditEntry(after.id, entry);
      }
    });
    if (!done) return;
    // La atención abierta de este paciente muestra los datos corregidos.
    const open = r.records.find((x) => x.after.id === ctx.rec.id);
    if (open && !ctx.dirty) ctx.loadIntoForm(open.after);
    ctx.emit('datos');
    ctx.sync?.schedule();
    toast(
      r.records.length
        ? `Datos corregidos en la ficha y en ${r.records.length} ${r.records.length === 1 ? 'atención' : 'atenciones'}`
        : 'Datos de la ficha corregidos',
    );
  }

  return {
    /**
     * Preingreso: registra (o actualiza) al paciente y lo agrega a la lista de
     * atención de una fecha, sin datos clínicos. Si ya está en la lista de esa
     * fecha, no se duplica.
     * @param {Record<string, string>} data campos paciente_*
     * @param {{fecha: string, operativo?: string, pacienteId?: string}} where
     * @returns {Promise<{ok: boolean, id?: string}>}
     */
    async admitPatient(data, { fecha, operativo = '', pacienteId: currentId }) {
      const f = {
        ...nonEmpty(data),
        ...(hasNameParts(data, 'paciente_')
          ? Object.fromEntries(NAME_PARTS.map((k) => ['paciente_' + k, data['paciente_' + k] || '']))
          : {}),
      };
      if (!f.paciente_nombre && !f.paciente_rut) {
        toast('Escribe al menos el nombre o el RUT');
        return { ok: false };
      }
      // Por RUT entre las fichas existentes (aunque la ficha naciera solo con nombre).
      const pacienteId = resolvePatientId(f, store.loadPatients(), currentId);
      const existing = ctx.records.find((r) => r.pacienteId === pacienteId && r.f.fecha_atencion === fecha);
      if (existing) {
        toast(`${existing.f.paciente_nombre || existing.f.paciente_rut} ya está en la lista de ese día`, 3500);
        return { ok: true, id: existing.id };
      }
      await ctx.ensureUser();
      const now = clock.tick();
      const saved = buildAdmission({ fields: f, fecha, operativo, master: store.getPatient(pacienteId), pacienteId, now });
      const ok = ctx.persist(() => {
        ctx.records = store.upsertRecord(saved);
        ctx.syncPatientFromRecord(saved);
        const entry = makeAuditEntry({
          tipo: 'ingresada',
          after: saved,
          at: now,
          ...ctx.author(),
        });
        if (entry) store.addAuditEntry(saved.id, entry);
      });
      if (!ok) return { ok: false };
      ctx.emit('datos');
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
      ctx.emit('atencion');
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
      const id = ctx.rec.pacienteId || resolvePatientId(ctx.rec.f, store.loadPatients());
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
     * Actualiza la ficha del paciente con los datos de la atención. Se fusiona
     * campo a campo con la ficha existente (gana lo editado más recientemente),
     * así un cambio de teléfono hecho en el ingreso y otro dato corregido por
     * el médico se conservan ambos.
     */
    syncPatientFromRecord(rec) {
      const next = patientUpdateFromRecord(rec, rec.pacienteId ? store.getPatient(rec.pacienteId) : null, clock.tick());
      if (next) store.upsertPatient(next);
    },

    /**
     * Crea las fichas que falten (atenciones de versiones anteriores o
     * recibidas antes que su ficha) y re-vincula las atenciones de fichas que
     * se unieron a otra (p. ej. creadas en un equipo que aún no sabía de la unión).
     */
    ensurePatients() {
      const existing = new Map(store.loadPatients().map((p) => [p.id, p]));
      const missing = missingPatients(ctx.records, existing);
      if (missing.length) store.savePatients(missing);
      for (const p of missing) existing.set(p.id, p);
      const relinked = ctx.records
        .filter((r) => r.pacienteId && canonicalPatientId(existing, r.pacienteId) !== r.pacienteId)
        .map((r) => relinkRecord(r, canonicalPatientId(existing, r.pacienteId), clock.tick()));
      if (relinked.length) {
        for (const r of relinked) ctx.records = store.upsertRecord(r);
        ctx.sync?.schedule();
      }
      // Fichas eliminadas que tienen atenciones (p. ej. llegó una de otro equipo): se restauran.
      const used = new Set(ctx.records.map((r) => r.pacienteId).filter(Boolean));
      const restored = [...existing.values()]
        .filter((p) => isDeletedPatient(p) && used.has(p.id))
        .map((p) => restorePatient(p, clock.tick()));
      if (restored.length) {
        store.savePatients(restored);
        ctx.sync?.schedule();
      }
      return missing.length + relinked.length + restored.length;
    },

    /**
     * Une dos fichas de la misma persona: `keepId` se conserva (completa sus
     * datos vacíos con los de la otra) y las atenciones de `dropId` pasan a
     * ella. Se sincroniza: los demás equipos ven el resultado.
     */
    async mergePatients(keepId, dropId) {
      const keep = store.getPatient(keepId);
      const drop = store.getPatient(dropId);
      if (!keep || !drop) return false;
      const recs = ctx.records.filter((r) => r.pacienteId === dropId);
      const ok = await uiConfirm({
        title: 'Unir fichas',
        message: `Se conservará la ficha de ${patientLabel(keep)}${keep.f.paciente_rut ? ` (${keep.f.paciente_rut})` : ''} y se le pasarán ${recs.length} ${recs.length === 1 ? 'atención' : 'atenciones'} de la otra. Los datos que falten se completan; nada se borra.`,
        okLabel: 'Unir',
      });
      if (!ok) return false;
      await ctx.ensureUser();
      const at = clock.tick();
      let merged;
      try {
        merged = mergePatients(keep, drop, at);
      } catch (e) {
        toast(e.message, 4000);
        return false;
      }
      const done = ctx.persist(() => {
        store.savePatients([merged.keep, merged.drop]);
        for (const r of recs) {
          const next = relinkRecord(r, keepId, at);
          ctx.records = store.upsertRecord(next);
          const entry = makeAuditEntry({ tipo: 'editada', before: r, after: next, at: next.updated, ...ctx.author() });
          if (entry) store.addAuditEntry(next.id, entry);
          ctx.syncPatientFromRecord(next);
        }
      });
      if (!done) return false;
      ctx.emit('datos');
      ctx.sync?.schedule();
      toast('Fichas unidas');
      return true;
    },

    /**
     * Elimina una ficha creada por error. Solo si no tiene atenciones en este
     * equipo; se sincroniza (deja de aparecer en todos los equipos).
     */
    async deletePatient(id) {
      const p = store.getPatient(id);
      if (!p || isDeletedPatient(p)) return false;
      if (ctx.records.some((r) => r.pacienteId === id)) {
        toast('Esta ficha tiene atenciones: no se puede eliminar.', 4000);
        return false;
      }
      const ok = await uiConfirm({
        title: 'Eliminar ficha',
        message: `Se eliminará la ficha de ${patientLabel(p)}${p.f.paciente_rut ? ` (${p.f.paciente_rut})` : ''}, que no tiene atenciones. Dejará de aparecer en este y en los demás equipos. Si más adelante una atención la usa (mismo RUT), vuelve a aparecer.`,
        tone: 'danger',
        okLabel: 'Eliminar ficha',
      });
      if (!ok) return false;
      await ctx.ensureUser();
      if (!ctx.persist(() => store.savePatients([deletePatient(p, clock.tick())]))) return false;
      if (ctx.openPatientId === id) ctx.openPatientId = null;
      ctx.emit('datos');
      ctx.sync?.schedule();
      toast('Ficha eliminada');
      return true;
    },

    /**
     * Corrige los datos personales del paciente (ficha y todas sus atenciones)
     * sin perder la continuidad: la ficha conserva su id. Si el RUT nuevo ya es
     * de otra ficha, ofrece unirlas.
     */
    editPatient(id) {
      const p = store.getPatient(id);
      if (!p) return;
      const f = p.f || {};
      // Nombre: apellidos y nombres separados; un nombre antiguo (un solo texto) se muestra sin repartirlo.
      const person = {
        nombre: f.paciente_nombre || '',
        ...Object.fromEntries(NAME_PARTS.filter((k) => Object.hasOwn(f, 'paciente_' + k)).map((k) => [k, f['paciente_' + k]])),
      };
      openDialog({
        title: 'Editar datos del paciente',
        fields: [
          { id: 'paciente_rut', label: 'RUT', value: f.paciente_rut || '', placeholder: '12.345.678-9' },
          ...profileNameFields(person),
          { id: 'paciente_fnac', label: 'Fecha de nacimiento', type: 'date', value: f.paciente_fnac || '' },
          {
            id: 'paciente_sexo',
            label: 'Sexo',
            value: f.paciente_sexo || '',
            options: [{ value: '', label: '—' }, ...SEXOS.map((s) => ({ value: s.key, label: s.label }))],
          },
          { id: 'paciente_fono', label: 'Fono', value: f.paciente_fono || '' },
        ],
        onSave: (v) => {
          if (v.paciente_rut && !isValidRut(v.paciente_rut)) return 'RUT inválido (revisa el dígito verificador).';
          const names = profileNameValues(v, person);
          /** @type {Record<string, string>} */
          const out = {
            paciente_rut: v.paciente_rut ? formatRut(v.paciente_rut) : '',
            paciente_fnac: v.paciente_fnac,
            paciente_sexo: v.paciente_sexo,
            paciente_fono: v.paciente_fono,
            ...Object.fromEntries(Object.entries(names).map(([k, x]) => ['paciente_' + k, x])),
          };
          refreshNames(out); // el nombre completo se arma con apellidos y nombres
          if (!out.paciente_rut && !out.paciente_nombre?.trim()) return 'Indica al menos el nombre o el RUT.';
          setTimeout(() => void applyPatientEdit(p, out), 0);
          return null;
        },
      });
    },

    /** Marca dos fichas como personas distintas (deja de sugerir unirlas en este equipo). */
    notDuplicates(aId, bId) {
      const set = store.loadNotDuplicates();
      set.add([aId, bId].sort().join('|'));
      ctx.persist(() => store.saveNotDuplicates(set));
      ctx.emit('datos');
    },
  };
}
