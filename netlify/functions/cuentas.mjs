/**
 * Netlify Function: cuentas de usuario, sesiones y registro de accesos (ADR 0014).
 * La lógica está en src/sync/accounts.js (probada en tests/accounts.test.js).
 * Usa como secreto del servidor la variable SYNC_TOKEN_SHA256 (la misma de la sincronización).
 */
import { getStore } from '@netlify/blobs';
import { createAccounts } from '../../src/sync/accounts.js';

export default async (req) =>
  createAccounts({
    store: getStore({ name: 'hhr-rondas', consistency: 'strong' }),
    secret: (process.env.SYNC_TOKEN_SHA256 || '').trim().toLowerCase(),
    // Una línea JSON por solicitud (sin RUT, claves ni datos).
    log: (entry) => console.log(JSON.stringify({ fn: 'cuentas', ...entry })),
  }).handler(req);

export const config = { path: '/api/cuentas/:action' };
