/**
 * Catálogos compartidos entre equipos: perfiles de médico y operativos.
 *
 * Se sincronizan por el servidor (cifrados, igual que las atenciones) y se
 * ofrecen como menú en el formulario. La atención guarda una copia del nombre
 * y RUT del médico y del nombre del operativo: si después se edita o elimina
 * un perfil, las atenciones ya guardadas (y sus PDF/Excel) no cambian.
 *
 * Los ids son deterministas (derivados del RUT o del nombre), así dos equipos
 * que crean el mismo médico u operativo por separado no generan duplicados.
 */
import { nameParts, personName } from './names.js';
import { hmacSha256 } from '../lib/sha256.js';
import { normalizeText, rutKey, formatRut, compareEs } from './format.js';
import { isValidId } from './record.js';
import { ROLES } from '../config/catalogs.js';
import { unknownFields } from './compat.js';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
/** @param {string} s */
const shortHash = (s) => Array.from(hmacSha256('catalogo', s).slice(0, 8), (b) => B32[b & 31]).join('');

/**
 * Id estable de un perfil de médico: por RUT si existe, si no por nombre.
 * @param {unknown} nombre
 * @param {unknown} rut
 */
export function medicoId(nombre, rut) {
  const k = rutKey(rut);
  return 'm_' + shortHash(k ? 'rut:' + k : 'nombre:' + normalizeText(nombre));
}

/**
 * Id estable de un operativo, por nombre.
 * @param {unknown} nombre
 */
export function operativoId(nombre) {
  return 'o_' + shortHash(normalizeText(nombre));
}

/**
 * Perfil profesional (por compatibilidad se llama «médico» en el código y en
 * la sincronización; `rol` dice qué es: médico, enfermería, TENS…).
 * @typedef {import('../domain').Perfil} Medico
 */
/** @typedef {import('../domain').Operativo} Operativo */

/**
 * Crea o normaliza un perfil de médico; null si no es válido.
 * Los perfiles de versiones anteriores (sin `rol`) son médicos.
 * @param {{nombre?: string, apellido_paterno?: string, apellido_materno?: string, nombres?: string, rut?: string, rol?: string, id?: string, created?: number, updated?: number}} [m]
 * @param {number} [now]
 * @returns {Medico|null}
 */
export function makeMedico(m = {}, now = Date.now()) {
  const { rut = '', rol, id, created, updated } = m;
  const n = personName(m);
  if (!n) return null;
  const r = String(rut ?? '').trim() ? formatRut(rut) : '';
  const mid = isValidId(id) ? id : medicoId(n, r);
  // Sin rol (perfiles anteriores a los roles) = médico. Un rol que esta versión
  // no conoce (agregado por una versión más nueva) se conserva tal cual, y NO
  // se trata como médico.
  const role = rol === undefined || rol === null || rol === '' ? 'medico' : isRoleKey(rol) ? rol : 'otro';
  return {
    ...unknownFields(m, MEDICO_FIELDS),
    id: mid,
    nombre: n,
    ...nameParts(m),
    rut: r,
    rol: role,
    created: created || now,
    updated: updated || now,
  };
}
const MEDICO_FIELDS = ['id', 'nombre', 'rut', 'rol', 'created', 'updated'];
/** Clave de rol con forma válida (conocida o de una versión más nueva). */
/** @type {(r: unknown) => r is string} */
const isRoleKey = (r) => typeof r === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(r);

/** Etiqueta del rol de un perfil. */
/** @param {string | null | undefined} rol */
export const rolLabel = (rol) => (!rol ? 'Médico/a' : ROLES.find((x) => x.key === rol)?.label || 'Otro');

/** Solo los perfiles que pueden ser médico responsable de una atención. */
/** @type {(list: Medico[]) => Medico[]} */
export const onlyDoctors = (list) => list.filter((m) => (m.rol || 'medico') === 'medico');

/**
 * Crea o normaliza un operativo; null si no es válido.
 * @param {{nombre?: string, id?: string, created?: number, updated?: number}} [o]
 * @param {number} [now]
 * @returns {Operativo|null}
 */
