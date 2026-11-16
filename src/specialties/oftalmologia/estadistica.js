/**
 * Estadística de atenciones: filtros y agregados.
 * Puro (sin DOM): la interfaz y los reportes Excel consumen el mismo resultado.
 */
import { SEXOS } from '../../config/catalogs.js';
import { AGE_GROUPS, DIAGNOSTICOS, SOLICITADOS, ANTECEDENTES } from './config.js';
import { parseNumber } from '../../core/format.js';
import { patientIdentityKey } from '../../core/record.js';
import { proceduresDone } from './clinica.js';

/** @import { Atencion } from '../../domain' */

/**
 * @typedef {{operativo?: string, desde?: string, hasta?: string}} RecordFilter
 * Fechas en ISO (YYYY-MM-DD), ambos extremos inclusive.
 */

/** Conteo de un procedimiento realizado: atenciones (`pac`), por ojo y ojos en total. @typedef {{pac: number, od: number, oi: number, ojos: number}} ConteoProc */

/** Atenciones con al menos una gestión de cada tipo. @typedef {{ges: number, ic: number, receta: number, seguimiento: number, alta: number}} Gestiones */

/** Agregados de computeStats() (los lee ui/statsView.js y los reportes Excel). @typedef {ReturnType<typeof computeStats>} Estadistica */

/**
 * Aplica un filtro por operativo y rango de fechas.
 * @param {Atencion[]} records
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
 * @param {Atencion[]} records
 */
