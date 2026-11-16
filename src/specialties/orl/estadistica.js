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

/** @import { Atencion } from '../../domain' */

/** Conteo de un procedimiento realizado: atenciones (`pac`), por oído y oídos en total (`ojos`). @typedef {{pac: number, od: number, oi: number, ojos: number}} ConteoProc */

/** Atenciones con al menos una gestión de cada tipo. @typedef {{ges: number, ic: number, receta: number, seguimiento: number, alta: number}} Gestiones */

/** Agregados de computeStats() (misma forma que en oftalmología). @typedef {ReturnType<typeof computeStats>} Estadistica */

/**
 * Etiqueta del grupo etario con los grupos de ORL.
 * @param {number | null | undefined} age
 * @param {number[]} [groups]
 */
export const ageGroup = (age, groups = AGE_GROUPS) => base.ageGroup(age, groups);

/** Todas las etiquetas de grupo etario de ORL, en orden. @param {number[]} [groups] */
export const ageGroupLabels = (groups = AGE_GROUPS) => base.ageGroupLabels(groups);

/** Contador por sexo: F, M, O y 'Sin dato'. @returns {Record<string, number>} */
const sexos = () => ({ F: 0, M: 0, O: 0, 'Sin dato': 0 });

/** Atenciones, pacientes, procedimientos y oídos de un día. @typedef {{atenciones: number, pacientes: Set<string>, procedimientos: number, ojos: number}} ConteoDia */

/**
 * Suma los procedimientos realizados de una atención a sus conteos.
 * @param {Record<string, ConteoProc>} proc conteos por nombre de procedimiento
 * @param {import('./clinica.js').ProcHecho[]} done
 * @returns {number} oídos tratados en la atención
 */
function tallyProcs(proc, done) {
  let oidos = 0;
  for (const p of done) {
    const o = (proc[p.nombre] ||= { pac: 0, od: 0, oi: 0, ojos: 0 });
    o.pac++;
    if (p.lado === 'OD' || p.lado === 'AO') o.od++;
    if (p.lado === 'OI' || p.lado === 'AO') o.oi++;
    o.ojos += p.oidos;
    oidos += p.oidos;
  }
  return oidos;
}

/**
 * Cuenta las casillas marcadas (y los «otros» escritos) de diagnósticos, solicitados y antecedentes.
 * @param {Atencion} r
 * @param {Record<string, string>} f datos de la atención
 * @param {Record<string, number>} dx
 * @param {Record<string, number>} sol
 * @param {Record<string, number>} ant
 */
function tallyChecklists(r, f, dx, sol, ant) {
  const { inc } = base;
  DIAGNOSTICOS.forEach((d) => r.checks?.[d.key] && inc(dx, d.label));
  if (f.diagnosticos_otros?.trim()) inc(dx, 'Otros diagnósticos');
  SOLICITADOS.forEach((d) => r.checks?.[d.key] && inc(sol, d.label));
  if (f.procedimientos_otros?.trim()) inc(sol, 'Otros');
  ANTECEDENTES.forEach((d) => r.checks?.[d.key] && inc(ant, d.label));
}

/**
 * Cuenta las gestiones escritas de una atención (la interconsulta se guarda como `interconsulta`).
 * @param {Record<string, string>} f datos de la atención
 * @param {Gestiones} gest
 */
function tallyGestiones(f, gest) {
  for (const k of /** @type {(keyof Gestiones)[]} */ (Object.keys(gest))) if (f[k === 'ic' ? 'interconsulta' : k]?.trim()) gest[k]++;
}

/**
 * Suma una atención al conteo de su día ('Sin fecha' si no la tiene).
 * @param {Record<string, ConteoDia>} porDia
 * @param {Record<string, string>} f datos de la atención
 * @param {string} pk llave de identidad del paciente
 * @param {import('./clinica.js').ProcHecho[]} done
 */
function tallyDay(porDia, f, pk, done) {
  const day = (porDia[f.fecha_atencion || 'Sin fecha'] ||= { atenciones: 0, pacientes: new Set(), procedimientos: 0, ojos: 0 });
  day.atenciones++;
  day.pacientes.add(pk);
  day.procedimientos += done.length;
  day.ojos += done.reduce((a, p) => a + p.oidos, 0);
}

/**
 * Agregados de un conjunto de atenciones.
 * @param {Atencion[]} records
 * @param {import('./config.js').ProcDef[]} procs
 */
export function computeStats(records, procs) {
  const { inc } = base;
  /** @type {Record<string, ConteoProc>} */
  const proc = {}; // nombre -> {pac, od, oi, ojos (= oídos)}
  /** @type {Record<string, number>} */ const dx = {};
  /** @type {Record<string, number>} */ const sol = {};
  /** @type {Record<string, number>} */ const ant = {};
  const sexo = sexos();
  const edadSexo = Object.fromEntries(ageGroupLabels().map((g) => [g, sexos()]));
  /** @type {Record<string, ConteoDia>} */
  const porDia = {};
  /** @type {Record<string, number>} */ const porMedico = {};
  /** @type {Record<string, number>} */ const porOperativo = {};
  /** @type {Set<string>} */
  const pats = new Set();
  /** @type {number[]} */
  const ages = [];
  let oidos = 0;
  /** @type {Gestiones} */
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
    oidos += tallyProcs(proc, done);
    tallyChecklists(r, f, dx, sol, ant);
    tallyGestiones(f, gest);
    tallyDay(porDia, f, pk, done);

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
