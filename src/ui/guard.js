/**
 * Pantallas que deben quedar SIEMPRE encima de cualquier otro diálogo
 * (bloqueo e ingreso): si se abre otro diálogo modal mientras una está activa,
 * esa pantalla se vuelve a abrir encima en el mismo instante.
 */
const nativeShowModal = HTMLDialogElement.prototype.showModal;
/** @type {{dlg: HTMLDialogElement, active: () => boolean, focus: () => void}[]} */
const guards = [];

HTMLDialogElement.prototype.showModal = function showModal() {
  nativeShowModal.call(this);
  for (const g of guards) {
    if (g.active() && this !== g.dlg) {
      g.dlg.close();
      nativeShowModal.call(g.dlg);
      g.focus();
    }
  }
};

/** Abre una pantalla protegida (sin volver a disparar la protección). @param {HTMLDialogElement} dlg */
export const showGuarded = (dlg) => nativeShowModal.call(dlg);

/**
 * Registra una pantalla protegida.
 * @param {HTMLDialogElement} dlg
 * @param {() => boolean} active ¿está activa ahora?
 * @param {() => void} focus a dónde va el foco al reabrirla
 */
export function addGuard(dlg, active, focus) {
  guards.push({ dlg, active, focus });
  dlg.addEventListener('cancel', (e) => active() && e.preventDefault()); // Escape no la cierra
  // Algunos navegadores cierran el diálogo con un segundo Escape: se reabre en el acto.
  dlg.addEventListener('close', () => {
    if (active() && !dlg.open) {
      nativeShowModal.call(dlg);
      focus();
    }
  });
}
