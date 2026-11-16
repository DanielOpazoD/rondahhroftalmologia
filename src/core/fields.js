/**
 * Rutas de los campos de un registro (atención o ficha): `f.<campo>`,
 * `checks.<casilla>`, `cat`, `pacienteId` y `proc.<id>.<parte>`. Las usan la
 * fusión campo a campo (merge.js) y la bitácora (audit.js); por eso viven en
 * su propio módulo, sin depender de ninguno de los dos.
 */
import { MEDIDAS_PROC } from '../specialties/activa/config.js';

/** @typedef {import('../domain').RegistroFusionable} RegistroFusionable */
/** Valor de una ruta: texto, o `true` para una casilla marcada. @typedef {string | true} ValorRuta */

/**
 * Partes de un procedimiento realizado: el lado (`eye`), las medidas por lado de la especialidad y
 * la descripción por ojo (`desc_od`, `desc_oi`). `desc` (una sola, de la 2.18.0) se sigue leyendo.
 */
const PROC_KEYS = ['eye', ...MEDIDAS_PROC, 'desc_od', 'desc_oi', 'desc'];

/**
 * Claves aceptadas para campos, casillas e ids de procedimiento. Los datos
 * pueden venir de otros equipos o de respaldos: se rechazan claves como
 * `__proto__`/`constructor`/`prototype` (contaminación de prototipos).
 */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
/** @type {(k: unknown) => k is string} */
export const isSafeKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k) && !FORBIDDEN.has(k);

/** ¿Tiene valor? (ni vacío, ni null, ni undefined) @param {unknown} v */
const present = (v) => v !== undefined && v !== null && v !== '';

/**
 * Valores presentes de la atención como mapa ruta -> valor (vacíos y `false` se omiten).
 * @param {RegistroFusionable | null | undefined} rec
 * @returns {Map<string, ValorRuta>}
 */
export function flatten(rec) {
  /** @type {Map<string, ValorRuta>} */
  const m = new Map();
  for (const [k, v] of Object.entries(rec?.f || {})) if (isSafeKey(k) && present(v)) m.set('f.' + k, String(v));
  for (const [k, v] of Object.entries(rec?.checks || {})) if (isSafeKey(k) && v) m.set('checks.' + k, true);
  if (rec?.cat) m.set('cat', String(rec.cat));
  if (rec?.pacienteId) m.set('pacienteId', String(rec.pacienteId));
  flattenProc(m, rec?.proc);
  return m;
}

/**
 * Agrega al mapa las partes presentes de cada procedimiento (`eye` y las medidas de la especialidad).
 * @param {Map<string, ValorRuta>} m
 * @param {RegistroFusionable['proc']} proc
 */
function flattenProc(m, proc) {
  for (const [id, p] of /** @type {[string, Record<string, unknown>][]} */ (Object.entries(proc || {}))) {
    if (!isSafeKey(id) || !p || typeof p !== 'object') continue;
    for (const k of PROC_KEYS) if (present(p[k])) m.set(`proc.${id}.${k}`, String(p[k]));
  }
}

/**
 * Reconstruye f / checks / cat / proc desde un mapa ruta -> valor.
 * @param {Map<string, ValorRuta>} m
 */
export function unflatten(m) {
  /** @type {{f: Record<string, string>, checks: Record<string, boolean>, cat: string, pacienteId?: string, proc: Record<string, import('../domain').ProcRealizado>}} */
  const out = { f: {}, checks: {}, cat: '', proc: {} };
  for (const [path, v] of m) {
    if (path.startsWith('f.')) {
      const k = path.slice(2);
      if (isSafeKey(k)) out.f[k] = /** @type {string} */ (v);
    } else if (path.startsWith('checks.')) {
      const k = path.slice(7);
      if (isSafeKey(k)) out.checks[k] = true;
    } else if (path === 'cat') out.cat = /** @type {string} */ (v);
    else if (path === 'pacienteId') out.pacienteId = /** @type {string} */ (v);
    else if (path.startsWith('proc.')) {
      const rest = path.slice(5);
      const dot = rest.lastIndexOf('.');
      const id = rest.slice(0, dot);
      const key = rest.slice(dot + 1);
      if (!isSafeKey(id) || !PROC_KEYS.includes(key)) continue;
      // Se arma por partes: el que quede sin `eye` se descarta abajo.
      if (!Object.hasOwn(out.proc, id)) out.proc[id] = /** @type {import('../domain').ProcRealizado} */ ({});
      /** @type {Record<string, string>} */ (out.proc[id])[key] = /** @type {string} */ (v);
    }
  }
  // Un procedimiento sin ojo no existe (p. ej. se quitó el ojo pero quedó una PIO).
  for (const [id, p] of Object.entries(out.proc)) if (!p.eye) delete out.proc[id];
  return out;
}
