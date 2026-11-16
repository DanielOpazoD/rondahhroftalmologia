/**
 * Nota clínica ORL en texto plano, para copiar y pegar en la ficha electrónica.
 */
import { fmtDate, doctorName } from '../../core/format.js';
import { SEXOS } from '../../config/catalogs.js';
import { antecedentsList, requestedList, diagnosesList, proceduresDone, procLabel, examFindings, actionsList } from './clinica.js';

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
  /** @param {string | undefined} v */
  const t = (v) => (v || '').trim();
  /** @param {string} title @param {string[]} [lines] */
  const section = (title, lines = []) => L.push('', title, ...lines);
  /** Sección con título y líneas, solo si hay líneas. @param {string} title @param {string[]} lines */
  const list = (title, lines) => lines.length && section(title, lines);

  L.push('ATENCIÓN OTORRINOLARINGOLÓGICA – RONDAS Y OPERATIVOS' + (t(f.operativo) ? ` (${t(f.operativo)})` : ''));
  if (f.fecha_atencion) L.push('Fecha: ' + fmtDate(f.fecha_atencion));
  const sexo = SEXOS.find((s) => s.key === f.paciente_sexo)?.label;
  const paciente = [
    t(f.paciente_nombre),
    t(f.paciente_rut) && 'RUT ' + t(f.paciente_rut),
    t(f.paciente_edad) && t(f.paciente_edad) + ' años',
    sexo,
    t(f.paciente_fono) && 'Fono ' + t(f.paciente_fono),
  ].filter(Boolean);
  if (paciente.length) L.push('Paciente: ' + paciente.join(' | '));

  const ant = antecedentsList(rec);
  section('ANTECEDENTES: ' + (ant.length ? ant.join(', ') : 'No refiere'));
  list('MOTIVO DE CONSULTA:', [t(f.motivo_consulta)].filter(Boolean));

  const ex = examFindings(rec);
  list(
    'EXAMEN FÍSICO:',
    ex.map(([k, v]) => `${k}: ${v.replace(/\n+/g, '; ')}`),
  );

  list(
    'PROCEDIMIENTOS REALIZADOS:',
    proceduresDone(rec, procs).map((p) => '- ' + procLabel(p)),
  );

  const sol = requestedList(rec);
  if (sol.length) section('EXÁMENES SOLICITADOS: ' + sol.join(', '));

  list(
    'DIAGNÓSTICOS:',
    diagnosesList(rec).map((x) => '- ' + x),
  );
  const acc = actionsList(rec);
  if (acc.length) L.push(acc.join(' | '));

  list('PLAN E INDICACIONES:', [t(f.plan)].filter(Boolean));
  const cierre = [t(f.seguimiento) && 'Seguimiento: ' + t(f.seguimiento), t(f.alta) && 'Alta: ' + t(f.alta)].filter(Boolean);
  if (cierre.length) section(cierre[0], cierre.slice(1));
  if (t(f.medico_nombre)) section(doctorName(f.medico_nombre) + (t(f.medico_rut) ? ' – RUT ' + t(f.medico_rut) : ''));
  if (opts.pie) L.push(opts.pie);

  return L.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
