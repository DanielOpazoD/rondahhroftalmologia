/**
 * Bitácora de auditoría de las atenciones.
 *
 * Cada guardado o eliminación agrega una entrada inmutable:
 *   { id, at, tipo, equipo, equipoId, cambios: [{c: ruta, a: antes, d: después}] }
 * `at` es la hora del reloj lógico; `equipo` el nombre del PC (Ajustes).
 *
 * Las entradas de una atención se agrupan en un documento `b_<idAtención>` que
 * se sincroniza cifrado como cualquier otro dato. Dos equipos que agregan
 * entradas a la vez se fusionan por UNIÓN (nunca se pierde una entrada).
 */
import { flatten } from './fields.js';
import { ANTECEDENTES, SOLICITADOS, DIAGNOSTICOS, ETIQUETAS, ETIQUETAS_PROC } from '../specialties/activa/config.js';

const CHECK_LABELS = Object.fromEntries([
  ...ANTECEDENTES.map((d) => [d.key, 'Antecedente ' + d.label]),
  ...SOLICITADOS.map((d) => [d.key, 'Solicitado ' + d.label]),
  ...DIAGNOSTICOS.map((d) => [d.key, 'Dx ' + d.label]),
]);

/**
 * Nombre legible de una ruta de campo.
 * @param {string} path p. ej. 'f.od_pio', 'checks.diagnostico_rdp', 'proc.t_aplan.od'
 * @param {{id: string, n: string}[]} [procs]
 */
export function auditLabel(path, procs = []) {
  if (path.startsWith('f.')) return /** @type {Record<string, string>} */ (ETIQUETAS)[path.slice(2)] || path.slice(2);
  if (path.startsWith('checks.')) return CHECK_LABELS[path.slice(7)] || path.slice(7);
  if (path === 'cat') return 'Catarata (ojo)';
  if (path === 'pacienteId') return 'Paciente (vínculo)';
  if (path.startsWith('adjunto.')) return 'Adjunto';
  if (path.startsWith('proc.')) {
    const rest = path.slice(5);
    const dot = rest.lastIndexOf('.');
    const id = rest.slice(0, dot);
    const name = procs.find((p) => p.id === id)?.n || id;
    const part = /** @type {Record<string, string>} */ (ETIQUETAS_PROC)[rest.slice(dot + 1)];
    return part ? `${name} ${part}` : name;
  }
  return path;
}

/**
 * Cambios entre dos versiones de una atención: [{c, a, d}] (a/d ausentes = vacío).
 * @param {import('../domain').RegistroFusionable | null | undefined} before
 * @param {import('../domain').RegistroFusionable | null | undefined} after
 * @returns {import('../domain').AuditChange[]}
 */
export function auditChanges(before, after) {
  const a = flatten(before || {});
  const b = flatten(after || {});
  const out = [];
  for (const c of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (a.get(c) === b.get(c)) continue;
    /** @type {import('../domain').AuditChange} */
    const item = { c };
    if (a.has(c)) item.a = a.get(c);
    if (b.has(c)) item.d = b.get(c);
    out.push(item);
  }
  return out;
}

/**
 * Crea una entrada de bitácora.
 * @param {{tipo: import('../domain').AuditEntry['tipo'], before?: import('../domain').RegistroFusionable, after?: import('../domain').RegistroFusionable, at: number,
 *   equipo: string, equipoId: string, autor?: string, autorId?: string, rand?: () => number}} o
 *   `autor`: nombre del perfil que registró (quién), además del equipo (desde dónde).
 * @returns {import('../domain').AuditEntry|null} null si una edición no cambió nada
 */
export function makeAuditEntry({ tipo, before, after, at, equipo, equipoId, autor, autorId, rand = Math.random }) {
  const cambios = tipo === 'eliminada' ? [] : auditChanges(before, after);
  if (tipo === 'editada' && !cambios.length) return null;
  return {
    id: 'e' + at.toString(36) + rand().toString(36).slice(2, 8),
    at,
    tipo,
    equipo: equipo || 'Equipo sin nombre',
    equipoId,
    ...(autor ? { autor: String(autor), autorId } : {}),
    cambios,
  };
}

/**
 * Entrada de bitácora por agregar o eliminar un adjunto (campo `adjunto.<id>`,
 * con su nombre como valor nuevo o anterior).
 * @param {{id: string, nombre: string, added: boolean, at: number, equipo: string, equipoId: string,
 *   autor?: string, autorId?: string, rand?: () => number}} o
 * @returns {import('../domain').AuditEntry}
 */
