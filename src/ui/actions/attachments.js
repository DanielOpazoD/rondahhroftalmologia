/**
 * Acciones sobre los adjuntos de la atención abierta: agregar (con
 * compresión de fotos), abrir y eliminar. Ver core/attachments.js.
 */
import {
  addProblem,
  kindOf,
  newAttachmentId,
  normalizeAttachment,
  safeFileName,
  sha256Hex,
  isInlineType,
  cleanType,
  THUMB_MAX_CHARS,
} from '../../core/attachments.js';
import { attachmentAuditEntry } from '../../core/audit.js';
import { clock } from '../../core/clock.js';
import { toast } from '../dom.js';
import { uiConfirm, uiAlert } from '../modal.js';
import { prepareImage, makeThumbnail } from '../images.js';

/** @typedef {import('../../domain').Adjunto} Adjunto */

/**
 * @param {any} ctx contexto de la aplicación (ver ui/context.js). `any`: su tipo
 *   (AppContext) incluye lo que devuelve esta función; declararlo aquí sería circular.
 * @param {ReturnType<import('../../storage/store.js').createStore>} store
 */
export function attachmentActions(ctx, store) {
  /**
   * Anota en la bitácora de la atención (agregado o eliminado).
   * @param {string} atencionId
   * @param {string} id del adjunto
   * @param {string} nombre del archivo
   * @param {boolean} added true: agregado; false: eliminado
   */
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
        const miniatura = kindOf(prepared.tipo, prepared.nombre).startsWith('imagen')
          ? await makeThumbnail(prepared.bytes, cleanType(prepared.tipo), THUMB_MAX_CHARS)
          : null;
        const now = clock.tick();
        const meta = normalizeAttachment({
          ...(miniatura ? { miniatura } : {}),
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

    /**
     * Adjuntos de antes de la 2.15.0: si su contenido está en este equipo, se
     * les crea la miniatura (una vez) y se sincroniza.
     * @param {Adjunto[]} metas
     */
    async addMissingThumbnails(metas) {
      const have = new Set(await store.attachmentDataIds());
      /** @type {Adjunto[]} */
      const done = [];
      for (const a of metas) {
        if (a.miniatura || !have.has(a.id) || !kindOf(a.tipo, a.nombre).startsWith('imagen')) continue;
        const data = await store.loadAttachmentData(a.id);
        const miniatura = data && (await makeThumbnail(data.bytes, cleanType(a.tipo), THUMB_MAX_CHARS));
        if (miniatura) done.push({ ...a, miniatura, updated: Math.max(clock.tick(), (a.updated || 0) + 1) });
      }
      if (!done.length) return 0;
      if (!ctx.persist(() => store.saveAttachments(done))) return 0;
      ctx.sync?.schedule();
      return done.length;
    },

    /**
     * Abre (o descarga) un adjunto.
     * @param {string} id
     */
    async openAttachment(id) {
      const meta = store.getAttachment(id);
      const data = meta && (await store.loadAttachmentData(id));
      if (meta && data) ctx.accounts?.event('adjunto.ver', id);
      if (!meta || !data) {
        toast('Este archivo aún no llega a este equipo: se descargará al sincronizar.', 4000);
        return;
      }
      // Solo contenido pasivo (JPEG, PNG, GIF, WebP, PDF) se abre en otra pestaña.
      // Todo lo demás se descarga como binario genérico: nunca se interpreta en
      // el origen de la app (p. ej. un SVG o HTML con scripts).
      const inline = isInlineType(meta.tipo);
      const type = inline ? cleanType(meta.tipo) : 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (data.bytes)], { type }));
      const a = document.createElement('a');
      a.href = url;
      if (inline) a.target = '_blank';
      else a.download = meta.nombre;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },

    /**
     * Elimina un adjunto (en todos los equipos, si hay sincronización).
     * @param {string} id
     */
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

    /**
     * Quita adjuntos (al eliminarlos o al eliminar su atención): lápida, contenido y borrado en el servidor.
     * @param {Adjunto[]} metas
     */
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
