/**
 * Acciones sobre los adjuntos de la atención abierta: agregar (con
 * compresión de fotos), abrir y eliminar. Ver core/attachments.js.
 */
import { addProblem, kindOf, newAttachmentId, normalizeAttachment, safeFileName, sha256Hex } from '../../core/attachments.js';
import { attachmentAuditEntry } from '../../core/audit.js';
import { clock } from '../../core/clock.js';
import { toast } from '../dom.js';
import { uiConfirm, uiAlert } from '../modal.js';
import { prepareImage } from '../images.js';

/**
 * @param {any} ctx contexto de la aplicación (ver ui/context.js)
 * @param {ReturnType<import('../../storage/store.js').createStore>} store
 */
export function attachmentActions(ctx, store) {
  /** Anota en la bitácora de la atención (agregado o eliminado). */
  const audit = (atencionId, id, nombre, added) => {
    const entry = attachmentAuditEntry({ id, nombre, added, at: clock.tick(), ...ctx.author() });
    store.addAuditEntry(atencionId, entry);
  };

  return {
    /**
     * Adjunta archivos a la atención abierta. Si aún no está guardada, la
     * guarda primero (necesita nombre o RUT y fecha).
     * @param {File[]} files
     */
    async addAttachments(files) {
      if (!files.length) return;
      if (!store.supportsAttachments()) {
        uiAlert({ title: 'Adjuntos no disponibles', message: 'Este navegador no permite guardar archivos (sin IndexedDB).', tone: 'warn' });
        return;
      }
      if (!ctx.rec.id || ctx.dirty) {
        const saved = await ctx.save({ auto: true });
        if (!saved && !ctx.rec.id) {
          toast('Para adjuntar, escribe primero el nombre o RUT del paciente.', 4000);
          return;
        }
      }
      const atencionId = ctx.rec.id;
      let added = 0;
      for (const file of files) {
        const prepared = kindOf(file.type, file.name).startsWith('imagen')
          ? await prepareImage(file)
          : { bytes: new Uint8Array(await file.arrayBuffer()), tipo: file.type, nombre: file.name, comprimida: false };
        const problem = addProblem(store.loadAttachments(atencionId), prepared.bytes.length);
        if (problem) {
          uiAlert({ title: `No se adjuntó «${safeFileName(file.name)}»`, message: problem, tone: 'warn' });
          continue;
        }
        const now = clock.tick();
        const meta = normalizeAttachment({
          id: newAttachmentId(now),
          atencionId,
          nombre: prepared.nombre,
          tipo: prepared.tipo || 'application/octet-stream',
          tamano: prepared.bytes.length,
          sha256: await sha256Hex(prepared.bytes),
          created: now,
          updated: now,
        });
        if (!meta) continue;
        // Primero el contenido (se espera a que quede escrito), después los metadatos.
        await store.saveAttachmentData(meta.id, prepared.bytes);
        ctx.persist(() => {
          store.saveAttachments([meta]);
          audit(atencionId, meta.id, meta.nombre, true);
        });
        added++;
      }
      if (added) {
        ctx.emit('adjuntos');
        ctx.sync?.schedule();
        toast(added === 1 ? 'Archivo adjuntado' : `${added} archivos adjuntados`);
      }
    },

    /** Abre (o descarga) un adjunto. */
    async openAttachment(id) {
      const meta = store.getAttachment(id);
      const data = meta && (await store.loadAttachmentData(id));
      if (!meta || !data) {
        toast('Este archivo aún no llega a este equipo: se descargará al sincronizar.', 4000);
        return;
      }
      const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (data.bytes)], { type: meta.tipo || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      // Imágenes y PDF se abren en otra pestaña; el resto se descarga con su nombre.
      if (/^image\/|pdf/.test(meta.tipo)) a.target = '_blank';
      else a.download = meta.nombre;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },

    /** Elimina un adjunto (en todos los equipos, si hay sincronización). */
    async deleteAttachment(id) {
      const meta = store.getAttachment(id);
      if (!meta) return;
      const ok = await uiConfirm({
        title: 'Eliminar adjunto',
        message: `Se eliminará «${meta.nombre}»${ctx.sync?.enabled ? ' en todos los equipos' : ''}. No se puede deshacer.`,
        tone: 'danger',
        okLabel: 'Eliminar',
      });
      if (!ok) return;
      ctx.removeAttachmentsOf([meta]);
      ctx.emit('adjuntos');
      toast('Adjunto eliminado');
    },

    /** Quita adjuntos (al eliminarlos o al eliminar su atención): lápida, contenido y borrado en el servidor. */
    removeAttachmentsOf(metas) {
      if (!metas.length) return;
      ctx.persist(() => {
        const purges = new Set(store.loadAttachmentPurges());
        for (const m of metas) {
          store.removeAttachment(m.id);
          store.addTombstone(m.id, Math.max(clock.tick(), (m.updated || 0) + 1));
          purges.add(m.id);
          audit(m.atencionId, m.id, m.nombre, false);
        }
        store.saveAttachmentPurges([...purges]);
      });
      for (const m of metas) void store.deleteAttachmentData(m.id);
      ctx.sync?.schedule();
    },
  };
}
