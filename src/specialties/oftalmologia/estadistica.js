/**
 * Estadística de atenciones: filtros y agregados.
 * Puro (sin DOM): la interfaz y los reportes Excel consumen el mismo resultado.
 */
import { SEXOS } from '../../config/catalogs.js';
import { AGE_GROUPS, DIAGNOSTICOS, SOLICITADOS, ANTECEDENTES } from './config.js';
import { parseNumber } from '../../core/format.js';
import { patientKey } from '../../core/record.js';
import { proceduresDone } from './clinica.js';

/**
 * @typedef {{operativo?: string, desde?: string, hasta?: string}} RecordFilter
 * Fechas en ISO (YYYY-MM-DD), ambos extremos inclusive.
 */

/** Aplica un filtro por operativo y rango de fechas. */
export function filterRecords(records, filter = {}) {
  const { operativo, desde, hasta } = filter;
  return records.filter((r) => {
    const fecha = r.f?.fecha_atencion || '';
    return (!operativo || r.f?.operativo === operativo) && (!desde || fecha >= desde) && (!hasta || fecha <= hasta);
  });
}

/** Descripción legible del filtro, para títulos de reportes. */
export function describeFilter(filter = {}, fmt = (x) => x) {
  const parts = [filter.operativo || 'Todos los operativos'];
  if (filter.desde || filter.hasta) parts.push(`${filter.desde ? fmt(filter.desde) : '…'} a ${filter.hasta ? fmt(filter.hasta) : '…'}`);
  return parts.join(' · ');
}

/** Operativos distintos presentes en los registros, ordenados. */
export function operativosOf(records) {
  return [...new Set(records.map((r) => (r.f?.operativo || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
}

/** Edad como entero o null. */
export function ageOf(rec) {
  const n = parseNumber(rec.f?.paciente_edad);
  return n !== null && n >= 0 && n <= 120 ? Math.floor(n) : null;
}

/** Etiqueta del grupo etario: "0-14", "15-19", …, "80+" o "Sin dato". */
export function ageGroup(age, groups = AGE_GROUPS) {
  if (age === null || age === undefined) return 'Sin dato';
  for (let i = groups.length - 1; i >= 0; i--) {
    if (age >= groups[i]) return i === groups.length - 1 ? `${groups[i]}+` : `${groups[i]}-${groups[i + 1] - 1}`;
  }
  return 'Sin dato';
}

/** Todas las etiquetas de grupo etario, en orden. */
export function ageGroupLabels(groups = AGE_GROUPS) {
  return [...groups.map((g) => ageGroup(g, groups)), 'Sin dato'];
}

const inc = (obj, k, by = 1) => {
  obj[k] = (obj[k] || 0) + by;
};

/** Ordena un objeto {clave: n} de mayor a menor. */
export function sortedEntries(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Calcula todos los agregados de un conjunto de atenciones.
 * @param {object[]} records
 * @param {import('./config.js').ProcDef[]} procs
 */
export function computeStats(records, procs) {
  const proc = {}; // nombre -> {pac, od, oi, ojos}
  const dx = {};
  const sol = {};
  const ant = {};
  const sexo = { F: 0, M: 0, O: 0, 'Sin dato': 0 };
  const groups = ageGroupLabels();
  const edadSexo = Object.fromEntries(groups.map((g) => [g, { F: 0, M: 0, O: 0, 'Sin dato': 0 }]));
  const porDia = {};
  const porMedico = {};
  const porOperativo = {};
  const pats = new Set();
  const ages = [];
  let ojos = 0;
  const gest = { ges: 0, ic: 0, receta: 0, seguimiento: 0, alta: 0 };

  for (const r of records) {
    const f = r.f || {};
    const pk = patientKey(r).key;
    pats.add(pk);

    const sx = SEXOS.some((s) => s.key === f.paciente_sexo) ? f.paciente_sexo : 'Sin dato';
    sexo[sx]++;
    const age = ageOf(r);
    if (age !== null) ages.push(age);
    edadSexo[ageGroup(age)][sx]++;

    const done = proceduresDone(r, procs);
    for (const p of done) {
      const o = (proc[p.nombre] ||= { pac: 0, od: 0, oi: 0, ojos: 0 });
      o.pac++;
      if (p.ojo === 'OD' || p.ojo === 'AO') o.od++;
      if (p.ojo === 'OI' || p.ojo === 'AO') o.oi++;
      o.ojos += p.ojos;
      ojos += p.ojos;
    }

    DIAGNOSTICOS.forEach((d) => r.checks?.[d.key] && inc(dx, d.label));
    if (f.diagnosticos_otros?.trim()) inc(dx, 'Otros diagnósticos');
    SOLICITADOS.forEach((d) => r.checks?.[d.key] && inc(sol, d.label));
    if (f.procedimientos_otros?.trim()) inc(sol, 'Otros');
    ANTECEDENTES.forEach((d) => r.checks?.[d.key] && inc(ant, d.label));

    for (const k of Object.keys(gest)) if (f[k === 'ic' ? 'interconsulta' : k]?.trim()) gest[k]++;

    const day = (porDia[f.fecha_atencion || 'Sin fecha'] ||= { atenciones: 0, pacientes: new Set(), procedimientos: 0, ojos: 0 });
    day.atenciones++;
    day.pacientes.add(pk);
    day.procedimientos += done.length;
    day.ojos += done.reduce((a, p) => a + p.ojos, 0);

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
    edad: {
      n: ages.length,
      promedio: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
      mediana: median(ages),
      min: ages.length ? Math.min(...ages) : null,
      max: ages.length ? Math.max(...ages) : null,
    },
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
