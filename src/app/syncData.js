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

/** Ids que viajan opacos en el espacio de la especialidad: perfiles (huella del RUT). Ver ADR 0005. */
export const opaqueInSpecialty = (id) => id.startsWith('m_');

const wrap = (kind) => (x) => ({ id: x.id, updated: x.updated, kind, data: x });
/** Elemento sincronizado -> documento local (con id y versión del elemento). */
const unwrap = (i) => ({ ...i.data, id: i.id, updated: i.updated });

/** Fichas de pacientes para sincronizar. */
export function readPatientItems(store) {
  return { items: store.loadPatients().map(wrap('paciente')), tombstones: {} };
}

/** Guarda las fichas recibidas o fusionadas. */
export function writePatientItems(store, items) {
  store.savePatients(items.filter((i) => i.kind === 'paciente').map(unwrap));
}

/** Todo lo de la especialidad que se sincroniza. */
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
    ],
    tombstones: store.loadTombstones(),
  };
}

/** Guarda lo recibido o fusionado de la especialidad (atenciones, bitácora, catálogos y lápidas). */
export function writeSpecialtyItems(store, items, tombstones) {
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
  store.saveTombstones(tombstones);
}
