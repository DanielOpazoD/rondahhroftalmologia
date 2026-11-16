/**
 * Validaciones clínicas propias de otorrinolaringología (las generales están en core/record.js).
 */
import { parseNumber } from '../../core/format.js';
import { LIMITES_CLINICOS } from './config.js';

/**
 * @param {import('../../domain').Atencion} rec atención
 * @param {(field: string, msg: string) => void} warn marca una advertencia en un campo
 * @param {(msg: string) => void} note advertencia general (sin campo)
 */
export function validarClinico(rec, warn, note) {
  const f = rec.f || {};
  const { dbMin, dbMax } = LIMITES_CLINICOS;
  for (const e of ['od', 'oi']) {
    const v = f[`audiometria_${e}`];
    if (!v?.trim()) continue;
    const n = parseNumber(v.replace(/\s*db$/i, ''));
    if (n === null || n < dbMin || n > dbMax) {
      warn(`audiometria_${e}`, `Audiometría ${e.toUpperCase()} fuera de rango (${dbMin}–${dbMax} dB)`);
    }
  }
  const conAudiometria =
    f.audiometria_od?.trim() || f.audiometria_oi?.trim() || rec.checks?.solicitado_audiometria || rec.proc?.audiometria;
  if (rec.checks?.diagnostico_hipoacusia && !conAudiometria) note('Hipoacusia sin audiometría registrada ni solicitada');
}
