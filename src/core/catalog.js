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
import { hmacSha256 } from '../lib/sha256.js';
import { normalizeText, rutKey, formatRut } from './format.js';
import { isValidId } from './record.js';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const shortHash = (s) => Array.from(hmacSha256('catalogo', s).slice(0, 8), (b) => B32[b & 31]).join('');

/** Id estable de un perfil de médico: por RUT si existe, si no por nombre. */
export function medicoId(nombre, rut) {
  const k = rutKey(rut);
  return 'm_' + shortHash(k ? 'rut:' + k : 'nombre:' + normalizeText(nombre));
}

/** Id estable de un operativo, por nombre. */
export function operativoId(nombre) {
  return 'o_' + shortHash(normalizeText(nombre));
}

/** @typedef {{id: string, nombre: string, rut: string, created: number, updated: number}} Medico */
/** @typedef {{id: string, nombre: string, created: number, updated: number}} Operativo */

/**
 * Crea o normaliza un perfil de médico; null si no es válido.
 * @param {{nombre?: string, rut?: string, id?: string, created?: number, updated?: number}} [m]
 * @param {number} [now]
 * @returns {Medico|null}
 */
export function makeMedico({ nombre, rut = '', id, created, updated } = {}, now = Date.now()) {
  const n = String(nombre ?? '').trim();
  if (!n) return null;
  const r = String(rut ?? '').trim() ? formatRut(rut) : '';
  const mid = isValidId(id) ? id : medicoId(n, r);
  return { id: mid, nombre: n, rut: r, created: created || now, updated: updated || now };
}

/**
 * Crea o normaliza un operativo; null si no es válido.
 * @param {{nombre?: string, id?: string, created?: number, updated?: number}} [o]
 * @param {number} [now]
 * @returns {Operativo|null}
 */
export function makeOperativo({ nombre, id, created, updated } = {}, now = Date.now()) {
  const n = String(nombre ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return null;
  return { id: isValidId(id) ? id : operativoId(n), nombre: n, created: created || now, updated: updated || now };
}

/** Ordena por nombre (es-CL, sin importar tildes). */
export function byName(list) {
  return [...list].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
}

/** Agrega o reemplaza por id. */
export function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  const out = [...list];
  if (i >= 0) out[i] = { ...item, created: list[i].created || item.created };
  else out.push(item);
  return out;
}

/**
 * Siembra los catálogos a partir de atenciones ya guardadas y del último
 * médico/operativo recordado (migración desde versiones sin catálogos).
 * Solo agrega lo que falta; no modifica entradas existentes.
 * @param {{records?: object[], recordado?: {n?: string, r?: string, op?: string}, medicos?: Medico[], operativos?: Operativo[]}} input
 * @param {number} [now]
 * @returns {{medicos: Medico[], operativos: Operativo[], added: number}}
 */
export function seedCatalogs({ records = [], recordado = {}, medicos = [], operativos = [] }, now = Date.now()) {
  const meds = [...medicos];
  const ops = [...operativos];
  let added = 0;
  const addMed = (nombre, rut) => {
    const m = makeMedico({ nombre, rut }, now);
    if (m && !meds.some((x) => x.id === m.id)) {
      meds.push(m);
      added++;
    }
  };
  const addOp = (nombre) => {
    const o = makeOperativo({ nombre }, now);
    if (o && !ops.some((x) => x.id === o.id)) {
      ops.push(o);
      added++;
    }
  };
  for (const r of records) {
    addMed(r.f?.medico_nombre, r.f?.medico_rut);
    addOp(r.f?.operativo);
  }
  addMed(recordado.n, recordado.r);
  addOp(recordado.op);
  return { medicos: byName(meds), operativos: byName(ops), added };
}

/** Perfil que corresponde a los datos de médico de una atención (por RUT o nombre). */
export function findMedico(medicos, nombre, rut) {
  const k = rutKey(rut);
  if (k) {
    const byRut = medicos.find((m) => rutKey(m.rut) === k);
    if (byRut) return byRut;
  }
  const n = normalizeText(nombre);
  return n ? medicos.find((m) => normalizeText(m.nombre) === n) : undefined;
}
