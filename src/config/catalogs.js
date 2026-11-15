/**
 * Catálogos clínicos y constantes de configuración.
 *
 * Las claves (`key`) de antecedentes, procedimientos solicitados y
 * diagnósticos coinciden EXACTAMENTE con los nombres de las casillas del
 * formulario PDF (assets/plantilla_hoja_atencion.pdf). No cambiarlas sin
 * actualizar la plantilla.
 */

export const APP = Object.freeze({
  id: 'oftalmo-operativos',
  nombre: 'Atención Oftalmológica · Rondas y Operativos',
  establecimiento: 'Hospital Hanga Roa',
  version: '2.1.0',
});

/** Versión del esquema de cada registro de atención (ver docs/MODELO_DATOS.md). */
export const SCHEMA_VERSION = 2;

/** Claves de localStorage. Se mantienen las de la v1 para no perder datos. */
export const STORAGE_KEYS = Object.freeze({
  records: 'oft_atenciones_v1',
  draft: 'oft_borrador_v1',
  procs: 'oft_procs_v1',
  medico: 'oft_medico_v1',
  settings: 'oft_ajustes_v1',
  anonSecret: 'oft_secreto_anon_v1',
  tombstones: 'oft_eliminadas_v1',
  sync: 'oft_sync_v1',
});

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

/** Opciones de sexo registral (para estadística tipo REM). */
export const SEXOS = [
  { key: 'F', label: 'Femenino' },
  { key: 'M', label: 'Masculino' },
  { key: 'O', label: 'Otro / no informa' },
];

/** Ojos posibles para un procedimiento realizado. */
export const OJOS = ['OD', 'OI', 'AO'];

/**
 * @typedef {{id: string, n: string, pio?: 0|1}} ProcDef
 * `pio: 1` = el procedimiento registra presión intraocular por ojo.
 */

/** Lista por defecto de procedimientos realizados (editable en Ajustes). @type {ProcDef[]} */
export const DEFAULT_PROCS = [
  { id: 'autorref', n: 'Autorrefractometría' },
  { id: 't_aplan', n: 'T. Aplanática', pio: 1 },
  { id: 't_neum', n: 'T. Neumática', pio: 1 },
  { id: 'c_tension', n: 'Curva de tensión', pio: 1 },
  { id: 'fo', n: 'Fondo de ojo (FO)' },
  { id: 'av', n: 'Agudeza visual (AV)' },
  { id: 'bmc', n: 'BMC' },
  { id: 'biometria', n: 'Biometría' },
  { id: 'laser', n: 'Láser' },
  { id: 'oct', n: 'OCT' },
  { id: 'cta', n: 'CTA' },
  { id: 'paquimetria', n: 'Paquimetría' },
  { id: 't_corneal', n: 'Topografía corneal' },
  { id: 'campimetria', n: 'Campimetría' },
  { id: 'ecografia', n: 'Ecografía ocular' },
];

/** Abreviatura que acompaña a la PIO según el tonómetro usado. */
export const PIO_SUFFIX = { t_aplan: 'Apl', t_neum: 'Neu' };

/**
 * Campos de texto libre del registro (`record.f`).
 * El id del elemento <input>/<textarea> en la interfaz es el mismo.
 */
export const TEXT_FIELDS = [
  'operativo', 'fecha_atencion',
  'paciente_nombre', 'paciente_rut', 'paciente_edad', 'paciente_sexo', 'paciente_fono',
  'antecedente_cirugia_detalle', 'antecedentes_otros',
  'motivo_consulta',
  'od_av', 'od_pio', 'od_otro_examen', 'od_otro_resultado', 'od_hallazgos',
  'oi_av', 'oi_pio', 'oi_otro_examen', 'oi_otro_resultado', 'oi_hallazgos',
  'examen_obs',
  'test_schirmer_detalle', 'procedimientos_otros',
  'diagnosticos_otros', 'ges', 'interconsulta', 'receta', 'diagnosticos_acciones_otros',
  'plan', 'seguimiento', 'alta',
  'medico_nombre', 'medico_rut',
];

/** Campos de texto libre que pueden contener datos identificatorios. */
export const FREE_TEXT_FIELDS = [
  'antecedente_cirugia_detalle', 'antecedentes_otros', 'motivo_consulta',
  'od_hallazgos', 'oi_hallazgos', 'od_otro_resultado', 'oi_otro_resultado', 'examen_obs',
  'procedimientos_otros', 'diagnosticos_otros', 'ges', 'interconsulta', 'receta',
  'diagnosticos_acciones_otros', 'plan', 'seguimiento', 'alta',
];

/** Grupos etarios para estadística (límites inferiores; el último es abierto). */
export const AGE_GROUPS = [0, 15, 20, 45, 65, 80];

/** Rangos de valores plausibles para validar. */
export const LIMITS = Object.freeze({ edadMax: 120, pioMin: 0, pioMax: 80 });

/** Ajustes por defecto de la app. */
export const DEFAULT_SETTINGS = Object.freeze({
  pdfFlatten: true,
  pdfFooter: true,
  notaPie: '(Registro en hoja de contingencia por caída de plataforma)',
});
