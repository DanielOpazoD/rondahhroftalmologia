/**
 * Casos clínicos de EJEMPLO para el modo práctica (datos inventados).
 * Solo la parte clínica: la plataforma agrega pacientes ficticios, fechas y
 * operativo (ver core/demo.js).
 */

/** @returns {import('../../domain').CasoEjemplo[]} */
export function casosDeEjemplo() {
  return [
    {
      f: { motivo_consulta: 'Control de glaucoma', od_av: '20/30', oi_av: '20/40', od_pio: '22', oi_pio: '19', plan: 'Control en 3 meses' },
      checks: { antecedente_hta: true, diagnostico_glaucoma: true },
      proc: { t_aplan: { eye: 'AO', od: '22', oi: '19' }, fo: { eye: 'AO' } },
    },
    {
      f: {
        motivo_consulta: 'Visión borrosa progresiva',
        od_av: '20/80',
        oi_av: '20/30',
        od_hallazgos: 'Opacidad cristalino',
        plan: 'Derivar a cirugía',
      },
      checks: { antecedente_dm2: true, diagnostico_catarata: true },
      proc: { av: { eye: 'AO' }, fo: { eye: 'OD' } },
      cat: 'OD',
    },
    {
      f: { motivo_consulta: 'Control diabético', od_av: '20/25', oi_av: '20/25', od_pio: '15', oi_pio: '16', plan: 'Control anual' },
      checks: { antecedente_dm2: true, diagnostico_rdnp: true },
      proc: { fo: { eye: 'AO' }, t_neum: { eye: 'AO', od: '15', oi: '16' } },
    },
  ];
}
