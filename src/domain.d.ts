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
  proc: Record<string, ProcRealizado>;
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
export type TipoSync = 'atencion' | 'paciente' | 'medico' | 'operativo' | 'bitacora' | 'adjunto';

/** Elemento local que se sincroniza (antes de cifrar). */
export interface ElementoSync {
  id: string;
  updated: number;
  kind: TipoSync | string;
  data: Record<string, unknown>;
}

/**
 * Procedimiento realizado en una atención: el ojo y las medidas por lado de la especialidad.
 * (Alias de tipo y no `interface`: así se puede recorrer como Record<string, string>.)
 */
export type ProcRealizado = {
  eye: 'OD' | 'OI' | 'AO';
  od?: string;
  oi?: string;
  /** Descripción en texto (procedimientos que la admiten, p. ej. FO y BMC). */
  desc?: string;
};

/** Parte clínica de una atención de ejemplo para el modo práctica (la aporta la especialidad). */
export interface CasoEjemplo {
  f: Record<string, string>;
  checks: Record<string, boolean>;
  proc: Record<string, ProcRealizado>;
  cat?: Atencion['cat'];
}

/**
 * Lo común a atenciones y fichas de paciente que maneja la fusión campo a campo
 * (core/merge.js). Todo es opcional: puede venir de otra versión o de otro equipo.
 */
export interface RegistroFusionable {
  id?: string | null;
  created?: number;
  updated?: number;
  pacienteId?: string;
  f?: Record<string, string>;
  checks?: Record<string, boolean>;
  cat?: string;
  proc?: Record<string, ProcRealizado>;
  procNames?: Record<string, string>;
  ft?: FechasPorCampo;
  [campoDeOtraVersion: string]: unknown;
}

/** Procedimiento del catálogo (editable en Ajustes). `pio: 1` = registra presión intraocular por ojo. */
export interface Procedimiento {
  id: string;
  n: string;
  pio?: 0 | 1;
}

/** Operativo (ronda en terreno). */
export interface Operativo {
  id: string;
  nombre: string;
  created: number;
  updated: number;
  [campoDeOtraVersion: string]: unknown;
}

/** Cambio de un campo en una entrada de bitácora: ruta, antes y después (ausente = vacío). */
export interface AuditChange {
  c: string;
  a?: string | true;
  d?: string | true;
}

/** Entrada inmutable de la bitácora de una atención (core/audit.js). */
export interface AuditEntry {
  id: string;
  at: number;
  tipo: 'ingresada' | 'creada' | 'editada' | 'eliminada';
  equipo: string;
  equipoId: string;
  autor?: string;
  autorId?: string;
  /** Hora de la última edición juntada en esta entrada (guardado automático). */
  hasta?: number;
  cambios: AuditChange[];
}

/** Documento de bitácora de una atención (`b_<idAtención>`), sincronizado como cualquier dato. */
export interface AuditDoc {
  id: string;
  atencionId: string;
  updated: number;
  entries: AuditEntry[];
}

/** Versión de un elemento tal como la ve el servidor de sincronización: id, número y huella. */
export interface SyncVersion {
  id: string;
  u: number;
  /** Huella de contenido (16 hex), opcional por compatibilidad. */
  h?: string;
}

/** Versión cifrada que viaja por `get`/`put` (AES-GCM en base64). */
export interface SyncBlob extends SyncVersion {
  iv: string;
  ct: string;
}

/** Versión bajada y descifrada (o resuelta localmente) que se aplica sobre el estado local. */
export interface ElementoBajado {
  id: string;
  u: number;
  deleted?: boolean;
  kind?: TipoSync | string;
  data?: Record<string, unknown>;
  /** Versión del servidor con el mismo número que la local tras resolver un conflicto. */
  adopt?: boolean;
}
