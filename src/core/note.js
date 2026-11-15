/**
 * Nota clínica en texto plano, para copiar y pegar en la ficha electrónica (Eloísa).
 */
import { fmtDate, doctorName } from './format.js';
import { SEXOS } from '../config/catalogs.js';
import {
  antecedentsList, requestedList, diagnosesList, proceduresDone, procLabel, eyeSummary, actionsList,
} from './clinical.js';

/**
 * @param {object} rec registro de atención
 * @param {import('../config/catalogs.js').ProcDef[]} procs lista de procedimientos
 * @param {{pie?: string}} [opts] `pie`: línea final opcional
 * @returns {string}
 */
export function buildNote(rec, procs, opts = {}) {
  const f = rec.f || {};
  const L = [];
  const add = (label, v) => {
    if (v && String(v).trim()) L.push(label + String(v).trim());
  };
  const section = (title) => {
    L.push('');
    L.push(title);
  };

  L.push('ATENCIÓN OFTALMOLÓGICA – RONDAS Y OPERATIVOS' + (f.operativo?.trim() ? ` (${f.operativo.trim()})` : ''));
  add('Fecha: ', fmtDate(f.fecha_atencion));
  const sexo = SEXOS.find((s) => s.key === f.paciente_sexo)?.label;
  add(
    'Paciente: ',
    [
      f.paciente_nombre?.trim(),
      f.paciente_rut?.trim() && 'RUT ' + f.paciente_rut.trim(),
      f.paciente_edad?.trim() && f.paciente_edad.trim() + ' años',
      sexo,
      f.paciente_fono?.trim() && 'Fono ' + f.paciente_fono.trim(),
    ]
      .filter(Boolean)
      .join(' | '),
  );

  const ant = antecedentsList(rec);
  section('ANTECEDENTES: ' + (ant.length ? ant.join(', ') : 'No refiere'));

  if (f.motivo_consulta?.trim()) {
    section('MOTIVO DE CONSULTA:');
    L.push(f.motivo_consulta.trim());
  }

  const od = eyeSummary(rec, 'od', procs);
  const oi = eyeSummary(rec, 'oi', procs);
  if (od || oi || f.examen_obs?.trim()) {
    section('EXAMEN FÍSICO:');
    add('OD: ', od);
    add('OI: ', oi);
    add('Obs: ', f.examen_obs);
  }

  const done = proceduresDone(rec, procs);
  if (done.length) {
    section('PROCEDIMIENTOS REALIZADOS:');
    done.forEach((p) => L.push('- ' + procLabel(p)));
  }

  const sol = requestedList(rec);
  if (sol.length) section('PROCEDIMIENTOS SOLICITADOS: ' + sol.join(', '));

  const dx = diagnosesList(rec);
  if (dx.length) {
    section('DIAGNÓSTICOS:');
    dx.forEach((x) => L.push('- ' + x));
  }
  const acc = actionsList(rec);
  if (acc.length) L.push(acc.join(' | '));

  if (f.plan?.trim()) {
    section('PLAN E INDICACIONES:');
    L.push(f.plan.trim());
  }
  if (f.seguimiento?.trim() || f.alta?.trim()) {
    L.push('');
    add('Seguimiento: ', f.seguimiento);
    add('Alta: ', f.alta);
  }
  if (f.medico_nombre?.trim()) {
    L.push('');
    L.push(doctorName(f.medico_nombre) + (f.medico_rut?.trim() ? ' – RUT ' + f.medico_rut.trim() : ''));
  }
  if (opts.pie) L.push(opts.pie);

  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
