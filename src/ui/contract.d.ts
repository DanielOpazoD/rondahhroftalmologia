/**
 * Contratos de la interfaz: las acciones del contexto (ver ui/context.js) y
 * los servicios que main.js le asigna.
 *
 * Cada módulo de ui/actions/ declara con `@returns` que devuelve su parte, y
 * el verificador de tipos comprueba la implementación contra este contrato.
 * Se declara aquí, y no se deduce con `ReturnType`, para romper la
 * circularidad: las acciones reciben el contexto completo (`AppContext`), que
 * a su vez incluye las acciones. Sin contrato, ese parámetro era `any`.
 */
import type { Atencion, Perfil, Operativo, Procedimiento, Adjunto } from '../domain';
import type { AtencionEnBlanco } from '../core/record.js';
import type { FormKind } from '../core/clinicalForms.js';
import type { CuentaActiva } from '../sync/accountSession.js';

/** Atención en edición: guardar, abrir, unir y eliminar (actions/attention.js). */
export interface AttentionActions {
  /** Guarda la atención en edición; `auto`: guardado automático (silencioso). */
  save(o?: { auto?: boolean }): Promise<boolean>;
  newAttention(): Promise<void>;
  openRecord(id: string): Promise<void>;
  /** Continúa en la atención existente `id` del mismo paciente, llevándose lo escrito. */
  joinExisting(id: string, o?: { silent?: boolean }): void;
  /** Incorpora cambios llegados de otro equipo sin perder lo que se está escribiendo. */
  absorbRemote(fresh: Atencion): void;
  /** Carga una atención guardada en el formulario (sin cambios pendientes). */
  loadIntoForm(r: Atencion): void;
  deleteRecord(id: string): Promise<void>;
}

/** Fichas de pacientes: ingreso, unir, eliminar y editar (actions/patients.js). */
export interface PatientActions {
  admitPatient(
    data: Record<string, string>,
    o: { fecha: string; operativo?: string; pacienteId?: string },
  ): Promise<{ ok: boolean; id?: string }>;
  newAttentionFor(pacienteId: string): Promise<void>;
  fillFromPatient(): boolean;
  syncPatientFromRecord(rec: Atencion): void;
  /** Crea las fichas que falten a partir de las atenciones; devuelve cuántas. */
  ensurePatients(): number;
  mergePatients(keepId: string, dropId: string): Promise<boolean>;
  deletePatient(id: string): Promise<boolean>;
  editPatient(id: string): void;
  notDuplicates(aId: string, bId: string): void;
}

/** Procedimientos, perfiles y operativos (actions/catalogs.js). */
export interface CatalogActions {
  setProcs(procs: Procedimiento[]): void;
  seedCatalogs(): void;
  reloadCatalogs(): void;
  saveCatalog<T extends Perfil | Operativo>(kind: 'medico' | 'operativo', item: T): T | undefined;
  deleteCatalog(kind: 'medico' | 'operativo', id: string): void;
}

/** PDF, nota y clave de seudonimización (actions/outputs.js). */
export interface OutputActions {
  downloadPdf(atencion: Atencion | AtencionEnBlanco, button: HTMLButtonElement): Promise<void>;
  copyNote(rec: Atencion | AtencionEnBlanco): Promise<void>;
  ensureSecret(): string;
}

/** Adjuntos de la atención (actions/attachments.js). */
export interface AttachmentActions {
  addAttachments(files: File[]): Promise<void>;
  addMissingThumbnails(metas: Adjunto[]): Promise<number>;
  openAttachment(id: string): Promise<void>;
  deleteAttachment(id: string): Promise<void>;
  removeAttachmentsOf(metas: Adjunto[]): void;
}

/** Constancia GES, IPD y receta (actions/forms.js). */
export interface FormActions {
  hasClinicalForms: boolean;
  openForms(button: HTMLButtonElement): Promise<void>;
  rememberForm(owner: Atencion, kind: FormKind, previous: Record<string, string>, values: Record<string, string>): boolean;
}

/** Todas las acciones que se agregan al contexto. */
export type ContextActions = AttentionActions & PatientActions & CatalogActions & OutputActions & AttachmentActions & FormActions;

/**
 * Cuentas de usuario tal como las usa la app (ui/accounts.js, ADR 0014). El
 * controlador recibe el contexto, así que su forma se declara aquí.
 */
export interface AccountsService {
  /** Al abrir la app: recupera la sesión de la pestaña o muestra el ingreso. */
  start(): void;
  show(message?: string): void;
  logout(motivo?: 'salir' | 'inactividad' | 'cierre'): Promise<void>;
  render(): void;
  /** Anota un evento en el registro de accesos (lectura de fichas, descargas…). */
  event(ev: string, obj?: string, extra?: { n?: number }): void;
  changeMyPassword(): void;
  token(): string | null;
  ensureToken(): Promise<string | null>;
  requireToken(): Promise<string>;
  verifyPassword(password: string): Promise<boolean>;
  flushEvents(): Promise<number>;
  /** El servidor rechazó la sesión: se pide entrar si hace falta. */
  onAuthError(code: string): false | void;
  /** ¿Este PC trabaja con cuentas de usuario? */
  readonly active: boolean;
  /** Persona en la sesión (null si no hay cuentas o aún no entra). */
  readonly user: CuentaActiva | null;
  /** Ejecuta `fn` cuando haya sesión (de inmediato si no se usan cuentas o ya hay). */
  whenReady(fn: () => void): void;
}
