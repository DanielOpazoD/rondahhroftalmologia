/**
 * Especialidad OFTALMOLOGÍA — datos clínicos (sin lógica, sin dependencias).
 *
 * Las claves (`key`) de antecedentes, procedimientos solicitados y
 * diagnósticos coinciden EXACTAMENTE con los nombres de las casillas del
 * formulario PDF (plantilla.pdf de esta carpeta). No cambiarlas sin
 * actualizar la plantilla.
 *
 * Contrato que debe cumplir toda especialidad: ver src/specialties/contrato.js.
 */

/** Identidad: `id` separa los datos en el servidor; `prefijo`, en el navegador. */
export const ESPECIALIDAD = Object.freeze({ id: 'oftalmologia', nombre: 'Oftalmología', prefijo: 'oft_' });

/** Títulos oficiales GES de oftalmología (Superintendencia de Salud; docs/CONSTANCIA_GES.md). */
export const GES_PATOLOGIAS = Object.freeze([
  'Tratamiento quirúrgico de cataratas',
  'Vicios de refracción en personas de 65 años y más',
  'Estrabismo en personas menores de 9 años',
  'Retinopatía diabética',
  'Desprendimiento de retina regmatógeno no traumático',
  'Trauma ocular grave',
  'Retinopatía del prematuro',
]);

/** @typedef {{key: string, label: string}} CheckDef */

/** @type {CheckDef[]} */
export const ANTECEDENTES = [
  { key: 'antecedente_dm2', label: 'DM2' },
  { key: 'antecedente_dm2ir', label: 'DM2 IR' },
  { key: 'antecedente_hta', label: 'HTA' },
  { key: 'antecedente_tbq', label: 'TBQ' },
  { key: 'antecedente_cirugia', label: 'Cirugía' },
];

/** @type {CheckDef[]} */
export const SOLICITADOS = [
  { key: 'procedimiento_tonometria', label: 'Tonometría' },
  { key: 'procedimiento_curva_tension', label: 'Curva tensión' },
  { key: 'procedimiento_fondo_ojo', label: 'FO' },
  { key: 'procedimiento_biometria', label: 'Biometría' },
  { key: 'procedimiento_oct', label: 'OCT' },
  { key: 'procedimiento_campimetria', label: 'Campimetría' },
  { key: 'procedimiento_laser', label: 'Láser' },
  { key: 'procedimiento_autoref', label: 'Autoref' },
  { key: 'procedimiento_topografia_corneal', label: 'Topografía corneal' },
  { key: 'procedimiento_test_schirmer', label: 'Test Schirmer' },
];

/** @type {CheckDef[]} */
export const DIAGNOSTICOS = [
  { key: 'diagnostico_rdp', label: 'RDP' },
  { key: 'diagnostico_rdnp', label: 'RDNP' },
  { key: 'diagnostico_glaucoma', label: 'Glaucoma' },
  { key: 'diagnostico_ddr', label: 'DDR' },
  { key: 'diagnostico_dmre', label: 'DMRE' },
  { key: 'diagnostico_uveitis', label: 'Uveítis' },
  { key: 'diagnostico_catarata', label: 'Catarata' },
  { key: 'diagnostico_presbicia', label: 'Presbicia' },
  { key: 'diagnostico_miopia', label: 'Miopía' },
  { key: 'diagnostico_astigmatismo', label: 'Astigmatismo' },
  { key: 'diagnostico_hipermetropia', label: 'Hipermetropía' },
  { key: 'diagnostico_ojo_seco', label: 'Ojo seco' },
  { key: 'diagnostico_estrabismo', label: 'Estrabismo' },
];

/** Ojos posibles para un procedimiento realizado. */
export const OJOS = ['OD', 'OI', 'AO'];

/**
 * @typedef {{id: string, n: string, pio?: 0|1, desc?: 0|1, abrev?: string}} ProcDef
 * `pio: 1` = el procedimiento registra presión intraocular por ojo.
 * `desc: 1` = admite una descripción en texto POR OJO (la del OD y la del OI);
 * en el PDF cada una va en el recuadro del examen de su ojo, con la abreviatura
 * (`abrev`, p. ej. «FO: …»).
 */

/** Lista por defecto de procedimientos realizados (editable en Ajustes). @type {ProcDef[]} */
export const DEFAULT_PROCS = [
  { id: 'autorref', n: 'Autorrefractometría' },
  { id: 't_aplan', n: 'T. Aplanática', pio: 1 },
  { id: 't_neum', n: 'T. Neumática', pio: 1 },
  { id: 'c_tension', n: 'Curva de tensión', pio: 1 },
  { id: 'fo', n: 'Fondo de ojo (FO)', desc: 1, abrev: 'FO' },
  { id: 'av', n: 'Agudeza visual (AV)' },
  { id: 'bmc', n: 'BMC', desc: 1, abrev: 'BMC' },
  { id: 'biometria', n: 'Biometría' },
  { id: 'laser', n: 'Láser' },
  { id: 'oct', n: 'OCT' },
  { id: 'cta', n: 'CTA' },
  { id: 'paquimetria', n: 'Paquimetría' },
  { id: 't_corneal', n: 'Topografía corneal' },
  { id: 'campimetria', n: 'Campimetría' },
  { id: 'ecografia', n: 'Ecografía ocular' },
];

