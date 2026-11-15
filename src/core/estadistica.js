/**
 * Estadística genérica (común a todas las especialidades): filtros, grupos
 * etarios y conteos. No conoce catálogos ni procedimientos: cada especialidad
 * arma sus agregados con estas piezas (p. ej. specialties/orl/estadistica.js).
 */
import { parseNumber } from './format.js';

/**
 * @typedef {{operativo?: string, desde?: string, hasta?: string}} RecordFilter
 * Fechas en ISO (YYYY-MM-DD), ambos extremos inclusive.
 */

/**
 * Aplica un filtro por operativo y rango de fechas.
 * @param {any[]} records
 * @param {RecordFilter} [filter]
 */
export function filterRecords(records, filter = {}) {
  const { operativo, desde, hasta } = filter;
  return records.filter((r) => {
    const fecha = r.f?.fecha_atencion || '';
    return (!operativo || r.f?.operativo === operativo) && (!desde || fecha >= desde) && (!hasta || fecha <= hasta);
  });
}

/**
 * Descripción legible del filtro, para títulos de reportes.
 * @param {RecordFilter} [filter]
 * @param {(iso: string) => string} [fmt]
 */
export function describeFilter(filter = {}, fmt = (x) => x) {
  const parts = [filter.operativo || 'Todos los operativos'];
  if (filter.desde || filter.hasta) parts.push(`${filter.desde ? fmt(filter.desde) : '…'} a ${filter.hasta ? fmt(filter.hasta) : '…'}`);
  return parts.join(' · ');
}

/**
 * Operativos distintos presentes en los registros, ordenados.
 * @param {any[]} records
 */
export function operativosOf(records) {
  return [...new Set(records.map((r) => (r.f?.operativo || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
}

/**
 * Edad como entero o null.
 * @param {any} rec
 */
export function ageOf(rec) {
  const n = parseNumber(rec.f?.paciente_edad);
  return n !== null && n >= 0 && n <= 120 ? Math.floor(n) : null;
}

/**
 * Etiqueta del grupo etario según los límites inferiores dados (el último es abierto).
 * @param {number|null|undefined} age
 * @param {number[]} groups p. ej. [0, 15, 45, 65] -> "0-14", "15-44", "45-64", "65+"
 */
export function ageGroup(age, groups) {
  if (age === null || age === undefined) return 'Sin dato';
  for (let i = groups.length - 1; i >= 0; i--) {
    if (age >= groups[i]) return i === groups.length - 1 ? `${groups[i]}+` : `${groups[i]}-${groups[i + 1] - 1}`;
  }
  return 'Sin dato';
}

/**
 * Todas las etiquetas de grupo etario, en orden (más "Sin dato").
 * @param {number[]} groups
 */
export function ageGroupLabels(groups) {
  return [...groups.map((g) => ageGroup(g, groups)), 'Sin dato'];
}

/**
 * Ordena un objeto {clave: n} de mayor a menor (empates por nombre).
 * @param {Record<string, number>} obj
 * @returns {[string, number][]}
 */
export function sortedEntries(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
}

/**
 * Mediana o null si no hay datos.
 * @param {number[]} nums
 */
export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Resumen de edades: n, promedio, mediana, mínimo y máximo.
 * @param {number[]} ages
 */
export function ageSummary(ages) {
  return {
    n: ages.length,
    promedio: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
    mediana: median(ages),
    min: ages.length ? Math.min(...ages) : null,
    max: ages.length ? Math.max(...ages) : null,
  };
}

/**
 * Suma `by` al contador `obj[k]`.
 * @param {Record<string, number>} obj
 * @param {string} k
 */
export function inc(obj, k, by = 1) {
  obj[k] = (obj[k] || 0) + by;
}
