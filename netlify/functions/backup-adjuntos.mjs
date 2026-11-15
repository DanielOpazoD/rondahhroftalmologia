/**
 * Netlify Function PROGRAMADA (cada hora): respaldo incremental del contenido
 * de los adjuntos (cifrado), en `hhr-rondas-respaldos` bajo `adjuntos/`.
 * Cada ejecución copia lo que alcanza en 20 s; la siguiente continúa.
 * Lógica en src/sync/backup.js (tests/backup.test.js). Ver docs/OPERACION.md.
 */
import { getStore } from '@netlify/blobs';
import { backupAttachments } from '../../src/sync/backup.js';

export default async () => {
  const started = Date.now();
  const r = await backupAttachments({
    source: getStore({ name: 'hhr-rondas', consistency: 'strong' }),
    target: getStore({ name: 'hhr-rondas-respaldos', consistency: 'strong' }),
  });
  console.log(JSON.stringify({ fn: 'respaldo-adjuntos', ...r, ms: Date.now() - started }));
};

export const config = { schedule: '@hourly' };
