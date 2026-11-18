/**
 * Utilidades de interfaz: selección de elementos, avisos, descargas y portapapeles.
 */

/**
 * Tipo del elemento que devuelve un selector:
 * - `'#id'` de la plantilla → el tipo de ese elemento (un `<input>` da
 *   HTMLInputElement; ver elements.d.ts, que se genera desde src/index.html);
 * - el nombre de una etiqueta (`'nav'`, `'select'`) → el de esa etiqueta;
 * - cualquier otro selector → HTMLElement.
 * @template {string} S
 * @typedef {S extends keyof ElementosPorId ? ElementosPorId[S]
 *   : S extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[S]
 *   : HTMLElement} ElementoDe
 */
/** @typedef {import('./elements').ElementosPorId} ElementosPorId */

/**
 * Busca un elemento que la interfaz sabe que existe: los ids que se buscan
 * con `$('#…')` están en la plantilla (lo verifica tests/build.test.js). El
 * tipo sale del selector (ver ElementoDe).
 * @template {string} S
 * @param {S} sel selector CSS
 * @param {ParentNode} [root]
 * @returns {ElementoDe<S>}
 */
export const $ = (sel, root = document) => /** @type {ElementoDe<S>} */ (root.querySelector(sel));
/**
 * Busca todos los elementos (como arreglo), con el tipo que da el selector (ver ElementoDe).
 * @template {string} S
 * @param {S} sel selector CSS
 * @param {ParentNode} [root]
 * @returns {ElementoDe<S>[]}
 */
export const $$ = (sel, root = document) => /** @type {ElementoDe<S>[]} */ ([...root.querySelectorAll(sel)]);

/**
 * Valor que siempre existe en este punto (un elemento de la plantilla, un
 * servicio que main.js asigna al arrancar…). Si falta, es un error de
 * programación: falla aquí con un mensaje claro, no con un «null» más adelante.
 * @template T
 * @param {T | null | undefined} value
 * @param {string} what qué faltaba (para el mensaje)
 * @returns {T}
 */
export function required(value, what) {
  if (value === null || value === undefined) throw new Error(`Falta ${what}`);
  return value;
}

/**
 * Atributo `data-*` que la propia interfaz pone al dibujar el elemento.
 * @param {HTMLElement} el
 * @param {string} key nombre como en `dataset` (camelCase)
 * @returns {string}
 */
export const dataOf = (el, key) => required(el.dataset[key], `data-${key} en <${el.tagName.toLowerCase()}>`);

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/**
 * Mensaje breve en la parte inferior de la pantalla.
 * @param {string} message
 * @param {number} [ms] duración en milisegundos
 */
export function toast(message, ms = 2200) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/**
 * Aviso de error: queda a la vista hasta que la persona lo cierra (no se pierde
 * si mira a otro lado, como el mensaje breve) y se anuncia como alerta. Va en
 * la capa superior (`popover`): un diálogo abierto no lo tapa. Un error nuevo
 * reemplaza el texto del anterior.
 * @param {string} message
 */
export function errorToast(message) {
  const box = $('#errToast');
  $('#errToastText').textContent = message;
  if (!box.hidden) return;
  // Al cerrarlo, el foco vuelve a donde estaba (si no, queda en la página).
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = () => {
    const hadFocus = box.contains(document.activeElement);
    box.classList.remove('on');
    if (box.matches(':popover-open')) box.hidePopover();
    box.hidden = true;
    box.removeEventListener('keydown', onKey);
    if (hadFocus && before?.isConnected) before.focus();
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // que no cierre también el diálogo de abajo
      close();
    }
  };
  box.hidden = false;
  box.showPopover?.();
  box.classList.add('on');
  box.addEventListener('keydown', onKey);
  $('#errToastClose').addEventListener('click', close, { once: true });
}

/**
 * Descarga un contenido como archivo.
 * @param {Blob | string | Uint8Array} data
 * @param {string} fileName
 * @param {string} [mime] tipo MIME (si `data` no es ya un Blob)
 */
export function download(data, fileName, mime) {
  // En el modo práctica, los archivos se distinguen de los reales.
  const filename = document.body.classList.contains('practice') ? 'PRACTICA_' + fileName : fileName;
  // Los bytes vienen de un ArrayBuffer normal (nunca compartido): son un BlobPart válido.
  const blob = data instanceof Blob ? data : new Blob([/** @type {BlobPart} */ (data)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Copia texto al portapapeles, con alternativa para navegadores antiguos o file://.
 * @param {string} text
 * @returns {Promise<boolean>} true si se copió
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    /** @type {boolean} */
    let ok;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/**
 * Decodifica base64 a bytes.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Cede el control al navegador (para que se actualice la interfaz en procesos largos).
 * @returns {Promise<void>}
 */
export const nextFrame = () => new Promise((r) => setTimeout(r, 0));
