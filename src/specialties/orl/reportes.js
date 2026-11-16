/**
 * Tablas del Excel de estadística ORL ({ name, rows, header, widths } para lib/xlsx.js).
 */
import { APP, SEXOS } from '../../config/catalogs.js';
import { DIAGNOSTICOS, ESPECIALIDAD } from './config.js';
import { fmtDate, fmtDateTime } from '../../core/format.js';
import { STYLE } from '../../lib/xlsx.js';
import { computeStats, sortedEntries, ageOf, ageGroup, describeFilter } from './estadistica.js';
import { proceduresDone, antecedentsList, requestedList, diagnosesList } from './clinica.js';

/** @import { Atencion } from '../../domain' */
/** @import { RecordFilter } from '../../core/estadistica.js' */
/** @import { Hoja } from '../../lib/xlsx.js' */
/** @import { ProcDef } from './config.js' */
/** @import { Estadistica } from './estadistica.js' */

/** Celda en negrita. @param {unknown} v */
const b = (v) => ({ v, s: STYLE.bold });
/** Porcentaje con un decimal (0 si no hay total). @param {number} n @param {number} d */
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
/** @param {string} k */
const sexLabel = (k) => SEXOS.find((s) => s.key === k)?.label || '';
/** Número si el texto es numérico (para que Excel sume), si no el texto. @param {string | undefined} v */
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return v?.trim() && Number.isFinite(n) ? n : v || '';
};

/** Título de los reportes: especialidad y establecimiento (APP.nombre es el de oftalmología). */
export const TITULO = `${ESPECIALIDAD.nombre} · Rondas y operativos — ${APP.establecimiento}`;

/**
 * Hoja "Atenciones": una fila por atención.
 * @param {Atencion[]} records
 * @param {ProcDef[]} procs
 * @returns {Hoja}
 */
export function atencionesSheet(records, procs) {
  const header = [
    'ID atención',
    'Fecha',
    'Operativo',
    'Nombre',
    'RUT',
    'Edad',
    'Grupo etario',
    'Sexo',
    'Antecedentes',
    'Motivo de consulta',
    'Otoscopía OD',
    'Otoscopía OI',
    'Rinoscopía',
    'Orofaringe',
    'Audiometría OD (dB)',
    'Audiometría OI (dB)',
    'Procedimientos realizados',
    'N° procedimientos',
    'Exámenes solicitados',
    ...DIAGNOSTICOS.map((d) => 'Dx ' + d.label),
    'Diagnósticos (texto)',
    'GES',
    'IC',
    'Receta',
    'Plan',
    'Seguimiento',
    'Alta',
    'Médico',
  ];
  const rows = records.map((r) => {
    const f = r.f || {};
    const done = proceduresDone(r, procs);
    const age = ageOf(r);
    return [
      r.id,
      fmtDate(f.fecha_atencion),
      f.operativo,
      f.paciente_nombre,
      f.paciente_rut,
      age ?? f.paciente_edad ?? '',
      ageGroup(age),
      sexLabel(f.paciente_sexo),
      antecedentsList(r).join(', '),
      f.motivo_consulta,
      f.otoscopia_od,
      f.otoscopia_oi,
      f.rinoscopia,
      f.orofaringe,
      num(f.audiometria_od),
      num(f.audiometria_oi),
      done.map((p) => `${p.nombre} ${p.lado}`).join(', '),
      done.length,
      requestedList(r).join(', '),
      ...DIAGNOSTICOS.map((d) => (r.checks?.[d.key] ? 1 : 0)),
      diagnosesList(r).join(', '),
      f.ges,
      f.interconsulta,
      f.receta,
      f.plan,
      f.seguimiento,
      f.alta,
      f.medico_nombre,
    ];
  });
  return { name: 'Atenciones', header: true, rows: [header, ...rows] };
}

