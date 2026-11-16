/**
 * Nota clínica en texto plano, para copiar y pegar en la ficha electrónica (Eloísa).
 */
import { fmtDate, doctorName } from '../../core/format.js';
import { SEXOS } from '../../config/catalogs.js';
import { antecedentsList, requestedList, diagnosesList, proceduresDone, procLabel, eyeSummary, actionsList } from './clinica.js';

/** Texto sin espacios en los extremos ('' si no hay). @param {string | undefined} v */
const t = (v) => (v || '').trim();

/** «Nombre | RUT … | 70 años | Femenino | Fono …» (solo lo que hay). @param {Record<string, string>} f */
function patientLine(f) {
  const sexo = SEXOS.find((s) => s.key === f.paciente_sexo)?.label;
  return [
    t(f.paciente_nombre),
    t(f.paciente_rut) && 'RUT ' + t(f.paciente_rut),
    t(f.paciente_edad) && t(f.paciente_edad) + ' años',
    sexo,
    t(f.paciente_fono) && 'Fono ' + t(f.paciente_fono),
  ]
    .filter(Boolean)
    .join(' | ');
}

/**
 * @param {import('../../domain').Atencion} rec registro de atención
 * @param {import('./config.js').ProcDef[]} procs lista de procedimientos
 * @param {{pie?: string}} [opts] `pie`: línea final opcional
 * @returns {string}
 */
export function buildNote(rec, procs, opts = {}) {
  const f = rec.f || {};
  /** @type {string[]} */
  const L = [];
  /** Línea «etiqueta valor», solo si hay valor. @param {string} label @param {string | undefined} v */
  const add = (label, v) => {
    if (t(v)) L.push(label + t(v));
  };
  /** Sección con título y una línea por elemento (nada si no hay elementos). @param {string} title @param {string[]} lines */
  const block = (title, lines) => {
    if (lines.length) L.push('', title, ...lines);
  };
  const bullets = (/** @type {string[]} */ xs) => xs.map((x) => '- ' + x);

  L.push('ATENCIÓN OFTALMOLÓGICA – RONDAS Y OPERATIVOS' + (t(f.operativo) ? ` (${t(f.operativo)})` : ''));
  add('Fecha: ', fmtDate(f.fecha_atencion));
  add('Paciente: ', patientLine(f));

  const ant = antecedentsList(rec);
  L.push('', 'ANTECEDENTES: ' + (ant.length ? ant.join(', ') : 'No refiere'));
  block('MOTIVO DE CONSULTA:', t(f.motivo_consulta) ? [t(f.motivo_consulta)] : []);

  const exam = [
    ['OD: ', eyeSummary(rec, 'od', procs)],
    ['OI: ', eyeSummary(rec, 'oi', procs)],
    ['Obs: ', t(f.examen_obs)],
  ];
  block(
    'EXAMEN FÍSICO:',
    exam.filter(([, v]) => v).map(([k, v]) => k + t(v)),
  );
  block('PROCEDIMIENTOS REALIZADOS:', bullets(proceduresDone(rec, procs).map((p) => procLabel(p))));

  const sol = requestedList(rec);
  if (sol.length) L.push('', 'PROCEDIMIENTOS SOLICITADOS: ' + sol.join(', '));
  block('DIAGNÓSTICOS:', bullets(diagnosesList(rec)));
  const acc = actionsList(rec);
  if (acc.length) L.push(acc.join(' | '));

  block('PLAN E INDICACIONES:', t(f.plan) ? [t(f.plan)] : []);
  if (t(f.seguimiento) || t(f.alta)) {
    L.push('');
    add('Seguimiento: ', f.seguimiento);
    add('Alta: ', f.alta);
  }
  if (t(f.medico_nombre)) L.push('', doctorName(f.medico_nombre) + (t(f.medico_rut) ? ' – RUT ' + t(f.medico_rut) : ''));
  if (opts.pie) L.push(opts.pie);

  return L.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
