import { expect } from '@playwright/test';

export const TEST_PASS = 'K7QM3-XRT9P-ZAWD4-N8F2C';

/** Abre la app con almacenamiento limpio. */
export async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#tbName')).toHaveText('Nueva atención');
}

/** Va a una pestaña por su nombre visible. */
export async function tab(page, name) {
  await page.getByRole('tab', { name }).click();
}

/** Completa lo mínimo de una atención. */
export async function fillPatient(page, { nombre, rut, fecha = '2026-11-14' }) {
  await page.locator('#fecha_atencion').fill(fecha);
  await page.locator('#paciente_nombre').fill(nombre);
  if (rut) await page.locator('#paciente_rut').fill(rut);
}

export async function save(page) {
  await page.locator('#bSave').click();
}

/** Activa la sincronización con la contraseña de prueba. */
export async function activateSync(page) {
  await tab(page, 'Ajustes');
  await page.locator('#syncPass').fill(TEST_PASS);
  await page.locator('#syncOn').click();
  await expect(page.locator('#syncState')).toHaveText(/Activa|Sincronizando/, { timeout: 20_000 });
  await expect(page.locator('#syncBadge')).toHaveText('Sincronizado', { timeout: 20_000 });
}

export async function syncNow(page) {
  await tab(page, 'Ajustes');
  await page.locator('#syncNowBtn').click();
  await expect(page.locator('#syncBadge')).toHaveText('Sincronizado', { timeout: 20_000 });
}

/** Abre la atención de un paciente desde la lista. */
export async function openPatient(page, nombre) {
  await tab(page, 'Pacientes');
  await page.locator('.pmain', { hasText: nombre }).click();
  await expect(page.locator('#tbName')).toHaveText(nombre);
}
