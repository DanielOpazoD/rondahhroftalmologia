/**
 * Derivaciones clínicas de una atención ORL: listas legibles de antecedentes,
 * procedimientos, diagnósticos y resumen del examen. Funciones puras.
 */
import { ANTECEDENTES, SOLICITADOS, DIAGNOSTICOS } from './config.js';

/** N.º de oídos que cubre un lado ('OD' | 'OI' | 'AO'). */
export function sideCount(lado) {
  return lado === 'AO' ? 2 : lado === 'OD' || lado === 'OI' ? 1 : 0;
}

/** ¿El lado incluye el oído dado ('od' | 'oi')? (la plataforma la llama `coversEye`). */
export function coversEye(lado, e) {
  return lado === 'AO' || (lado || '').toLowerCase() === e;
}

/** Nombre de un procedimiento: el de la lista actual o el guardado con la atención. */
export function procName(id, rec, procs) {
  const p = procs.find((x) => x.id === id);
  return p ? p.n : rec?.procNames?.[id] || id;
}

/**
 * Procedimientos realizados, en el orden de la lista configurada (los que ya
 * no están en la lista no se incluyen).
 * @returns {{id: string, nombre: string, lado: string, oidos: number}[]}
 */
export function proceduresDone(rec, procs) {
  // Solo los procedimientos de la lista configurada: uno que se quitó de la
  // lista no se muestra ni se cuenta (el dato queda en la atención; si se
  // restaura la lista, vuelve a aparecer).
  const ordered = procs.filter((p) => rec.proc?.[p.id]).map((p) => p.id);
  return ordered.map((id) => ({ id, nombre: procName(id, rec, procs), lado: rec.proc[id].eye, oidos: sideCount(rec.proc[id].eye) }));
}

/** "Lavado de oído OD" */
export const procLabel = (p) => `${p.nombre} ${p.lado}`;

/** Etiquetas de las casillas marcadas de un catálogo. */
const checked = (rec, defs) => defs.filter((d) => rec.checks?.[d.key]).map((d) => d.label);

/** Lista marcada + texto libre opcional. */
const withText = (list, text) => (text?.trim() ? [...list, text.trim()] : list);

/** Antecedentes legibles: ["HTA", "Cx: timpanoplastía OD", "otros…"]. */
export function antecedentsList(rec) {
  const f = rec.f || {};
  const cx = f.antecedente_cirugia_detalle?.trim();
  const list = ANTECEDENTES.filter((d) => rec.checks?.[d.key]).map((d) => (d.key === 'antecedente_cirugia' && cx ? 'Cx: ' + cx : d.label));
  return withText(list, f.antecedentes_otros);
}

/** Procedimientos solicitados legibles (con "otros"). */
export function requestedList(rec, { withOthers = true } = {}) {
  return withText(checked(rec, SOLICITADOS), withOthers ? rec.f?.procedimientos_otros : '');
}

/** Diagnósticos legibles (con "otros"). */
export function diagnosesList(rec, { withOthers = true } = {}) {
  return withText(checked(rec, DIAGNOSTICOS), withOthers ? rec.f?.diagnosticos_otros : '');
}

/** "28 dB" (agrega la unidad si falta). */
const db = (v) => (v?.trim() ? v.trim() + (/db/i.test(v) ? '' : ' dB') : '');

/**
 * Hallazgos del examen como pares [etiqueta, texto], solo los registrados.
 * @returns {[string, string][]}
 */
export function examFindings(rec) {
  const f = rec.f || {};
  const audio = [f.audiometria_od?.trim() && 'OD ' + db(f.audiometria_od), f.audiometria_oi?.trim() && 'OI ' + db(f.audiometria_oi)]
    .filter(Boolean)
    .join(' / ');
  return /** @type {[string, string][]} */ (
    [
      ['Otoscopía OD', f.otoscopia_od],
      ['Otoscopía OI', f.otoscopia_oi],
      ['Rinoscopía', f.rinoscopia],
      ['Orofaringe', f.orofaringe],
      ['Audiometría (PTP)', audio],
      ['Obs', f.examen_obs],
    ]
      .map(([k, v]) => [k, (v || '').trim()])
      .filter(([, v]) => v)
  );
}

/** Gestiones: "GES: … | IC: … | Receta: …". */
export function actionsList(rec) {
  const f = rec.f || {};
  return [
    f.ges?.trim() && 'GES: ' + f.ges.trim(),
    f.interconsulta?.trim() && 'IC: ' + f.interconsulta.trim(),
    f.receta?.trim() && 'Receta: ' + f.receta.trim(),
  ].filter(Boolean);
}
