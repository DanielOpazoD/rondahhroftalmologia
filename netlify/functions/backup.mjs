/**
 * Netlify Function PROGRAMADA: respaldo diario del servidor de sincronización.
 * Copia las versiones cifradas del almacén `hhr-rondas` a `hhr-rondas-respaldos`
 * (un documento por día, 30 días). Lógica en src/sync/backup.js (probada en
 * tests/backup.test.js). Restaurar: scripts/restore-backup.mjs (ver docs/OPERACION.md).
 */
import { getStore } from '@netlify/blobs';
import { dailyBackup } from '../../src/sync/backup.js';

export default async () => {
  const started = Date.now();
  const r = await dailyBackup({
    source: getStore({ name: 'hhr-rondas', consistency: 'strong' }),
    target: getStore({ name: 'hhr-rondas-respaldos', consistency: 'strong' }),
  });
  console.log(JSON.stringify({ fn: 'respaldo', ...r, ms: Date.now() - started }));
};

export const config = { schedule: '@daily' };
