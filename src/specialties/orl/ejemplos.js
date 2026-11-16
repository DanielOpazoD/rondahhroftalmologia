/**
 * Casos clínicos de EJEMPLO para el modo práctica (datos inventados).
 * Solo la parte clínica: la plataforma agrega pacientes ficticios, fechas y
 * operativo (ver core/demo.js).
 */

/** @returns {import('../../domain').CasoEjemplo[]} */
export function casosDeEjemplo() {
  return [
    {
      f: {
        motivo_consulta: 'Sensación de oído tapado derecho',
        otoscopia_od: 'Tapón de cerumen oclusivo',
        otoscopia_oi: 'CAE y membrana timpánica normales',
        plan: 'Control si persisten síntomas',
      },
      checks: { diagnostico_tapon_cerumen: true },
      proc: { lavado_oido: { eye: 'OD' } },
    },
    {
      f: {
        motivo_consulta: 'Disminución de la audición bilateral progresiva',
        otoscopia_od: 'Normal',
        otoscopia_oi: 'Normal',
        audiometria_od: '45',
        audiometria_oi: '50',
        ges: 'Hipoacusia bilateral',
        plan: 'Evaluación para audífonos',
      },
      checks: { antecedente_ruido: true, antecedente_hta: true, diagnostico_hipoacusia: true },
      proc: { audiometria: { eye: 'AO' } },
    },
    {
      f: {
        motivo_consulta: 'Congestión nasal y rinorrea de 3 meses',
        rinoscopia: 'Cornetes hipertróficos, mucosa pálida',
        receta: 'Corticoide nasal',
        plan: 'Lavados nasales y control en 2 meses',
      },
      checks: { antecedente_rinitis: true, diagnostico_rinitis: true, solicitado_nasofibroscopia: true },
      proc: {},
    },
  ];
}
