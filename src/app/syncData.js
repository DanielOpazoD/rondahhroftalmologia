/**
 * Correspondencia entre los datos locales y los elementos que se sincronizan
 * (sin DOM: recibe el `store`). La usa ui/syncController.js, que agrega lo
 * de interfaz (reloj lógico, recargar catálogos, re-dibujar).
 *
 * Espacios en el servidor:
 *   - `pacientes` (común a todas las especialidades): fichas de pacientes.
 *   - `<especialidad>`: atenciones (también las de versiones más nuevas, intactas),
 *     perfiles, operativos y bitácora; las eliminaciones viajan como lápidas.
 */
import { sortRecords } from '../core/record.js';
import { makeMedico, makeOperativo, byName } from '../core/catalog.js';

/** Documento local que se sincroniza (atención, ficha, perfil, operativo o bitácora). @typedef {{id: string, updated?: number}} Documento */
/** @typedef {import('../domain').ElementoSync} ElementoSync */
/**
 * Lo que esta capa usa del almacenamiento (ver storage/store.js).
 * @typedef {{
 *   loadPatients: () => Documento[], savePatients: (list: Documento[]) => void,
 *   loadRecords: () => Documento[], saveRecords: (list: Documento[]) => void, loadFutureRecords: () => Documento[],
 *   loadMedicos: () => Documento[], saveMedicos: (list: Documento[]) => void,
 *   loadOperativos: () => Documento[], saveOperativos: (list: Documento[]) => void,
 *   loadAuditDocs: () => Documento[], saveAuditDocs: (list: Documento[]) => void,
 *   loadTombstones: () => Record<string, number>, saveTombstones: (t: Record<string, number>) => void,
 *   loadAttachments: () => Documento[], saveAttachments: (list: Documento[]) => unknown, removeAttachment: (id: string) => void,
 * }} SyncStore
 */

/** Ids que viajan opacos en el espacio de la especialidad: perfiles (huella del RUT). Ver ADR 0005. */
export const opaqueInSpecialty = (/** @type {string} */ id) => id.startsWith('m_');

/** @type {(kind: import('../domain').TipoSync) => (x: Documento) => ElementoSync} */
const wrap = (kind) => (x) => ({ id: x.id, updated: x.updated, kind, data: x });
/** Elemento sincronizado -> documento local (con id y versión del elemento). @param {ElementoSync} i */
const unwrap = (i) => ({ ...i.data, id: i.id, updated: i.updated });

/**
 * Fichas de pacientes para sincronizar.
 * @param {SyncStore} store
 */
export function readPatientItems(store) {
  return { items: store.loadPatients().map(wrap('paciente')), tombstones: {} };
}

/**
 * Guarda las fichas recibidas o fusionadas.
 * @param {SyncStore} store
 * @param {ElementoSync[]} items
 */
export function writePatientItems(store, items) {
  store.savePatients(items.filter((i) => i.kind === 'paciente').map(unwrap));
}

/**
 * Todo lo de la especialidad que se sincroniza.
 * @param {SyncStore} store
 */
export function readSpecialtyItems(store) {
  return {
    items: [
      ...store
        .loadRecords()
        .filter((r) => r.updated)
        .map(wrap('atencion')),
      // Atenciones de versiones más nuevas de la app: se sincronizan intactas.
      ...store.loadFutureRecords().map(wrap('atencion')),
      ...store.loadMedicos().map(wrap('medico')),
      ...store.loadOperativos().map(wrap('operativo')),
      ...store.loadAuditDocs().map(wrap('bitacora')),
      ...store.loadAttachments().map(wrap('adjunto')),
    ],
    tombstones: store.loadTombstones(),
  };
}

/**
 * Guarda lo recibido o fusionado de la especialidad (atenciones, bitácora, catálogos y lápidas).
 * @param {SyncStore} store
 * @param {ElementoSync[]} items
 * @param {Record<string, number>} tombstones
 */
export function writeSpecialtyItems(store, items, tombstones) {
  /** @param {import('../domain').TipoSync} kind */
  const of = (kind) => items.filter((i) => i.kind === kind).map(unwrap);
  store.saveRecords(sortRecords(of('atencion')));
  store.saveAuditDocs(of('bitacora'));
  store.saveMedicos(
    byName(
      of('medico')
        .map((m) => makeMedico(m))
        .filter(Boolean),
    ),
  );
  store.saveOperativos(
    byName(
      of('operativo')
        .map((o) => makeOperativo(o))
        .filter(Boolean),
    ),
  );
  // Adjuntos: los recibidos se agregan; los eliminados en otro equipo (lápida) se quitan.
  store.saveAttachments(of('adjunto'));
  const live = new Set(items.filter((i) => i.kind === 'adjunto').map((i) => i.id));
  for (const a of store.loadAttachments()) if (!live.has(a.id) && tombstones[a.id]) store.removeAttachment(a.id);
  store.saveTombstones(tombstones);
}