/**
 * Hoja "Prestaciones": una fila por procedimiento realizado.
 * @param {Atencion[]} records
 * @param {ProcDef[]} procs
 * @returns {Hoja}
 */
export function prestacionesSheet(records, procs) {
  /** @type {unknown[][]} */
  const rows = [['Fecha', 'Operativo', 'ID atención', 'Nombre', 'RUT', 'Edad', 'Sexo', 'Procedimiento', 'Oído', 'N° oídos', 'Médico']];
  for (const r of records) {
    const f = r.f || {};
    for (const p of proceduresDone(r, procs)) {
      rows.push([
        fmtDate(f.fecha_atencion),
        f.operativo,
        r.id,
        f.paciente_nombre,
        f.paciente_rut,
        ageOf(r) ?? '',
        sexLabel(f.paciente_sexo),
        p.nombre,
        p.lado,
        p.oidos,
        f.medico_nombre,
      ]);
    }
  }
  return { name: 'Prestaciones', header: true, rows };
}

/**
 * Hoja "Resumen": indicadores y tablas agregadas.
 * @param {Estadistica} S
 * @param {string} filterText
 * @returns {Hoja}
 */
export function resumenSheet(S, filterText, now = new Date()) {
  /** @type {unknown[][]} */
  const rows = [[b(TITULO)], ['Filtro', filterText], ['Generado', fmtDateTime(now)]];
  /** @param {string} title @param {string[]} head @param {unknown[][]} body */
  const table = (title, head, body) => rows.push([], [b(title)], head.map(b), ...body);
  /** @param {Record<string, number>} obj */
  const counts = (obj) => sortedEntries(obj).map(([k, v]) => [k, v, pct(v, S.n)]);

  rows.push([], [b('Indicador'), b('Valor')]);
  rows.push(
    ['Atenciones', S.n],
    ['Pacientes distintos', S.pacientes],
    ['Procedimientos realizados', S.procTotal],
    ['Oídos (suma)', S.ojos],
  );
  rows.push(['Edad promedio (años)', S.edad.promedio === null ? '' : Math.round(S.edad.promedio * 10) / 10]);
  table(
    'Procedimientos realizados',
    ['Procedimiento', 'Pacientes', 'OD', 'OI', 'Oídos'],
    sortedEntries(Object.fromEntries(Object.entries(S.proc).map(([k, o]) => [k, o.pac]))).map(([k]) => {
      const o = S.proc[k];
      return [k, o.pac, o.od, o.oi, o.ojos];
    }),
  );
  table('Diagnósticos', ['Diagnóstico', 'N°', '% atenciones'], counts(S.dx));
  table('Exámenes solicitados', ['Examen', 'N°', '% atenciones'], counts(S.sol));
  table('Antecedentes', ['Antecedente', 'N°', '% atenciones'], counts(S.ant));
  table(
    'Sexo',
    ['Sexo', 'N°', '%'],
    [
      ...SEXOS.map((s) => [s.label, S.sexo[s.key], pct(S.sexo[s.key], S.n)]),
      ['Sin dato', S.sexo['Sin dato'], pct(S.sexo['Sin dato'], S.n)],
    ],
  );
  table(
    'Edad',
    ['Grupo etario', 'N°'],
    Object.entries(S.edadSexo).map(([g, o]) => [g, Object.values(o).reduce((a, x) => a + x, 0)]),
  );
  return { name: 'Resumen', header: false, rows, widths: [34, 16, 12, 12, 12] };
}

/**
 * Libro completo de estadística ORL.
 * @param {Atencion[]} records
 * @param {ProcDef[]} procs
 * @param {RecordFilter} [filter]
 * @returns {Hoja[]}
 */
export function statsWorkbook(records, procs, filter = {}, now = new Date()) {
  const S = computeStats(records, procs);
  return [resumenSheet(S, describeFilter(filter, fmtDate), now), atencionesSheet(records, procs), prestacionesSheet(records, procs)];
}
