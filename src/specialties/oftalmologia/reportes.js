/**
 * Construcción de tablas para los reportes Excel de estadística.
 * Devuelve estructuras { name, rows, header, widths } que consume lib/xlsx.js.
 * No contiene lógica de archivo ni de DOM: se prueba en Node.
 */
import { APP, SEXOS } from '../../config/catalogs.js';
import { DIAGNOSTICOS } from './config.js';
import { fmtDate, fmtDateTime } from '../../core/format.js';
import { STYLE } from '../../lib/xlsx.js';
import { computeStats, sortedEntries, ageOf, ageGroup, ageGroupLabels, describeFilter } from './estadistica.js';
import { proceduresDone, pioFor, antecedentsList, requestedList, diagnosesList, procName } from './clinica.js';

const b = (v) => ({ v, s: STYLE.bold });
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const sexLabel = (k) => SEXOS.find((s) => s.key === k)?.label || '';
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return v !== '' && v !== undefined && v !== null && Number.isFinite(n) ? n : (v ?? '');
};

/** Ids de procedimientos presentes: primero los de la lista, luego los históricos. */
function procColumns(records, procs) {
  const ids = procs.map((p) => p.id);
  for (const r of records) for (const id of Object.keys(r.proc || {})) if (!ids.includes(id)) ids.push(id);
  return ids.map((id) => ({ id, nombre: procName(id, records.find((r) => r.proc?.[id]) || {}, procs) }));
}

/** Hoja "Atenciones": una fila por atención con todas las variables. */
export function atencionesSheet(records, procs) {
  const cols = procColumns(records, procs);
  const header = [
    'ID atención',
    'Fecha',
    'Operativo',
    'Nombre',
    'RUT',
    'Edad',
    'Grupo etario',
    'Sexo',
    'Fono',
    'Antecedentes',
    'Motivo de consulta',
    'AV OD',
    'PIO OD',
    'AV OI',
    'PIO OI',
    'Hallazgos OD',
    'Hallazgos OI',
    'Obs. examen',
    ...cols.map((c) => c.nombre),
    'N° procedimientos',
    'N° ojos (proc.)',
    'Proc. solicitados',
    ...DIAGNOSTICOS.map((d) => 'Dx ' + d.label),
    'Catarata ojo',
    'Otros diagnósticos',
    'Diagnósticos (texto)',
    'GES',
    'IC',
    'Receta',
    'Otras acciones',
    'Plan',
    'Seguimiento',
    'Alta',
    'Médico',
    'RUT médico',
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
      f.paciente_fono,
      antecedentsList(r).join(', '),
      f.motivo_consulta,
      f.od_av,
      num(pioFor(r, 'od', procs)),
      f.oi_av,
      num(pioFor(r, 'oi', procs)),
      f.od_hallazgos,
      f.oi_hallazgos,
      f.examen_obs,
      ...cols.map((c) => r.proc?.[c.id]?.eye || ''),
      done.length,
      done.reduce((a, p) => a + p.ojos, 0),
      requestedList(r).join(', '),
      ...DIAGNOSTICOS.map((d) => (r.checks?.[d.key] ? 1 : 0)),
      r.checks?.diagnostico_catarata ? r.cat : '',
      f.diagnosticos_otros,
      diagnosesList(r).join(', '),
      f.ges,
      f.interconsulta,
      f.receta,
      f.diagnosticos_acciones_otros,
      f.plan,
      f.seguimiento,
      f.alta,
      f.medico_nombre,
      f.medico_rut,
    ];
  });
  return { name: 'Atenciones', header: true, rows: [header, ...rows] };
}

/** Hoja "Prestaciones": una fila por procedimiento realizado (formato largo). */
export function prestacionesSheet(records, procs) {
  const header = [
    'Fecha',
    'Operativo',
    'ID atención',
    'Nombre',
    'RUT',
    'Edad',
    'Sexo',
    'Procedimiento',
    'Ojo',
    'N° ojos',
    'PIO OD',
    'PIO OI',
    'Médico',
  ];
  const rows = [];
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
        p.ojo,
        p.ojos,
        num(p.pioOd),
        num(p.pioOi),
        f.medico_nombre,
      ]);
    }
  }
  return { name: 'Prestaciones', header: true, rows: [header, ...rows] };
}

