/**
 * Validaciones clínicas propias de oftalmología (las generales están en core/record.js).
 */
import { parseNumber } from '../../core/format.js';
import { LIMITES_CLINICOS } from './config.js';

/**
 * @param {object} rec atención
 * @param {(field: string, msg: string) => void} warn marca una advertencia en un campo
 * @param {(msg: string) => void} note advertencia general (sin campo)
 */
export function validarClinico(rec, warn, note) {
  const f = rec.f || {};
  const pioOk = (v) => {
    const n = parseNumber(v);
    return n !== null && n >= LIMITES_CLINICOS.pioMin && n <= LIMITES_CLINICOS.pioMax;
  };
  for (const e of ['od', 'oi']) {
    const v = f[`${e}_pio`];
    if (v?.trim() && !pioOk(v)) warn(`${e}_pio`, `PIO ${e.toUpperCase()} fuera de rango (0–80 mmHg)`);
  }
  for (const p of Object.values(rec.proc || {})) {
    for (const e of ['od', 'oi']) {
      if (p[e]?.trim() && !pioOk(p[e])) note(`PIO ${e.toUpperCase()} de un procedimiento fuera de rango (0–80 mmHg)`);
    }
  }
  if (rec.checks?.diagnostico_catarata && !rec.cat) warn('catSeg', 'Catarata sin ojo indicado');
}
