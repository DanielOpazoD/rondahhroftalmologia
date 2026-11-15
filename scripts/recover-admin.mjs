#!/usr/bin/env node
/**
 * Recupera el acceso de ADMINISTRADOR cuando nadie puede entrar como
 * administrador (claves olvidadas). Requiere la contraseña del equipo y un
 * token de Netlify. Ver docs/OPERACION.md («Recuperar un administrador»).
 *
 *   NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/recover-admin.mjs 17.752.753-K
 *   NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… node scripts/recover-admin.mjs 17.752.753-K "Nombre Apellido"
 *
 * La cuenta de ese RUT (o una nueva, si se indica el nombre) queda como
 * administradora activa con la clave inicial (RUT sin dígito verificador); al
 * entrar pide crear una clave nueva. La contraseña del equipo se pide por
 * teclado (no queda en el historial de la terminal) y nunca sale del PC.
 */
import { getStore } from '@netlify/blobs';
import { createInterface } from 'node:readline/promises';
import { deriveTeamKeys, tokenHash, importEncKey, passphraseProblem } from '../src/sync/crypto.js';
import { createAccounts } from '../src/sync/accounts.js';
import { credentialsFor, decryptProfile, encryptProfile } from '../src/sync/accountCrypto.js';
import { accountRut, initialPassword } from '../src/core/accounts.js';

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
const [rutArg, nombre] = process.argv.slice(2);
if (!siteID || !token) {
  console.error('Faltan NETLIFY_SITE_ID y NETLIFY_AUTH_TOKEN (token personal de Netlify).');
  process.exit(1);
}
const rut = accountRut(rutArg);
if (!rut) {
  console.error('Indica un RUT válido, p. ej. 17.752.753-K');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pass = (await rl.question('Contraseña del equipo (XXXXX-XXXXX-XXXXX-XXXXX): ')).trim();
rl.close();
if (passphraseProblem(pass)) {
  console.error('Formato de contraseña del equipo inválido.');
  process.exit(1);
}
const keys = await deriveTeamKeys(pass);
const teamKey = await importEncKey(keys.encKey);
const store = getStore({ name: 'hhr-rondas', siteID, token, consistency: 'strong' });

// La contraseña debe ser la del equipo: debe abrir el perfil de alguna cuenta existente.
const { blobs } = await store.list({ prefix: '_cuentas/u/' });
let ok = false;
for (const b of blobs) {
  const u = await store.get(b.key, { type: 'json' });
  if (
    await decryptProfile(teamKey, u.id, u.perfil).then(
      () => true,
      () => false,
    )
  ) {
    ok = true;
    break;
  }
}
if (!ok) {
  console.error('Esa contraseña no abre los datos de las cuentas: no es la contraseña del equipo.');
  process.exit(1);
}

const accounts = createAccounts({ store, secret: tokenHash(keys.token) });
const r = await accounts.recoverAdmin({
  rut,
  credentials: (uid, complemento) => credentialsFor({ password: initialPassword(rut), teamKeyB64: keys.encKey, uid, complemento }),
  perfil: nombre ? (uid) => encryptProfile(teamKey, uid, { nombre, rut, rol: 'medico' }) : undefined,
});
console.log(
  `${r.creada ? 'Cuenta creada' : 'Cuenta recuperada'}: ${rut} es administrador/a. Entra con la clave inicial ${initialPassword(rut)} y crea una nueva (vence en 7 días).`,
);
