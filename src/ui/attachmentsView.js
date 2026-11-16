/**
 * Tarjeta «Adjuntos» de la atención: lista (miniatura o ícono, nombre,
 * tamaño), adjuntar con el botón o arrastrando archivos, abrir y eliminar.
 */
import { ACCEPT, kindOf, fmtSize, isInlineType, cleanType } from '../core/attachments.js';
import { $, dataOf } from './dom.js';
import { html, setHtml } from './html.js';
import { icon } from './icons.js';

/** URLs de miniaturas vigentes (se liberan al re-dibujar). @type {string[]} */
let thumbs = [];

/** @param {import('./context.js').AppContext} ctx */
export function initAttachmentsView(ctx) {
  const input = $('#attInput');
  input.setAttribute('accept', ACCEPT);
  $('#attAdd').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    await ctx.addAttachments(files);
  });
  // Arrastrar y soltar sobre la tarjeta.
  const card = $('#attCard');
  card.addEventListener('dragover', (/** @type {DragEvent} */ e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    card.classList.add('drop');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop'));
  card.addEventListener('drop', (/** @type {DragEvent} */ e) => {
    e.preventDefault();
    card.classList.remove('drop');
    void ctx.addAttachments([...(e.dataTransfer?.files || [])]);
  });
  $('#attList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('button[data-a]'));
    if (!b) return;
    if (b.dataset.a === 'open') void ctx.openAttachment(dataOf(b, 'id'));
    if (b.dataset.a === 'del') void ctx.deleteAttachment(dataOf(b, 'id'));
  });
  ctx.on('adjuntos', () => renderAttachments(ctx));
}

/**
 * Texto de ayuda bajo la lista de adjuntos.
 * @param {boolean} supported ¿el navegador permite guardar archivos?
 * @param {string | null} id de la atención abierta (null si aún no está guardada)
 */
function attachmentsHint(supported, id) {
  if (!supported) return 'Este navegador no permite guardar archivos.';
  return id
    ? 'Imágenes, PDF o Word. Arrástralos aquí o usa «Adjuntar». Las fotos se reducen solas.'
    : 'Escribe el nombre o RUT del paciente para poder adjuntar archivos.';
}

/**
 * ¿Imagen sin miniatura guardada cuyo contenido está en este equipo? (se
 * muestra desde el contenido y se le crea la miniatura).
 * @param {import('../domain').Adjunto} a
 * @param {Set<string>} have ids con contenido en este equipo
 */
function lacksThumbnail(a, have) {
  return !a.miniatura && kindOf(a.tipo, a.nombre).startsWith('imagen') && isInlineType(a.tipo) && have.has(a.id);
}

/**
 * Vista previa de un adjunto: su miniatura, la imagen leída del contenido
 * (si le falta la miniatura) o un ícono según el tipo.
 * @param {import('./context.js').AppContext['store']} store
 * @param {import('../domain').Adjunto} a
 * @param {Set<string>} have ids con contenido en este equipo
 */
async function attachmentPreview(store, a, have) {
  // Miniatura guardada con los metadatos (validada en normalizeAttachment).
  if (a.miniatura) return html`<img class="attthumb" src="${a.miniatura}" alt="">`;
  const data = lacksThumbnail(a, have) ? await store.loadAttachmentData(a.id) : null;
  if (data) {
    const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (data.bytes)], { type: cleanType(a.tipo) }));
    thumbs.push(url);
    return html`<img class="attthumb" src="${url}" alt="">`;
  }
  return html`<span class="attico">${icon(kindOf(a.tipo, a.nombre) === 'pdf' ? 'pdf' : 'file')}</span>`;
}

/** Dibuja los adjuntos de la atención abierta. @param {import('./context.js').AppContext} ctx */
export async function renderAttachments(ctx) {
  const { store } = ctx;
  const id = ctx.rec.id;
  const list = id ? store.loadAttachments(id) : [];
  $('#attCount').textContent = String(list.length);
  $('#attHint').textContent = attachmentsHint(store.supportsAttachments(), id);
  for (const u of thumbs) URL.revokeObjectURL(u);
  thumbs = [];
  const have = new Set(list.length ? await store.attachmentDataIds() : []);
  const items = [];
  for (const a of list) {
    const preview = await attachmentPreview(store, a, have);
    const status = have.has(a.id) ? fmtSize(a.tamano) : `${fmtSize(a.tamano)} · llega al sincronizar`;
    items.push(html`<li class="attrow">
      <button type="button" class="attmain" data-a="open" data-id="${a.id}" title="Abrir ${a.nombre}">
        ${preview}<span class="attname">${a.nombre}</span><span class="muted">${status}</span>
      </button>
      <button type="button" class="ib sm danger" data-perm="clinico" data-a="del" data-id="${a.id}" title="Eliminar" aria-label="Eliminar ${a.nombre}">${icon('trash')}</button>
    </li>`);
  }
  // Solo si la atención sigue siendo la misma al terminar de leer.
  if (ctx.rec.id !== id) return;
  setHtml($('#attList'), html`${items}`);
  $('#attAdd').disabled = !id || !store.supportsAttachments();
  // Adjuntos anteriores sin miniatura: se crea una vez (y se re-dibuja).
  const missingThumbs = list.some((a) => lacksThumbnail(a, have));
  if (missingThumbs && (await ctx.addMissingThumbnails(list))) ctx.emit('adjuntos');
}