export function attachmentAuditEntry({ id, nombre, added, at, equipo, equipoId, autor, autorId, rand = Math.random }) {
  return {
    id: 'e' + at.toString(36) + rand().toString(36).slice(2, 8),
    at,
    tipo: 'editada',
    equipo: equipo || 'Equipo sin nombre',
    equipoId,
    ...(autor ? { autor: String(autor), autorId } : {}),
    cambios: [added ? { c: 'adjunto.' + id, d: nombre } : { c: 'adjunto.' + id, a: nombre }],
  };
}

/** Ventana para juntar ediciones seguidas de la misma persona en una sola entrada. */
export const COALESCE_MS = 10 * 60_000;

/**
 * Agrega una entrada a la bitácora. Con el guardado automático, cada pausa al
 * escribir es un guardado: las ediciones seguidas (misma persona y equipo,
 * menos de COALESCE_MS desde la anterior) se JUNTAN en la última entrada, que
 * conserva el valor anterior de cada campo y toma el nuevo, y anota `hasta`.
 * Así el historial dice «editó X de A a B», no 20 pasos intermedios.
 * @param {import('../domain').AuditEntry[]} entries
 * @param {import('../domain').AuditEntry} entry
 * @returns {import('../domain').AuditEntry[]}
 */
export function appendAuditEntry(entries, entry, coalesceMs = COALESCE_MS) {
  const last = entries.at(-1);
  const sameHand =
    last &&
    entry.tipo === 'editada' &&
    last.tipo === 'editada' &&
    last.equipoId === entry.equipoId &&
    (last.autorId || '') === (entry.autorId || '') &&
    entry.at >= last.at &&
    entry.at - (last.hasta || last.at) <= coalesceMs;
  if (!last || !sameHand) return [...entries, entry];
  /** @type {Map<string, import('../domain').AuditChange>} */
  const byField = new Map(last.cambios.map((c) => [c.c, { ...c }]));
  for (const c of entry.cambios) {
    const prev = byField.get(c.c);
    if (!prev) {
      byField.set(c.c, { ...c });
      continue;
    }
    if ('d' in c) prev.d = c.d;
    else delete prev.d;
  }
  // Un campo que volvió a su valor original ya no es un cambio.
  const cambios = [...byField.values()].filter((c) => c.a !== c.d).sort((x, y) => (x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  return [...entries.slice(0, -1), { ...last, hasta: entry.at, cambios }];
}

/**
 * Unión de dos documentos de bitácora de la misma atención (sin duplicar entradas).
 * @param {Partial<import('../domain').AuditDoc> | null | undefined} a
 * @param {Partial<import('../domain').AuditDoc> | null | undefined} b
 * @returns {import('../domain').AuditDoc}
 */
export function mergeAuditDocs(a, b) {
  /** @type {Map<string, import('../domain').AuditEntry>} */
  const byId = new Map();
  for (const e of [...(a?.entries || []), ...(b?.entries || [])]) {
    if (!e || typeof e.id !== 'string') continue;
    // Una entrada que se fue juntando (ver appendAuditEntry) tiene varias versiones: gana la más completa.
    const cur = byId.get(e.id);
    if (!cur || (e.hasta || e.at) >= (cur.hasta || cur.at)) byId.set(e.id, e);
  }
  const entries = [...byId.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
  // Los dos documentos son de la misma atención; si a ninguno le llega el id (dato dañado),
  // queda vacío: un id inválido que la sincronización y el respaldo descartan.
  return {
    id: a?.id || b?.id || '',
    atencionId: a?.atencionId || b?.atencionId || '',
    updated: Math.max(a?.updated || 0, b?.updated || 0),
    entries,
  };
}

/**
 * Texto breve de un valor para mostrar en el historial.
 * @param {unknown} v
 */
export function shortValue(v, max = 40) {
  if (v === undefined || v === null || v === '') return 'vacío';
  if (v === true) return 'sí';
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Resumen breve de los cambios que llegaron de otro equipo a la atención
 * abierta (para el aviso): «Plan: vacío → Lentes · PIO OD: 15 → 18 y 2 más».
 * @param {import('../domain').AuditChange[]} cambios
 * @param {{id: string, n: string}[]} [procs]
 */
export function changesSummary(cambios, procs = [], max = 3) {
  const shown = cambios.slice(0, max).map((c) => `${auditLabel(c.c, procs)}: ${shortValue(c.a, 24)} → ${shortValue(c.d, 24)}`);
  const more = cambios.length > max ? ` y ${cambios.length - max} más` : '';
  return shown.join(' · ') + more;
}
