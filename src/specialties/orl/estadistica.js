/**
 * Estadística de atenciones ORL. Las piezas genéricas (filtro, edad,
 * ordenamiento) vienen de core/estadistica.js.
 *
 * El resultado de computeStats() tiene la MISMA FORMA que el de oftalmología
 * porque la interfaz (ui/statsView.js) la lee directamente: por eso los
 * contadores por lado se llaman `od`, `oi` y el total `ojos`, aunque aquí
 * cuentan oídos. Ver docs/ESPECIALIDADES.md («Lo que el piloto encontró»).
 */
import { SEXOS } from '../../config/catalogs.js';
import { AGE_GROUPS, DIAGNOSTICOS, SOLICITADOS, ANTECEDENTES } from './config.js';
import { patientIdentityKey } from '../../core/record.js';
import * as base from '../../core/estadistica.js';
import { proceduresDone } from './clinica.js';

export { filterRecords, describeFilter, operativosOf, ageOf, sortedEntries } from '../../core/estadistica.js';

/** Etiqueta del grupo etario con los grupos de ORL. */
export const ageGroup = (age, groups = AGE_GROUPS) => base.ageGroup(age, groups);

/** Todas las etiquetas de grupo etario de ORL, en orden. */
export const ageGroupLabels = (groups = AGE_GROUPS) => base.ageGroupLabels(groups);

const sexos = () => ({ F: 0, M: 0, O: 0, 'Sin dato': 0 });

/**
 * Agregados de un conjunto de atenciones.
 * @param {object[]} records
 * @param {import('./config.js').ProcDef[]} procs
 */
export function computeStats(records, procs) {
  const { inc } = base;
  const proc = {}; // nombre -> {pac, od, oi, ojos (= oídos)}
  /** @type {Record<string, number>} */ const dx = {};
  /** @type {Record<string, number>} */ const sol = {};
  /** @type {Record<string, number>} */ const ant = {};
  const sexo = sexos();
  const edadSexo = Object.fromEntries(ageGroupLabels().map((g) => [g, sexos()]));
  const porDia = {};
  /** @type {Record<string, number>} */ const porMedico = {};
  /** @type {Record<string, number>} */ const porOperativo = {};
  const pats = new Set();
  const ages = [];
  let oidos = 0;
  const gest = { ges: 0, ic: 0, receta: 0, seguimiento: 0, alta: 0 };

  for (const r of records) {
    const f = r.f || {};
    const pk = patientIdentityKey(r);
    pats.add(pk);
    const sx = SEXOS.some((s) => s.key === f.paciente_sexo) ? f.paciente_sexo : 'Sin dato';
    sexo[sx]++;
    const age = base.ageOf(r);
    if (age !== null) ages.push(age);
    edadSexo[ageGroup(age)][sx]++;

    const done = proceduresDone(r, procs);
    for (const p of done) {
      const o = (proc[p.nombre] ||= { pac: 0, od: 0, oi: 0, ojos: 0 });
      o.pac++;
      if (p.lado === 'OD' || p.lado === 'AO') o.od++;
      if (p.lado === 'OI' || p.lado === 'AO') o.oi++;
      o.ojos += p.oidos;
      oidos += p.oidos;
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
    day.ojos += done.reduce((a, p) => a + p.oidos, 0);

    inc(porMedico, f.medico_nombre?.trim() || 'Sin dato');
    inc(porOperativo, f.operativo?.trim() || 'Sin operativo');
  }

  return {
    n: records.length,
    pacientes: pats.size,
    proc,
    procTotal: Object.values(proc).reduce((a, o) => a + o.pac, 0),
    ojos: oidos,
    dx,
    sol,
    ant,
    gest,
    sexo,
    edadSexo,
    edad: base.ageSummary(ages),
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
