/**
 * Datos de prueba ficticios (ningún paciente real).
 */
import { DEFAULT_PROCS } from '../src/specialties/oftalmologia/config.js';
import { normalizeRecord } from '../src/core/record.js';

export const PROCS = structuredClone(DEFAULT_PROCS);

/** Atención completa con texto largo, procedimientos con PIO y catarata. */
export function fullRecord(overrides = {}) {
  return normalizeRecord({
    id: 'atest0001',
    created: 1763150000000,
    updated: 1763150000000,
    cat: 'OD',
    checks: {
      antecedente_dm2: true,
      antecedente_hta: true,
      antecedente_cirugia: true,
      procedimiento_oct: true,
      procedimiento_test_schirmer: true,
      diagnostico_catarata: true,
      diagnostico_rdnp: true,
    },
    proc: {
      autorref: { eye: 'AO' },
      t_aplan: { eye: 'AO', od: '14', oi: '16' },
      t_neum: { eye: 'OD', od: '18', oi: '99' },
      fo: { eye: 'AO' },
      oct: { eye: 'OI' },
    },
    f: {
      operativo: 'Operativo Prueba Nov 2026',
      fecha_atencion: '2026-11-14',
      paciente_nombre: 'María José Tepano Pakarati',
      paciente_rut: '11.111.111-1',
      paciente_edad: '67',
      paciente_sexo: 'F',
      paciente_fono: '+56 9 8765 4321',
      antecedente_cirugia_detalle: 'Facoemulsificación OI 2019',
      antecedentes_otros: 'Hipotiroidismo',
      motivo_consulta: 'Disminución de agudeza visual progresiva OD de 6 meses. Hija Ana Tepano acompaña, contacto 987654321.',
      od_av: '20/80',
      od_pio: '',
      od_hallazgos: 'Catarata nuclear N3',
      oi_av: '20/30',
      oi_hallazgos: 'Pseudofaquia',
      examen_obs: 'Paciente colaboradora',
      diagnosticos_otros: 'Blefaritis crónica',
      ges: 'Catarata',
      interconsulta: 'Cirugía catarata OD',
      receta: 'Lágrimas artificiales',
      plan: 'Control con biometría. Llamar a María al 9 8765 4321 para coordinar.',
      seguimiento: '3 meses',
      alta: '',
      medico_nombre: 'Dra. Ana Pérez Soto',
      medico_rut: '22.222.222-2',
    },
    ...overrides,
  });
}

export function minimalRecord(id, f = {}, extra = {}) {
  return normalizeRecord({ id, created: 1, updated: 1, checks: {}, proc: {}, f: { fecha_atencion: '2026-11-14', ...f }, ...extra });
}
