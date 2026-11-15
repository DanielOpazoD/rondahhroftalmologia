/**
 * Migraciones de esquema de las atenciones, paso a paso (v1 -> v2 -> v3 -> …).
 *
 * Reglas:
 *  - Cada cambio de formato agrega UN paso `STEPS[n]` que lleva de la versión n
 *    a la n+1, y sube SCHEMA_VERSION en config/catalogs.js.
 *  - Un registro de una versión FUTURA (creado por un equipo con la app más
 *    nueva) nunca se "baja" de versión: se conserva intacto, no se edita ni se
 *    fusiona, y la app pide actualizarse (recargar).
 */
import { SCHEMA_VERSION } from '../config/catalogs.js';
import { patientIdFor } from './patient.js';

export class FutureVersionError extends Error {
  constructor(v) {
    super(`Registro de una versión más nueva de la app (esquema v${v}). Recarga la página para actualizar.`);
    this.version = v;
  }
}

/** Versión de esquema de un registro (sin `v` = v1). */
export function versionOf(raw) {
  const v = Number(raw?.v);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

export const isFutureVersion = (raw) => versionOf(raw) > SCHEMA_VERSION;

/** Pasos de migración: STEPS[n](registro vN) -> registro vN+1. */
export const STEPS = {
  // v1 -> v2: se agregó `paciente_sexo` (opcional); sin cambios estructurales.
  1: (r) => ({ ...r, v: 2 }),
  // v2 -> v3: separación por especialidad y fechas de edición por campo (`ft`, opcional).
  2: (r) => ({ ...r, v: 3, especialidad: r.especialidad || 'oftalmologia' }),
  // v3 -> v4: el paciente pasa a ser una unidad; cada atención apunta a su ficha.
  3: (r) => {
    const pacienteId = r.pacienteId || patientIdFor(r.f || {});
    return pacienteId ? { ...r, v: 4, pacienteId } : { ...r, v: 4 };
  },
};

/**
 * Lleva un registro a la versión actual aplicando los pasos en orden.
 * @throws {FutureVersionError} si el registro es de una versión más nueva
 */
export function migrate(raw) {
  let v = versionOf(raw);
  if (v > SCHEMA_VERSION) throw new FutureVersionError(v);
  let r = { ...raw, v };
  while (v < SCHEMA_VERSION) {
    const step = STEPS[v];
    if (!step) throw new Error(`Falta la migración v${v} -> v${v + 1}`);
    r = step(r);
    v = r.v;
  }
  return r;
}
