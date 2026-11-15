/**
 * Registro de accesos (ADR 0014): convierte los eventos y sesiones que
 * entrega el servidor en filas legibles. Puro: los nombres de personas y de
 * pacientes los resuelve quien llama (el servidor solo guarda ids).
 */

/** Qué significa cada evento y a qué grupo pertenece. */
export const EVENT_INFO = Object.freeze({
  'sesion.inicio': { label: 'Inició sesión', group: 'sesiones' },
  'sesion.inicio_local': { label: 'Inició sesión sin conexión', group: 'sesiones' },
  'sesion.fin': { label: 'Cerró sesión', group: 'sesiones' },
  'sesion.fin_local': { label: 'Cerró sesión (sin conexión)', group: 'sesiones' },
  'sesion.fallida': { label: 'Intento de ingreso fallido', group: 'sesiones' },
  'sesion.bloqueada': { label: 'Cuenta bloqueada por intentos', group: 'sesiones' },
  'sesion.clave': { label: 'Cambió su clave', group: 'sesiones' },
  'sesion.bloqueo': { label: 'Bloqueó la pantalla', group: 'sesiones' },
  'sesion.desbloqueo': { label: 'Desbloqueó la pantalla', group: 'sesiones' },
  'ficha.ver': { label: 'Abrió la ficha', group: 'lecturas' },
  'atencion.ver': { label: 'Abrió la atención', group: 'lecturas' },
  'atencion.pdf': { label: 'Descargó el PDF', group: 'lecturas' },
  'atencion.nota': { label: 'Copió la nota', group: 'lecturas' },
  'adjunto.ver': { label: 'Abrió un adjunto', group: 'lecturas' },
  'exportar.excel': { label: 'Exportó la estadística (Excel)', group: 'lecturas' },
  'exportar.pdfs': { label: 'Descargó los PDF del operativo', group: 'lecturas' },
  'exportar.seudonimizado': { label: 'Exportó datos seudonimizados', group: 'lecturas' },
  'exportar.correspondencia': { label: 'Descargó la tabla de correspondencia (identifica pacientes)', group: 'lecturas' },
  'respaldo.descargar': { label: 'Descargó un respaldo', group: 'lecturas' },
  'respaldo.importar': { label: 'Importó un respaldo', group: 'escrituras' },
  'sync.escribir': { label: 'Guardó cambios', group: 'escrituras' },
  'usuario.crear': { label: 'Creó una cuenta', group: 'administracion' },
  'usuario.editar': { label: 'Editó una cuenta', group: 'administracion' },
  'usuario.restablecer': { label: 'Restableció una clave', group: 'administracion' },
  'cuentas.activar': { label: 'Activó las cuentas de usuario', group: 'administracion' },
  'auditoria.ver': { label: 'Consultó el registro de accesos', group: 'administracion' },
});

export const GROUPS = Object.freeze([
  { key: '', label: 'Todo' },
  { key: 'sesiones', label: 'Sesiones' },
  { key: 'lecturas', label: 'Lecturas y descargas' },
  { key: 'escrituras', label: 'Cambios guardados' },
  { key: 'administracion', label: 'Administración' },
]);

/**
 * @typedef {{t: number, ev: string, u?: string, s?: string, obj?: string, n?: number, esp?: string, at?: number, off?: boolean, det?: Record<string, unknown>}} EventoAcceso
 * @typedef {{id: string, uid: string, inicio: number, ultimo: number, exp: number, fin?: number, motivo?: string}} SesionAcceso
 */

/** @param {string} ev */
const info = (ev) => /** @type {Record<string, {label: string, group: string}>} */ (EVENT_INFO)[ev] || { label: ev, group: '' };

/**
 * Filas de eventos, de la más reciente a la más antigua.
 * @param {EventoAcceso[]} eventos
 * @param {{userName: (uid: string | undefined) => string, objectLabel: (e: EventoAcceso) => string,
 *   group?: string, uid?: string, query?: (text: string) => boolean}} o
 */
export function eventRows(eventos, { userName, objectLabel, group = '', uid = '', query }) {
  return eventos
    .filter((e) => (!group || info(e.ev).group === group) && (!uid || e.u === uid))
    .map((e) => {
      const detail = [objectLabel(e), e.n !== undefined && e.ev === 'sync.escribir' ? `${e.n} ${e.n === 1 ? 'elemento' : 'elementos'}` : '']
        .filter(Boolean)
        .join(' · ');
      return {
        t: e.t,
        persona: e.u ? userName(e.u) : e.ev === 'cuentas.activar' ? 'Contraseña del equipo' : 'Desconocido',
        accion: info(e.ev).label,
        grupo: info(e.ev).group,
        detalle: detail,
        // Lo ocurrido sin conexión llega después: se indica con la hora del PC.
        origen: e.off ? `sin conexión${e.at ? ` (hora del PC: ${new Date(e.at).toLocaleString('es-CL')})` : ''}` : '',
      };
    })
    .filter((r) => !query || query(`${r.persona} ${r.accion} ${r.detalle}`))
    .sort((a, b) => b.t - a.t);
}

/**
 * Filas de sesiones con su duración.
 * @param {SesionAcceso[]} sesiones
 * @param {{userName: (uid: string) => string, uid?: string, now?: number}} o
 */
export function sessionRows(sesiones, { userName, uid = '', now = Date.now() }) {
  const MOTIVOS = /** @type {Record<string, string>} */ ({
    salir: 'cerró sesión',
    inactividad: 'por inactividad',
    cierre: 'cerró la app',
    cuenta_desactivada: 'cuenta desactivada',
    clave_restablecida: 'clave restablecida',
  });
  return sesiones
    .filter((s) => !uid || s.uid === uid)
    .map((s) => {
      const end = s.fin || Math.min(s.ultimo || s.inicio, s.exp || Infinity);
      const estado = s.fin ? MOTIVOS[s.motivo || ''] || 'cerrada' : (s.exp || 0) < now ? 'venció (último uso)' : 'abierta (último uso)';
      return {
        inicio: s.inicio,
        fin: end,
        duracionMin: Math.max(0, Math.round((end - s.inicio) / 60_000)),
        persona: userName(s.uid),
        estado,
      };
    })
    .sort((a, b) => b.inicio - a.inicio);
}

/** «1 h 25 min» / «8 min». @param {number} min */
export function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}
