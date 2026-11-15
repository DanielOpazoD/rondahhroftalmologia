/* ------------------------------------------------------------------------
 * Modelo de dominio (ver docs/MODELO_DATOS.md). Se usan desde JSDoc:
 *   @param {import('../domain').Atencion} rec
 * Los campos son opcionales donde los datos pueden venir de versiones
 * anteriores, respaldos o de otro equipo (lector tolerante, ADR 0012).
 * ---------------------------------------------------------------------- */

/** Fecha de edición (ms) de cada campo: 'f.<campo>', 'checks.<clave>', 'cat', 'proc.<id>.eye|od|oi', 'pacienteId'. */
export type FechasPorCampo = Record<string, number>;

/** Episodio de atención de una especialidad (esquema v4). */
export interface Atencion {
  v: number;
  especialidad: string;
  id: string | null;
  created?: number;
  updated?: number;
  pacienteId?: string;
  f: Record<string, string>;
  checks: Record<string, boolean>;
  cat: '' | 'OD' | 'OI' | 'AO';
  proc: Record<string, { eye: 'OD' | 'OI' | 'AO'; od?: string; oi?: string }>;
  procNames?: Record<string, string>;
  ft?: FechasPorCampo;
  [campoDeOtraVersion: string]: unknown;
}

/** Ficha del paciente (espacio común a las especialidades). */
export interface Paciente {
  id: string;
  tipo: 'paciente';
  v: number;
  created: number;
  updated: number;
  /** paciente_rut, paciente_nombre, paciente_fnac, paciente_sexo, paciente_fono y fusionado_en. */
  f: Record<string, string>;
  ft?: FechasPorCampo;
  checks: Record<string, never>;
  proc: Record<string, never>;
  [campoDeOtraVersion: string]: unknown;
}

/** Perfil profesional (en el código y la sincronización se llama «médico» por compatibilidad). */
export interface Perfil {
  id: string;
  nombre: string;
  rut: string;
  /** medico | enfermeria | tens | tecnologo | admision | otro, o uno de una versión más nueva. */
  rol: string;
  created: number;
  updated: number;
  [campoDeOtraVersion: string]: unknown;
}

/** Tipos de elemento que se sincronizan. */
export type TipoSync = 'atencion' | 'paciente' | 'medico' | 'operativo' | 'bitacora';

/** Elemento local que se sincroniza (antes de cifrar). */
export interface ElementoSync {
  id: string;
  updated: number;
  kind: TipoSync | string;
  data: Record<string, unknown>;
}
