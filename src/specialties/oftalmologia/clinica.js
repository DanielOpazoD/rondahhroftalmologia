/**
 * Derivaciones clínicas a partir de un registro: listas legibles de
 * antecedentes, procedimientos, diagnósticos, PIO, etc.
 *
 * Todas las funciones son puras: reciben el registro y la lista de
 * procedimientos configurada (`procs`) y devuelven datos.
 */
import { ANTECEDENTES, SOLICITADOS, DIAGNOSTICOS, PIO_SUFFIX } from './config.js';

/** N.º de ojos que cubre una lateralidad. */
export function eyeCount(eye) {
  return eye === 'AO' ? 2 : eye === 'OD' || eye === 'OI' ? 1 : 0;
}

/** ¿La lateralidad incluye el ojo dado ('od' | 'oi')? */
export function coversEye(eye, e) {
  return eye === 'AO' || (eye || '').toLowerCase() === e;
}

/** Nombre de un procedimiento: el de la lista actual o el guardado con la atención. */
export function procName(id, rec, procs) {
  const p = procs.find((x) => x.id === id);
  return p ? p.n : rec?.procNames?.[id] || rec?.proc?.[id]?.n || id;
}

/** ¿El procedimiento registra PIO? (si ya no está en la lista, se infiere por los valores). */
function procHasPio(id, rec, procs) {
  const p = procs.find((x) => x.id === id);
  if (p) return !!p.pio;
  const v = rec.proc[id];
  return !!(v && (v.od || v.oi));
}

/**
 * Procedimientos realizados como datos estructurados, en el orden de la lista
 * configurada (los que ya no están en la lista van al final).
 * @returns {{id: string, nombre: string, ojo: string, ojos: number, pioOd: string, pioOi: string}[]}
 */
export function proceduresDone(rec, procs) {
  const ids = Object.keys(rec.proc || {});
  const ordered = [...procs.filter((p) => rec.proc[p.id]).map((p) => p.id), ...ids.filter((id) => !procs.some((p) => p.id === id))];
  return ordered.map((id) => {
    const v = rec.proc[id];
    const pio = procHasPio(id, rec, procs);
    return {
      id,
      nombre: procName(id, rec, procs),
      ojo: v.eye,
      ojos: eyeCount(v.eye),
      pioOd: pio && coversEye(v.eye, 'od') ? (v.od || '').trim() : '',
      pioOi: pio && coversEye(v.eye, 'oi') ? (v.oi || '').trim() : '',
    };
  });
}

/** "T. Aplanática AO (OD 14 / OI 15 mmHg)" */
export function procLabel(p) {
  const vals = [p.pioOd && 'OD ' + p.pioOd, p.pioOi && 'OI ' + p.pioOi].filter(Boolean);
  return `${p.nombre} ${p.ojo}` + (vals.length ? ` (${vals.join(' / ')} mmHg)` : '');
}

/**
 * PIO a mostrar para un ojo: la del examen físico o, si falta, la primera
 * tonometría registrada (con sufijo Apl/Neu según el tonómetro).
 */
export function pioFor(rec, e, procs) {
  const own = (rec.f?.[`${e}_pio`] || '').trim();
  if (own) return own;
  for (const p of procs) {
    const v = rec.proc?.[p.id];
    if (p.pio && v && v[e] && coversEye(v.eye, e)) {
      return v[e].trim() + (PIO_SUFFIX[p.id] ? ' ' + PIO_SUFFIX[p.id] : '');
    }
  }
  return '';
}

/** Etiquetas de las casillas marcadas de un catálogo. */
export function checkedLabels(rec, defs) {
  return defs.filter((d) => rec.checks?.[d.key]).map((d) => d.label);
}

/** Antecedentes legibles: ["DM2", "Cx: facoemulsificación OD", "otros…"]. */
export function antecedentsList(rec) {
  const f = rec.f || {};
  const out = ANTECEDENTES.filter((d) => rec.checks?.[d.key]).map((d) =>
    d.key === 'antecedente_cirugia' && f.antecedente_cirugia_detalle?.trim() ? 'Cx: ' + f.antecedente_cirugia_detalle.trim() : d.label,
  );
  if (f.antecedentes_otros?.trim()) out.push(f.antecedentes_otros.trim());
  return out;
}

/** Procedimientos solicitados legibles (incluye detalle Schirmer y "otros"). */
export function requestedList(rec, { withOthers = true } = {}) {
  const f = rec.f || {};
  const out = SOLICITADOS.filter((d) => rec.checks?.[d.key]).map((d) =>
    d.key === 'procedimiento_test_schirmer' && f.test_schirmer_detalle?.trim() ? `${d.label} ${f.test_schirmer_detalle.trim()}` : d.label,
  );
  if (withOthers && f.procedimientos_otros?.trim()) out.push(f.procedimientos_otros.trim());
  return out;
}

/** Diagnósticos legibles (incluye lateralidad de catarata y "otros"). */
export function diagnosesList(rec, { withOthers = true } = {}) {
  const f = rec.f || {};
  const out = DIAGNOSTICOS.filter((d) => rec.checks?.[d.key]).map((d) =>
    d.key === 'diagnostico_catarata' && rec.cat ? `${d.label} ${rec.cat}` : d.label,
  );
  if (withOthers && f.diagnosticos_otros?.trim()) out.push(f.diagnosticos_otros.trim());
  return out;
}

/** Resumen de un ojo para la nota: "AV 20/40 | PIO 14 mmHg | AE 3 | hallazgos". */
export function eyeSummary(rec, e, procs) {
  const f = rec.f || {};
  const parts = [];
  const av = (f[`${e}_av`] || '').trim();
  const pio = pioFor(rec, e, procs);
  if (av) parts.push('AV ' + av);
  if (pio) parts.push('PIO ' + pio + (/mm/i.test(pio) ? '' : ' mmHg'));
  const otro = [f[`${e}_otro_examen`], f[`${e}_otro_resultado`]]
    .map((x) => (x || '').trim())
    .filter(Boolean)
    .join(' ');
  if (otro) parts.push(otro);
  if (f[`${e}_hallazgos`]?.trim()) parts.push(f[`${e}_hallazgos`].trim().replace(/\n+/g, '; '));
  return parts.join(' | ');
}

/** Acciones administrativas: "GES: … | IC: … | Receta: … | Otros: …". */
export function actionsList(rec) {
  const f = rec.f || {};
  return [
    f.ges?.trim() && 'GES: ' + f.ges.trim(),
    f.interconsulta?.trim() && 'IC: ' + f.interconsulta.trim(),
    f.receta?.trim() && 'Receta: ' + f.receta.trim(),
    f.diagnosticos_acciones_otros?.trim() && 'Otros: ' + f.diagnosticos_acciones_otros.trim(),
  ].filter(Boolean);
}
