/**
 * Netlify Function PROGRAMADA (cada hora): respaldo incremental del contenido
 * de los adjuntos (cifrado), en `hhr-rondas-respaldos` bajo `adjuntos/`, y del
 * registro de accesos, bajo `auditoria/`.
 * Cada ejecución copia lo que alcanza en 20 s; la siguiente continúa.
 * Lógica en src/sync/backup.js (tests/backup.test.js). Ver docs/OPERACION.md.
 */
import { getStore } from '@netlify/blobs';
import { backupAttachments, backupAuditLog } from '../../src/sync/backup.js';

export default async () => {
  const started = Date.now();
  const source = getStore({ name: 'hhr-rondas', consistency: 'strong' });
  const target = getStore({ name: 'hhr-rondas-respaldos', consistency: 'strong' });
  const r = await backupAttachments({ source, target });
  // Registro de accesos (ADR 0014): también incremental, con su propio tope de tiempo.
  const a = await backupAuditLog({ source, target });
  console.log(JSON.stringify({ fn: 'respaldo-adjuntos', ...r, auditoria: a, ms: Date.now() - started }));
};

export const config = { schedule: '@hourly' };
