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
import { createAccounts } from '../../src/sync/accounts.js';

/** Huella de la contraseña de una especialidad (o la del equipo). @param {string} esp */
const hashFor = (esp) =>
  (process.env[`SYNC_TOKEN_SHA256_${esp.toUpperCase().replace(/-/g, '_')}`] || process.env.SYNC_TOKEN_SHA256 || '').trim().toLowerCase();

/** @param {Request} req */
export default async (req) => {
  const store = getStore({ name: 'hhr-rondas', consistency: 'strong' });
  const handler = createSyncHandler({
    store,
    tokenHash: hashFor,
    // Cuentas de usuario (ADR 0014): una vez activadas, se exige sesión en vez de la contraseña del equipo.
    accounts: createAccounts({ store, secret: (process.env.SYNC_TOKEN_SHA256 || '').trim().toLowerCase() }),
    // Una línea JSON por solicitud (sin token ni datos): acción, especialidad, estado, duración, código.
    log: (entry) => console.log(JSON.stringify({ fn: 'sync', ...entry })),
  });
  return handler(req);
};

export const config = { path: '/api/sync/:action' };
