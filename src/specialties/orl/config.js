/**
 * Especialidad OTORRINOLARINGOLOGÍA (piloto) — datos clínicos (sin lógica).
 *
 * Piloto para probar la arquitectura de especialidades: catálogos breves y un
 * examen mínimo (otoscopía, rinoscopía, orofaringe, audiometría). No hay hoja
 * oficial: el PDF se dibuja desde cero (pdf.js), sin plantilla.
 *
 * Contrato que debe cumplir toda especialidad: ver src/specialties/contrato.js.
 */

/** Identidad: `id` separa los datos en el servidor; `prefijo`, en el navegador. */
export const ESPECIALIDAD = Object.freeze({ id: 'orl', nombre: 'Otorrinolaringología', prefijo: 'orl_' });

/** @typedef {{key: string, label: string}} CheckDef */

/**
 * `antecedente_cirugia` muestra el campo de detalle (#cxBox): la interfaz usa
 * esa clave fija (ver docs/ESPECIALIDADES.md, «Lo que el piloto encontró»).
 * @type {CheckDef[]}
 */
export const ANTECEDENTES = [
  { key: 'antecedente_hta', label: 'HTA' },
  { key: 'antecedente_dm2', label: 'DM2' },
  { key: 'antecedente_rinitis', label: 'Rinitis alérgica' },
  { key: 'antecedente_ruido', label: 'Exposición a ruido' },
  { key: 'antecedente_tbq', label: 'TBQ' },
  { key: 'antecedente_cirugia', label: 'Cirugía ORL' },
];

/** @type {CheckDef[]} */
export const SOLICITADOS = [
  { key: 'solicitado_audiometria', label: 'Audiometría' },
  { key: 'solicitado_impedanciometria', label: 'Impedanciometría' },
  { key: 'solicitado_nasofibroscopia', label: 'Nasofibroscopía' },
  { key: 'solicitado_tac_cpn', label: 'TAC cavidades paranasales' },
];

/** @type {CheckDef[]} */
export const DIAGNOSTICOS = [
  { key: 'diagnostico_tapon_cerumen', label: 'Tapón de cerumen' },
  { key: 'diagnostico_otitis_externa', label: 'Otitis externa' },
  { key: 'diagnostico_otitis_media', label: 'Otitis media' },
  { key: 'diagnostico_hipoacusia', label: 'Hipoacusia' },
  { key: 'diagnostico_rinitis', label: 'Rinitis' },
  { key: 'diagnostico_rinosinusitis', label: 'Rinosinusitis' },
  { key: 'diagnostico_faringoamigdalitis', label: 'Faringoamigdalitis' },
  { key: 'diagnostico_vertigo', label: 'Vértigo' },
];

/**
 * Lados posibles de un procedimiento: oído derecho, izquierdo, ambos oídos.
 * (La plataforma llama `OJOS` a esta lista.)
 */
export const OJOS = ['OD', 'OI', 'AO'];

/** @typedef {{id: string, n: string}} ProcDef */

/** Lista por defecto de procedimientos realizados (editable en Ajustes). @type {ProcDef[]} */
export const DEFAULT_PROCS = [
  { id: 'lavado_oido', n: 'Lavado de oído' },
  { id: 'aspiracion', n: 'Aspiración ótica' },
  { id: 'otomicroscopia', n: 'Otomicroscopía' },
  { id: 'audiometria', n: 'Audiometría tonal' },
  { id: 'impedanciometria', n: 'Impedanciometría' },
  { id: 'cuerpo_extrano', n: 'Extracción de cuerpo extraño' },
];

/** Campos de texto libre del registro (`record.f`); el id del elemento en el formulario es el mismo. */
export const TEXT_FIELDS = [
  'operativo',
  'fecha_atencion',
  'paciente_nombre',
  'paciente_rut',
  'paciente_fnac',
  'paciente_edad',
  'paciente_sexo',
  'paciente_fono',
  'antecedente_cirugia_detalle',
  'antecedentes_otros',
  'motivo_consulta',
  'otoscopia_od',
  'otoscopia_oi',
  'rinoscopia',
  'orofaringe',
  'audiometria_od',
  'audiometria_oi',
  'examen_obs',
  'procedimientos_otros',
  'diagnosticos_otros',
  'ges',
  'interconsulta',
  'receta',
  'plan',
  'seguimiento',
  'alta',
  'medico_nombre',
  'medico_rut',
];

/** Campos de texto libre que pueden contener datos identificatorios. */
export const FREE_TEXT_FIELDS = [
  'antecedente_cirugia_detalle',
  'antecedentes_otros',
  'motivo_consulta',
  'otoscopia_od',
  'otoscopia_oi',
  'rinoscopia',
  'orofaringe',
  'examen_obs',
  'procedimientos_otros',
  'diagnosticos_otros',
  'ges',
  'interconsulta',
  'receta',
  'plan',
  'seguimiento',
  'alta',
];

/** Grupos etarios para estadística (límites inferiores; el último es abierto). */
export const AGE_GROUPS = [0, 5, 15, 45, 65];

/** Umbral auditivo plausible (promedio tonal puro, dB HL). */
export const LIMITES_CLINICOS = Object.freeze({ dbMin: -10, dbMax: 120 });

/** Medidas por lado de un procedimiento: ninguna (la audiometría va en el examen). */
export const MEDIDAS_PROC = [];

/** Nombres legibles de los campos (historial de cambios). */
export const ETIQUETAS = {
  operativo: 'Operativo',
  fecha_atencion: 'Fecha',
  paciente_nombre: 'Nombre',
  paciente_rut: 'RUT',
  paciente_fnac: 'Fecha de nacimiento',
  paciente_edad: 'Edad',
  paciente_sexo: 'Sexo',
  paciente_fono: 'Fono',
  antecedente_cirugia_detalle: 'Cirugía (detalle)',
  antecedentes_otros: 'Otros antecedentes',
  motivo_consulta: 'Motivo de consulta',
  otoscopia_od: 'Otoscopía OD',
  otoscopia_oi: 'Otoscopía OI',
  rinoscopia: 'Rinoscopía',
  orofaringe: 'Orofaringe',
  audiometria_od: 'Audiometría OD (dB)',
  audiometria_oi: 'Audiometría OI (dB)',
  examen_obs: 'Observaciones',
  procedimientos_otros: 'Otros solicitados',
  diagnosticos_otros: 'Otros diagnósticos',
  ges: 'GES',
  interconsulta: 'Interconsulta',
  receta: 'Receta',
  plan: 'Plan',
  seguimiento: 'Seguimiento',
  alta: 'Alta',
  medico_nombre: 'Médico',
  medico_rut: 'RUT médico',
};

/** Etiqueta de cada parte de un procedimiento realizado (solo el lado). */
export const ETIQUETAS_PROC = { eye: '(oído)' };
