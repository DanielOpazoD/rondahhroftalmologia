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
import { flatten } from './merge.js';
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
  if (path.startsWith('f.')) return ETIQUETAS[path.slice(2)] || path.slice(2);
  if (path.startsWith('checks.')) return CHECK_LABELS[path.slice(7)] || path.slice(7);
  if (path === 'cat') return 'Catarata (ojo)';
  if (path === 'pacienteId') return 'Paciente (vínculo)';
  if (path.startsWith('proc.')) {
    const rest = path.slice(5);
    const dot = rest.lastIndexOf('.');
    const id = rest.slice(0, dot);
    const name = procs.find((p) => p.id === id)?.n || id;
    const part = ETIQUETAS_PROC[rest.slice(dot + 1)];
    return part ? `${name} ${part}` : name;
  }
  return path;
}

/** Cambios entre dos versiones de una atención: [{c, a, d}] (a/d ausentes = vacío). */
export function auditChanges(before, after) {
  const a = flatten(before || {});
  const b = flatten(after || {});
  const out = [];
  for (const c of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (a.get(c) === b.get(c)) continue;
    const item = { c };
    if (a.has(c)) item.a = a.get(c);
    if (b.has(c)) item.d = b.get(c);
    out.push(item);
  }
  return out;
}

/**
 * Crea una entrada de bitácora.
 * @param {{tipo: 'ingresada'|'creada'|'editada'|'eliminada', before?: object, after?: object, at: number,
 *   equipo: string, equipoId: string, rand?: () => number}} o
 * @returns {object|null} null si una edición no cambió nada
 */
export function makeAuditEntry({ tipo, before, after, at, equipo, equipoId, rand = Math.random }) {
  const cambios = tipo === 'eliminada' ? [] : auditChanges(before, after);
  if (tipo === 'editada' && !cambios.length) return null;
  return {
    id: 'e' + at.toString(36) + rand().toString(36).slice(2, 8),
    at,
    tipo,
    equipo: equipo || 'Equipo sin nombre',
    equipoId,
    cambios,
  };
}

/** Unión de dos documentos de bitácora de la misma atención (sin duplicar entradas). */
export function mergeAuditDocs(a, b) {
  const byId = new Map();
  for (const e of [...(a?.entries || []), ...(b?.entries || [])]) if (e && typeof e.id === 'string') byId.set(e.id, e);
  const entries = [...byId.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
  return { id: a?.id || b?.id, atencionId: a?.atencionId || b?.atencionId, updated: Math.max(a?.updated || 0, b?.updated || 0), entries };
}

/** Texto breve de un valor para mostrar en el historial. */
export function shortValue(v, max = 40) {
  if (v === undefined || v === null || v === '') return 'vacío';
  if (v === true) return 'sí';
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
