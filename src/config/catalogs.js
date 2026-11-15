/**
 * Constantes de la PLATAFORMA (comunes a todas las especialidades).
 * Los datos clínicos de la especialidad activa están en src/specialties/activa/.
 */
import pkg from '../../package.json' with { type: 'json' };
import { ESPECIALIDAD } from '../specialties/activa/config.js';

export { ESPECIALIDAD };

export const APP = Object.freeze({
  id: 'oftalmo-operativos',
  nombre: 'Atención Oftalmológica · Rondas y Operativos',
  establecimiento: 'Hospital Hanga Roa',
  /** Única fuente de verdad: package.json (se incrusta al construir). */
  version: pkg.version,
});

/** Versión del esquema de cada registro de atención (ver docs/MODELO_DATOS.md y core/migrations.js). */
export const SCHEMA_VERSION = 4;

/** Claves de localStorage, con el prefijo de la especialidad (no se mezclan datos entre rondas). */
const P = ESPECIALIDAD.prefijo;
export const STORAGE_KEYS = Object.freeze({
  records: `${P}atenciones_v1`,
  draft: `${P}borrador_v1`,
  procs: `${P}procs_v1`,
  medico: `${P}medico_v1`,
  settings: `${P}ajustes_v1`,
  anonSecret: `${P}secreto_anon_v1`,
  tombstones: `${P}eliminadas_v1`,
  sync: `${P}sync_v1`,
  medicos: `${P}medicos_v1`,
  operativos: `${P}operativos_v1`,
  clock: `${P}reloj_v1`,
  audit: `${P}bitacora_v1`,
  device: `${P}equipo_v1`,
  patients: `${P}pacientes_v1`,
});

/** Opciones de sexo registral (para estadística tipo REM). */
export const SEXOS = [
  { key: 'F', label: 'Femenino' },
  { key: 'M', label: 'Masculino' },
  { key: 'O', label: 'Otro / no informa' },
];

/** Rangos plausibles de datos demográficos. */
export const LIMITS = Object.freeze({ edadMax: 120 });

/** Ajustes por defecto de la app. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Nombre de este equipo en la bitácora (p. ej. «Box 1»). */
  deviceName: '',
  pdfFlatten: true,
  pdfFooter: true,
  notaPie: '(Registro en hoja de contingencia por caída de plataforma)',
});
