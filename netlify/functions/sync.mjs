/**
 * Netlify Function: servidor de sincronización cifrada.
 * La lógica está en src/sync/server.js (probada en tests/sync.test.js).
 *
 * Configuración en Netlify (Site configuration → Environment variables):
 *   SYNC_TOKEN_SHA256 = valor que muestra la app en Ajustes → Sincronización.
 */
import { getStore } from '@netlify/blobs';
import { createSyncHandler } from '../../src/sync/server.js';

export default async (req) => {
  const handler = createSyncHandler({
    store: getStore({ name: 'oftalmo-sync', consistency: 'strong' }),
    tokenHash: (process.env.SYNC_TOKEN_SHA256 || '').trim().toLowerCase(),
  });
  return handler(req);
};

export const config = { path: '/api/sync/:action' };
