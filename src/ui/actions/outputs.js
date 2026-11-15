/**
 * Salidas de una atención: PDF y nota, y clave de seudonimización.
 */
import { buildAttentionPdf, pdfFileName } from '../../specialties/activa/index.js';
import { createSecret } from '../../core/pseudonym.js';
import { toast, download, copyText, withBusy } from '../dom.js';
import { uiCopy, uiChoose } from '../modal.js';
import { appendAnnexes } from '../../core/pdfAnexos.js';
import { kindOf } from '../../core/attachments.js';
import { toPng } from '../images.js';

/**
 * Cómo entra un adjunto al PDF: JPEG/PNG como página, otras imágenes
 * convertidas a PNG (si el navegador puede leerlas), PDF con sus páginas, y el
 * resto incrustado.
 * @param {{nombre: string, tipo: string}} m
 * @param {Uint8Array | null} bytes
 * @returns {Promise<import('../../core/pdfAnexos.js').Anexo>}
 */
async function annexFrom(m, bytes) {
  const base = { nombre: m.nombre, tipo: m.tipo, bytes };
  if (!bytes) return { ...base, como: 'incrustar' };
  const kind = kindOf(m.tipo, m.nombre);
  if (kind === 'imagen') return { ...base, como: /png/i.test(m.tipo) || /\.png$/i.test(m.nombre) ? 'imagen-png' : 'imagen-jpg' };
  if (kind === 'imagen-otra') {
    const png = await toPng(bytes, m.tipo);
    return png ? { ...base, bytes: png, como: 'imagen-png' } : { ...base, como: 'incrustar' };
  }
  if (kind === 'pdf') return { ...base, como: 'pdf' };
  return { ...base, como: 'incrustar' };
}

/**
 * @param {any} ctx contexto de la aplicación (ver ui/context.js)
 * @param {ReturnType<import('../../storage/store.js').createStore>} store
 */
export function outputActions(ctx, store) {
  return {
    /**
     * Descarga el PDF de la atención. Si tiene adjuntos, pregunta si se
     * incluyen como anexos en el mismo documento (ver core/pdfAnexos.js).
     */
    async downloadPdf(rec, button) {
      const metas = rec.id ? store.loadAttachments(rec.id) : [];
      let withAnnexes = false;
      if (metas.length) {
        const choice = await uiChoose({
          title: 'Descargar PDF',
          message: `Esta atención tiene ${metas.length} ${metas.length === 1 ? 'adjunto' : 'adjuntos'}. ¿Incluirlos como anexos en el mismo PDF?`,
          okLabel: 'Con anexos',
          altLabel: 'Solo la hoja',
        });
        if (!choice) return undefined;
        withAnnexes = choice === 'ok';
      }
      return withBusy(button, async () => {
        const r = await buildAttentionPdf(ctx.templateBytes(), rec, ctx.procs, ctx.pdfOptions());
        if (!withAnnexes) {
          download(r.bytes, pdfFileName(rec), 'application/pdf');
          toast(
            r.overflow.length ? `PDF descargado (con hoja complementaria: ${r.overflow.join(', ')})` : 'PDF descargado',
            r.overflow.length ? 4000 : 2200,
          );
          return;
        }
        const anexos = [];
        for (const m of metas) {
          const data = await store.loadAttachmentData(m.id);
          anexos.push(await annexFrom(m, data?.bytes || null));
        }
        const out = await appendAnnexes(r.bytes, anexos);
        download(out.bytes, pdfFileName(rec).replace(/\.pdf$/i, '_con_anexos.pdf'), 'application/pdf');
        const notes = [
          out.incrustados.length && `${out.incrustados.length} dentro del PDF (panel de adjuntos)`,
          out.faltantes.length && `${out.faltantes.length} aún no llegan a este equipo`,
        ].filter(Boolean);
        toast(`PDF con anexos descargado${notes.length ? ` · ${notes.join(' · ')}` : ''}`, notes.length ? 5000 : 2500);
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
