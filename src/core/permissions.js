/**
 * Permisos por rol (ADR 0014). Lo usan la interfaz y el servidor.
 *
 * Cada cuenta tiene una PROFESIÓN (`rol`: médico, enfermería, TENS,
 * tecnólogo, administrativo…) y, aparte, puede ser ADMINISTRADORA.
 *
 * - Clínicos (médico, enfermería, TENS, tecnólogo): editan atenciones.
 * - Administrativos (y cualquier otra profesión): ven las atenciones, hacen
 *   el ingreso y editan los datos del paciente, pero no editan lo clínico.
 * - Administradores: además gestionan usuarios, ajustes del sistema y ven el
 *   registro de accesos.
 */

/** Profesiones que editan atenciones clínicas. */
const CLINICAL_ROLES = Object.freeze(['medico', 'enfermeria', 'tens', 'tecnologo']);

/** Permisos que la app distingue. */
export const PERMISSIONS = Object.freeze({
  /** Ver atenciones, fichas, PDF, nota, estadística y exportar. */
  VER: 'ver',
  /** Ingreso / preingreso y datos del paciente. */
  INGRESO: 'ingreso',
  /** Editar y eliminar atenciones y sus adjuntos. */
  EDITAR_CLINICO: 'editar_clinico',
  /** Procedimientos, catálogos, sincronización e importar respaldos. */
  AJUSTES: 'ajustes',
  /** Crear y editar cuentas; ver el registro de accesos. */
  USUARIOS: 'usuarios',
});

/** ¿Es una profesión clínica? @param {unknown} rol */
const isClinicalRole = (rol) => CLINICAL_ROLES.includes(/** @type {string} */ (rol));

/**
 * ¿Puede esta cuenta hacer esto? Sin cuenta (cuentas no activadas, o modo
 * práctica) todo está permitido, como antes de la 2.16.
 * @param {{rol?: string, admin?: boolean} | null | undefined} user
 * @param {string} permission uno de PERMISSIONS
 */
export function can(user, permission) {
  if (!user) return true;
  switch (permission) {
    case PERMISSIONS.VER:
    case PERMISSIONS.INGRESO:
      return true;
    case PERMISSIONS.EDITAR_CLINICO:
      return isClinicalRole(user.rol);
    case PERMISSIONS.AJUSTES:
    case PERMISSIONS.USUARIOS:
      return user.admin === true;
    default:
      return false;
  }
}
