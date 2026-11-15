/**
 * Utilidades de interfaz: selección de elementos, avisos, descargas y portapapeles.
 */

/**
 * Busca un elemento. Tipado como `any`: la interfaz accede a propiedades de
 * inputs/selects por id; los ids se verifican en tests/build.test.js.
 * @returns {any}
 */
export const $ = (sel, root = document) => root.querySelector(sel);
/** @returns {any[]} */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
/** Mensaje breve en la parte inferior de la pantalla. */
export function toast(message, ms = 2200) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/** Descarga un contenido como archivo. */
export function download(data, fileName, mime) {
  // En el modo práctica, los archivos se distinguen de los reales.
  const filename = document.body.classList.contains('practice') ? 'PRACTICA_' + fileName : fileName;
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Copia texto al portapapeles, con alternativa para navegadores antiguos o file://. */
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

/** Decodifica base64 a bytes. */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Ejecuta una acción asíncrona deshabilitando el botón mientras corre y
 * mostrando el error al usuario si falla (nunca se pierde en silencio).
 */
export async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    // Import dinámico para no crear una dependencia circular dom ↔ modal.
    import('./modal.js').then(({ uiAlert }) =>
      uiAlert({ title: 'No se pudo completar la acción', message: String(e?.message || e), tone: 'danger' }),
    );
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/** Cede el control al navegador (para que se actualice la interfaz en procesos largos). */
export const nextFrame = () => new Promise((r) => setTimeout(r, 0));
