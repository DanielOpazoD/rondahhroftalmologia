/**
 * Salidas de una atención: PDF y nota, y clave de seudonimización.
 */
import { buildAttentionPdf, pdfFileName } from '../../specialties/activa/index.js';
import { createSecret } from '../../core/pseudonym.js';
import { toast, download, copyText, withBusy } from '../dom.js';
import { uiCopy } from '../modal.js';
import { openMenu } from '../menu.js';
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
     * Descarga el PDF de la atención: un menú junto al botón ofrece «PDF»
     * (la hoja) o «PDF + adjuntos» (en el mismo documento, ver core/pdfAnexos.js).
     */
    async downloadPdf(rec, button) {
      const metas = rec.id ? store.loadAttachments(rec.id) : [];
      const n = metas.length;
      const choice = await openMenu(
        button,
        [
          { value: 'pdf', label: 'PDF', hint: 'Hoja de la atención' },
          {
            value: 'anexos',
            label: 'PDF + adjuntos',
            hint: n ? `La hoja y ${n} ${n === 1 ? 'adjunto' : 'adjuntos'} en un solo PDF` : 'Esta atención no tiene adjuntos',
            disabled: !n,
          },
        ],
        { label: 'Descargar PDF' },
      );
      if (!choice) return undefined;
      const withAnnexes = choice === 'anexos';
      return withBusy(button, async () => {
        const r = await buildAttentionPdf(ctx.templateBytes(), rec, ctx.procs, ctx.pdfOptions());
        if (!withAnnexes) {
          download(r.bytes, pdfFileName(rec), 'application/pdf');
          if (rec.id) ctx.accounts?.event('atencion.pdf', rec.id);
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
        if (rec.id) ctx.accounts?.event('atencion.pdf', rec.id, { n: metas.length });
        const notes = [
          out.incrustados.length && `${out.incrustados.length} dentro del PDF (panel de adjuntos)`,
          out.faltantes.length && `${out.faltantes.length} aún no llegan a este equipo`,
        ].filter(Boolean);
        toast(`PDF con anexos descargado${notes.length ? ` · ${notes.join(' · ')}` : ''}`, notes.length ? 5000 : 2500);
      });
    },

    async copyNote(rec) {
      const text = ctx.note(rec);
      if (rec.id) ctx.accounts?.event('atencion.nota', rec.id);
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
