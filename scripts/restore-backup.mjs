#!/usr/bin/env node
/**
 * Restaura un respaldo diario del servidor (ver docs/OPERACION.md).
 *
 *   NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/restore-backup.mjs --list
 *   NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/restore-backup.mjs 2026-11-20 --dry-run
 *   NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/restore-backup.mjs 2026-11-20
 *
 * No borra nada del servidor: vuelve a escribir las versiones del respaldo; si
 * ya hay una más nueva de un elemento, sigue ganando esa. Los datos siguen
 * cifrados (el script nunca ve contenido legible).
 */
import { getStore } from '@netlify/blobs';
import { listBackups, restoreBackup } from '../src/sync/backup.js';

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error('Faltan NETLIFY_SITE_ID y NETLIFY_AUTH_TOKEN (token personal de Netlify).');
  process.exit(1);
}
const respaldos = getStore({ name: 'hhr-rondas-respaldos', siteID, token });
const sync = getStore({ name: 'hhr-rondas', siteID, token, consistency: 'strong' });
const args = process.argv.slice(2);

if (!args.length || args.includes('--list')) {
  const days = await listBackups(respaldos);
  console.log(days.length ? `Respaldos disponibles:\n${days.join('\n')}` : 'No hay respaldos.');
} else {
  const day = args[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('Indica el día como AAAA-MM-DD (o --list).');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const r = await restoreBackup({ source: respaldos, target: sync, day, dryRun });
  console.log(
    dryRun
      ? `Prueba: se restaurarían ${r.claves} versiones del ${day}.`
      : `Restauradas ${r.escritas} versiones del ${day}. Recarga la app en los PC.`,
  );
}