/** Abreviatura que acompaña a la PIO según el tonómetro usado (por id de procedimiento). @type {Record<string, string>} */
export const PIO_SUFFIX = { t_aplan: 'Apl', t_neum: 'Neu' };

/**
 * Campos de texto libre del registro (`record.f`).
 * El id del elemento <input>/<textarea> en la interfaz es el mismo.
 */
export const TEXT_FIELDS = [
  'operativo',
  'fecha_atencion',
  'paciente_nombre',
  'paciente_apellido_paterno',
  'paciente_apellido_materno',
  'paciente_nombres',
  'paciente_rut',
  'paciente_fnac',
  'paciente_edad',
  'paciente_sexo',
  'paciente_fono',
  'antecedente_cirugia_detalle',
  'antecedentes_otros',
  'motivo_consulta',
  'od_av',
  'od_avcc',
  'od_pio',
  'od_hallazgos',
  'oi_av',
  'oi_avcc',
  'oi_pio',
  'oi_hallazgos',
  'examen_obs',
  'test_schirmer_detalle',
  'procedimientos_otros',
  'diagnosticos_otros',
  'ges',
  'interconsulta',
  'receta',
  'diagnosticos_acciones_otros',
  'plan',
  'seguimiento',
  'alta',
  'medico_nombre',
  'medico_apellido_paterno',
  'medico_apellido_materno',
  'medico_nombres',
  'medico_rut',
];

/** Campos de texto libre que pueden contener datos identificatorios. */
export const FREE_TEXT_FIELDS = [
  'antecedente_cirugia_detalle',
  'antecedentes_otros',
  'motivo_consulta',
  'od_hallazgos',
  'oi_hallazgos',
  'examen_obs',
  'procedimientos_otros',
  'diagnosticos_otros',
  'ges',
  'interconsulta',
  'receta',
  'diagnosticos_acciones_otros',
  'plan',
  'seguimiento',
  'alta',
];

/** Grupos etarios para estadística (límites inferiores; el último es abierto). */
export const AGE_GROUPS = [0, 15, 20, 45, 65, 80];

/** Rangos clínicos plausibles (validación). */
export const LIMITES_CLINICOS = Object.freeze({ pioMin: 0, pioMax: 80 });

/** Medidas que un procedimiento puede registrar por lado (aquí: PIO por ojo). */
export const MEDIDAS_PROC = ['od', 'oi'];

/** Nombres legibles de los campos (historial de cambios). */
export const ETIQUETAS = {
  operativo: 'Operativo',
  fecha_atencion: 'Fecha',
  paciente_nombre: 'Nombre completo',
  paciente_apellido_paterno: 'Apellido paterno',
  paciente_apellido_materno: 'Apellido materno',
  paciente_nombres: 'Nombres',
  medico_apellido_paterno: 'Apellido paterno del médico',
  medico_apellido_materno: 'Apellido materno del médico',
  medico_nombres: 'Nombres del médico',
  paciente_rut: 'RUT',
  paciente_fnac: 'Fecha de nacimiento',
  paciente_edad: 'Edad',
  paciente_sexo: 'Sexo',
  paciente_fono: 'Fono',
  antecedente_cirugia_detalle: 'Cirugía (detalle)',
  antecedentes_otros: 'Otros antecedentes',
  motivo_consulta: 'Motivo de consulta',
  od_av: 'AV OD',
  od_avcc: 'AVcc OD',
  od_pio: 'PIO OD',
  // Campos de versiones anteriores (ya no están en el formulario; se conservan en el historial).
  od_otro_examen: 'Otro examen OD',
  od_otro_resultado: 'Resultado OD',
  od_hallazgos: 'Hallazgos OD',
  oi_av: 'AV OI',
  oi_avcc: 'AVcc OI',
  oi_pio: 'PIO OI',
  oi_otro_examen: 'Otro examen OI',
  oi_otro_resultado: 'Resultado OI',
  oi_hallazgos: 'Hallazgos OI',
  examen_obs: 'Observaciones',
  test_schirmer_detalle: 'Schirmer (detalle)',
  procedimientos_otros: 'Otros solicitados',
  diagnosticos_otros: 'Otros diagnósticos',
  ges: 'GES',
  interconsulta: 'Interconsulta',
  receta: 'Receta',
  diagnosticos_acciones_otros: 'Otras acciones',
  plan: 'Plan',
  seguimiento: 'Seguimiento',
  alta: 'Alta',
  medico_nombre: 'Médico',
  medico_rut: 'RUT médico',
};

/** Etiqueta de cada parte de un procedimiento realizado: lado y medidas. */
export const ETIQUETAS_PROC = {
  eye: '(ojo)',
  od: 'PIO OD',
  oi: 'PIO OI',
  desc_od: 'descripción OD',
  desc_oi: 'descripción OI',
  desc: 'descripción',
};
