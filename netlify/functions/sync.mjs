/**
 * Netlify Function: servidor de sincronización cifrada.
 * La lógica está en src/sync/server.js (probada en tests/sync.test.js).
 *
 * Configuración en Netlify (Site configuration → Environment variables):
 *   SYNC_TOKEN_SHA256              huella de la contraseña del equipo (todas las especialidades)
 *   SYNC_TOKEN_SHA256_<ESPECIALIDAD>  opcional: contraseña propia de una especialidad,
 *                                    p. ej. SYNC_TOKEN_SHA256_OFTALMOLOGIA
 */
import { getStore } from '@netlify/blobs';
import { createSyncHandler } from '../../src/sync/server.js';

const hashFor = (esp) =>
  (process.env[`SYNC_TOKEN_SHA256_${esp.toUpperCase().replace(/-/g, '_')}`] || process.env.SYNC_TOKEN_SHA256 || '').trim().toLowerCase();

export default async (req) => {
  const handler = createSyncHandler({
    store: getStore({ name: 'hhr-rondas', consistency: 'strong' }),
    tokenHash: hashFor,
    // Una línea JSON por solicitud (sin token ni datos): acción, especialidad, estado, duración, código.
    log: (entry) => console.log(JSON.stringify({ fn: 'sync', ...entry })),
  });
  return handler(req);
};

export const config = { path: '/api/sync/:action' };
