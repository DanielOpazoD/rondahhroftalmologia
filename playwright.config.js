// Pruebas de extremo a extremo (navegador real) sobre el sitio construido en dist/
// servido por scripts/dev-server.mjs, con un servidor de sincronización en memoria.
import { defineConfig, devices } from '@playwright/test';
import { deriveTeamKeys, tokenHash } from './src/sync/crypto.js';

/** Contraseña de PRUEBA (solo para el servidor local de las pruebas). */
export const TEST_PASS = 'K7QM3-XRT9P-ZAWD4-N8F2C';
const { token } = await deriveTeamKeys(TEST_PASS);
const PORT = 8799;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'es-CL',
    timezoneId: 'Pacific/Easter',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'] }, testIgnore: /movil\.spec\.js/ },
    { name: 'celular', use: { ...devices['Pixel 7'] }, testMatch: /movil\.spec\.js/ },
  ],
  webServer: {
    command: 'npm run build && node scripts/dev-server.mjs',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), SYNC_TOKEN_SHA256: tokenHash(token) },
    timeout: 120_000,
  },
});