export function operativosOf(records) {
  return [...new Set(records.map((r) => (r.f?.operativo || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
}

/**
 * Edad como entero o null.
 * @param {Atencion} rec
 */
export function ageOf(rec) {
  const n = parseNumber(rec.f?.paciente_edad);
  return n !== null && n >= 0 && n <= 120 ? Math.floor(n) : null;
}

/**
 * Etiqueta del grupo etario: "0-14", "15-19", …, "80+" o "Sin dato".
 * @param {number | null | undefined} age
 * @param {number[]} [groups] límites inferiores (el último es abierto)
 */
export function ageGroup(age, groups = AGE_GROUPS) {
  if (age === null || age === undefined) return 'Sin dato';
  for (let i = groups.length - 1; i >= 0; i--) {
    if (age >= groups[i]) return i === groups.length - 1 ? `${groups[i]}+` : `${groups[i]}-${groups[i + 1] - 1}`;
  }
  return 'Sin dato';
}

/**
 * Todas las etiquetas de grupo etario, en orden.
 * @param {number[]} [groups]
 */
export function ageGroupLabels(groups = AGE_GROUPS) {
  return [...groups.map((g) => ageGroup(g, groups)), 'Sin dato'];
}

/**
 * Suma `by` al contador `obj[k]`.
 * @param {Record<string, number>} obj
 * @param {string} k
 */
const inc = (obj, k, by = 1) => {
  obj[k] = (obj[k] || 0) + by;
};

/**
 * Ordena un objeto {clave: n} de mayor a menor.
 * @param {Record<string, number>} obj
 * @returns {[string, number][]}
 */
export function sortedEntries(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
}

/** @param {number[]} nums */
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Suma los procedimientos de una atención a `proc` (por nombre). Devuelve los ojos tratados.
 * @param {Record<string, ConteoProc>} proc @param {import('./clinica.js').ProcHecho[]} done
 */
function countProcs(proc, done) {
  let ojos = 0;
  for (const p of done) {
    const o = (proc[p.nombre] ||= { pac: 0, od: 0, oi: 0, ojos: 0 });
    o.pac++;
    if (p.ojo === 'OD' || p.ojo === 'AO') o.od++;
    if (p.ojo === 'OI' || p.ojo === 'AO') o.oi++;
    o.ojos += p.ojos;
    ojos += p.ojos;
  }
  return ojos;
}

/**
 * Suma las casillas marcadas (diagnósticos, solicitados, antecedentes) y los «otros» con texto.
 * @param {Atencion} r @param {{dx: Record<string, number>, sol: Record<string, number>, ant: Record<string, number>}} c
 */
function countChecks(r, { dx, sol, ant }) {
  const f = r.f || {};
  DIAGNOSTICOS.forEach((d) => r.checks?.[d.key] && inc(dx, d.label));
  if (f.diagnosticos_otros?.trim()) inc(dx, 'Otros diagnósticos');
  SOLICITADOS.forEach((d) => r.checks?.[d.key] && inc(sol, d.label));
  if (f.procedimientos_otros?.trim()) inc(sol, 'Otros');
  ANTECEDENTES.forEach((d) => r.checks?.[d.key] && inc(ant, d.label));
}

/** Promedio, mediana y rango de edades (null si no hay). @param {number[]} ages */
function ageSummary(ages) {
  const n = ages.length;
  return {
    n,
    promedio: n ? ages.reduce((a, b) => a + b, 0) / n : null,
    mediana: median(ages),
    min: n ? Math.min(...ages) : null,
    max: n ? Math.max(...ages) : null,
  };
}

/** Sexo para los conteos: F, M, O o 'Sin dato'. @param {string} v */
const sexKey = (v) => (SEXOS.some((s) => s.key === v) ? v : 'Sin dato');

/**
 * Suma las gestiones registradas (GES, interconsulta, receta, seguimiento, alta).
 * @param {Gestiones} gest @param {Record<string, string>} f
 */
function countGestiones(gest, f) {
  for (const k of /** @type {(keyof Gestiones)[]} */ (Object.keys(gest))) if (f[k === 'ic' ? 'interconsulta' : k]?.trim()) gest[k]++;
}

/**
 * Suma una atención al conteo de su día.
 * @param {Record<string, {atenciones: number, pacientes: Set<string>, procedimientos: number, ojos: number}>} porDia
 * @param {string} fecha @param {string} pk paciente @param {import('./clinica.js').ProcHecho[]} done
 */
function countDay(porDia, fecha, pk, done) {
  const day = (porDia[fecha] ||= { atenciones: 0, pacientes: new Set(), procedimientos: 0, ojos: 0 });
  day.atenciones++;
  day.pacientes.add(pk);
  day.procedimientos += done.length;
  day.ojos += done.reduce((a, p) => a + p.ojos, 0);
}

/**
 * Calcula todos los agregados de un conjunto de atenciones.
 * @param {Atencion[]} records
 * @param {import('./config.js').ProcDef[]} procs
 */
export function computeStats(records, procs) {
  /** @type {Record<string, ConteoProc>} */
  const proc = {}; // nombre -> {pac, od, oi, ojos}
  /** @type {Record<string, number>} */
  const dx = {};
  /** @type {Record<string, number>} */
  const sol = {};
  /** @type {Record<string, number>} */
  const ant = {};
  /** Atenciones por sexo: F, M, O y 'Sin dato'. @type {Record<string, number>} */
  const sexo = { F: 0, M: 0, O: 0, 'Sin dato': 0 };
  const groups = ageGroupLabels();
  /** Grupo etario -> conteo por sexo. @type {Record<string, Record<string, number>>} */
  const edadSexo = Object.fromEntries(groups.map((g) => [g, { F: 0, M: 0, O: 0, 'Sin dato': 0 }]));
  /** @type {Record<string, {atenciones: number, pacientes: Set<string>, procedimientos: number, ojos: number}>} */
  const porDia = {};
  /** @type {Record<string, number>} */
  const porMedico = {};
  /** @type {Record<string, number>} */
  const porOperativo = {};
  /** @type {Set<string>} */
  const pats = new Set();
  /** @type {number[]} */
  const ages = [];
  let ojos = 0;
  /** @type {Gestiones} */
  const gest = { ges: 0, ic: 0, receta: 0, seguimiento: 0, alta: 0 };

  for (const r of records) {
    const f = r.f || {};
    const pk = patientIdentityKey(r);
    pats.add(pk);

    const sx = sexKey(f.paciente_sexo);
    sexo[sx]++;
    const age = ageOf(r);
    if (age !== null) ages.push(age);
    edadSexo[ageGroup(age)][sx]++;

    const done = proceduresDone(r, procs);
    ojos += countProcs(proc, done);
    countChecks(r, { dx, sol, ant });

    countGestiones(gest, f);
    countDay(porDia, f.fecha_atencion || 'Sin fecha', pk, done);

    inc(porMedico, f.medico_nombre?.trim() || 'Sin dato');
    inc(porOperativo, f.operativo?.trim() || 'Sin operativo');
  }

  const procTotal = Object.values(proc).reduce((a, o) => a + o.pac, 0);
  return {
    n: records.length,
    pacientes: pats.size,
    proc,
    procTotal,
    ojos,
    dx,
    sol,
    ant,
    gest,
    sexo,
    edadSexo,
    edad: ageSummary(ages),
    porDia: Object.entries(porDia)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([fecha, d]) => ({
        fecha,
        atenciones: d.atenciones,
        pacientes: d.pacientes.size,
        procedimientos: d.procedimientos,
        ojos: d.ojos,
      })),
    porMedico,
    porOperativo,
  };
}
