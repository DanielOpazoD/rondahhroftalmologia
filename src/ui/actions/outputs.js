/**
 * Salidas de una atención: PDF y nota, y clave de seudonimización.
 */
import { buildAttentionPdf, pdfFileName } from '../../specialties/activa/index.js';
import { createSecret } from '../../core/pseudonym.js';
import { toast, download, copyText, withBusy } from '../dom.js';
import { uiCopy } from '../modal.js';

/**
 * @param {any} ctx contexto de la aplicación (ver ui/context.js)
 * @param {ReturnType<import('../../storage/store.js').createStore>} store
 */
export function outputActions(ctx, store) {
  return {
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

    /** Clave de seudonimización del equipo (se crea si no existe). */
    ensureSecret() {
      let s = store.loadSecret();
      if (!s) {
        s = createSecret();
        ctx.persist(() => store.saveSecret(s));
      }
      return s;
    },
  };
}