/** Hoja "Resumen": indicadores y tablas agregadas. */
export function resumenSheet(S, filterText, now = new Date()) {
  const rows = [];
  const blank = () => rows.push([]);
  const table = (title, head, body) => {
    blank();
    rows.push([b(title)]);
    rows.push(head.map(b));
    body.forEach((r) => rows.push(r));
  };

  rows.push([b(`${APP.nombre} — ${APP.establecimiento}`)]);
  rows.push(['Filtro', filterText]);
  rows.push(['Generado', fmtDateTime(now)]);
  blank();
  rows.push([b('Indicador'), b('Valor')]);
  rows.push(['Atenciones', S.n]);
  rows.push(['Pacientes distintos', S.pacientes]);
  rows.push(['Procedimientos realizados', S.procTotal]);
  rows.push(['Ojos intervenidos (suma)', S.ojos]);
  rows.push(['Edad promedio (años)', S.edad.promedio === null ? '' : Math.round(S.edad.promedio * 10) / 10]);
  rows.push(['Edad mediana (años)', S.edad.mediana ?? '']);
  rows.push(['Rango de edad', S.edad.n ? `${S.edad.min}–${S.edad.max}` : '']);

  const procRows = sortedEntries(Object.fromEntries(Object.entries(S.proc).map(([k, o]) => [k, o.pac]))).map(([k]) => {
    const o = S.proc[k];
    return [k, o.pac, o.od, o.oi, o.ojos];
  });
  const tot = procRows.reduce((a, r) => [a[0] + r[1], a[1] + r[2], a[2] + r[3], a[3] + r[4]], [0, 0, 0, 0]);
  table(
    'Procedimientos realizados',
    ['Procedimiento', 'Pacientes', 'OD', 'OI', 'Ojos'],
    [...procRows, [b('Total'), b(tot[0]), b(tot[1]), b(tot[2]), b(tot[3])]],
  );

  table(
    'Diagnósticos',
    ['Diagnóstico', 'N°', '% atenciones'],
    sortedEntries(S.dx).map(([k, v]) => [k, v, pct(v, S.n)]),
  );
  table(
    'Procedimientos solicitados',
    ['Procedimiento', 'N°', '% atenciones'],
    sortedEntries(S.sol).map(([k, v]) => [k, v, pct(v, S.n)]),
  );
  table(
    'Antecedentes',
    ['Antecedente', 'N°', '% atenciones'],
    sortedEntries(S.ant).map(([k, v]) => [k, v, pct(v, S.n)]),
  );
  table(
    'Gestiones',
    ['Gestión', 'N°', '% atenciones'],
    [
      ['Con GES', S.gest.ges, pct(S.gest.ges, S.n)],
      ['Con interconsulta', S.gest.ic, pct(S.gest.ic, S.n)],
      ['Con receta', S.gest.receta, pct(S.gest.receta, S.n)],
      ['Con seguimiento', S.gest.seguimiento, pct(S.gest.seguimiento, S.n)],
      ['Con alta', S.gest.alta, pct(S.gest.alta, S.n)],
    ],
  );
  table(
    'Sexo',
    ['Sexo', 'N°', '%'],
    [
      ...SEXOS.map((s) => [s.label, S.sexo[s.key], pct(S.sexo[s.key], S.n)]),
      ['Sin dato', S.sexo['Sin dato'], pct(S.sexo['Sin dato'], S.n)],
    ],
  );
  table('Atenciones por operativo', ['Operativo', 'N°'], sortedEntries(S.porOperativo));
  table('Atenciones por médico', ['Médico', 'N°'], sortedEntries(S.porMedico));

  return { name: 'Resumen', header: false, rows, widths: [34, 16, 12, 12, 12] };
}

/** Hoja "Por día". */
export function porDiaSheet(S) {
  return {
    name: 'Por día',
    header: true,
    rows: [
      ['Fecha', 'Atenciones', 'Pacientes', 'Procedimientos', 'Ojos'],
      ...S.porDia.map((d) => [fmtDate(d.fecha) || d.fecha, d.atenciones, d.pacientes, d.procedimientos, d.ojos]),
      [b('Total'), b(S.n), b(S.pacientes), b(S.procTotal), b(S.ojos)],
    ],
  };
}

/** Hoja "Edad y sexo" (tipo REM). */
export function edadSexoSheet(S) {
  const groups = ageGroupLabels();
  const keys = ['F', 'M', 'O', 'Sin dato'];
  const rows = groups.map((g) => {
    const o = S.edadSexo[g];
    return [g, ...keys.map((k) => o[k]), keys.reduce((a, k) => a + o[k], 0)];
  });
  const totals = keys.map((k) => groups.reduce((a, g) => a + S.edadSexo[g][k], 0));
  return {
    name: 'Edad y sexo',
    header: true,
    rows: [
      ['Grupo etario', 'Femenino', 'Masculino', 'Otro', 'Sin dato', 'Total'],
      ...rows,
      [b('Total'), ...totals.map(b), b(totals.reduce((a, x) => a + x, 0))],
    ],
  };
}

/**
 * Libro completo de estadística.
 * @returns {{name: string, rows: any[][], header?: boolean, widths?: number[]}[]}
 */
export function statsWorkbook(records, procs, filter = {}, now = new Date()) {
  const S = computeStats(records, procs);
  const filterText = describeFilter(filter, fmtDate);
  return [
    resumenSheet(S, filterText, now),
    atencionesSheet(records, procs),
    prestacionesSheet(records, procs),
    porDiaSheet(S),
    edadSexoSheet(S),
  ];
}