export function makeOperativo(o = {}, now = Date.now()) {
  const { nombre, id, created, updated } = o;
  const n = String(nombre ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return null;
  return {
    ...unknownFields(o, ['id', 'nombre', 'created', 'updated']),
    id: isValidId(id) ? id : operativoId(n),
    nombre: n,
    created: created || now,
    updated: updated || now,
  };
}

/**
 * Ordena por nombre (es-CL, sin importar tildes).
 * @template {{nombre: string}} T
 * @param {T[]} list
 * @returns {T[]}
 */
export function byName(list) {
  return [...list].sort((a, b) => compareEs(a.nombre, b.nombre));
}

/**
 * Agrega o reemplaza por id.
 * @template {{id: string, created?: number}} T
 * @param {T[]} list
 * @param {T} item
 * @returns {T[]}
 */
export function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  const out = [...list];
  if (i >= 0) out[i] = { ...item, created: list[i].created || item.created };
  else out.push(item);
  return out;
}

/**
 * Médicos (nombre y RUT) y operativos distintos que aparecen en las
 * atenciones, en el orden en que aparecen por primera vez.
 * @param {import('../domain').RegistroFusionable[]} records
 */
function distinctOrigins(records) {
  /** @type {Map<string, [string | undefined, string | undefined]>} */
  const meds = new Map();
  /** @type {Set<string | undefined>} */
  const ops = new Set();
  for (const r of records) {
    const f = r.f || {};
    const key = `${f.medico_nombre ?? ''}\u0000${f.medico_rut ?? ''}`;
    if (!meds.has(key)) meds.set(key, [f.medico_nombre, f.medico_rut]);
    ops.add(f.operativo);
  }
  return { meds: [...meds.values()], ops: [...ops] };
}

/**
 * Agrega al catálogo una entrada nueva (si `entry` existe y su id no está).
 * @template {{id: string}} T
 * @param {T[]} list
 * @param {T | null} entry
 * @returns {number} 1 si se agregó, 0 si no
 */
function addMissing(list, entry) {
  if (!entry || list.some((x) => x.id === entry.id)) return 0;
  list.push(entry);
  return 1;
}

/**
 * Siembra los catálogos a partir de atenciones ya guardadas y del último
 * médico/operativo recordado (migración desde versiones sin catálogos).
 * Solo agrega lo que falta; no modifica entradas existentes.
 * @param {{records?: import('../domain').RegistroFusionable[], recordado?: {n?: string, r?: string, op?: string}, medicos?: Medico[], operativos?: Operativo[]}} input
 * @param {number} [now]
 * @returns {{medicos: Medico[], operativos: Operativo[], added: number}}
 */
export function seedCatalogs({ records = [], recordado = {}, medicos = [], operativos = [] }, now = Date.now()) {
  const meds = [...medicos];
  const ops = [...operativos];
  const seen = distinctOrigins(records);
  let added = 0;
  // Las atenciones antiguas pueden no traer médico ni operativo: makeMedico/makeOperativo devuelven null.
  for (const [nombre, rut] of [...seen.meds, [recordado.n, recordado.r]]) added += addMissing(meds, makeMedico({ nombre, rut }, now));
  for (const nombre of [...seen.ops, recordado.op]) added += addMissing(ops, makeOperativo({ nombre }, now));
  return { medicos: byName(meds), operativos: byName(ops), added };
}

/**
 * Perfil que corresponde a los datos de médico de una atención (por RUT o nombre).
 * @param {Medico[]} medicos
 * @param {unknown} nombre
 * @param {unknown} rut
 * @returns {Medico|undefined}
 */
export function findMedico(medicos, nombre, rut) {
  const k = rutKey(rut);
  if (k) {
    const byRut = medicos.find((m) => rutKey(m.rut) === k);
    if (byRut) return byRut;
  }
  const n = normalizeText(nombre);
  return n ? medicos.find((m) => normalizeText(m.nombre) === n) : undefined;
}
