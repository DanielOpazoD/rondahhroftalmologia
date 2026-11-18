/**
 * Utilidades de interfaz: selección de elementos, avisos, descargas y portapapeles.
 */

/**
 * Busca un elemento. Tipado como `any`: la interfaz accede a propiedades de
 * inputs/selects por id; los ids se verifican en tests/build.test.js.
 * @param {string} sel selector CSS
 * @param {ParentNode} [root]
 * @returns {any}
 */
export const $ = (sel, root = document) => root.querySelector(sel);
/**
 * Busca todos los elementos (como arreglo). `any` por la misma razón que `$`.
 * @param {string} sel selector CSS
 * @param {ParentNode} [root]
 * @returns {any[]}
 */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
 * si mira a otro lado, como el mensaje breve) y se anuncia como alerta.
 * @param {string} message
 */
export function errorToast(message) {
  const box = $('#errToast');
  $('#errToastText').textContent = message;
  if (box.hidden) {
    box.hidden = false;
    box.classList.add('on');
    $('#errToastClose').addEventListener(
      'click',
      () => {
        box.classList.remove('on');
        box.hidden = true;
      },
      { once: true },
    );
  }
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
