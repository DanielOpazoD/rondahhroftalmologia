import { test, expect } from './fixtures.js';
import { openApp, tab, showPatientRecord } from './helpers.js';

test('guardado automático: lo escrito se guarda solo tras una pausa, sin pulsar Guardar', async ({ page }) => {
  await openApp(page);
  // Sin nombre ni RUT aún no se puede guardar: la barra dice por qué.
  await page.locator('#od_pio').fill('17');
  await expect(page.locator('#tbState')).toContainText('Sin guardar');
  await page.locator('#paciente_nombres').fill('Paciente Automático');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  // Más cambios: se guardan solos y el historial los junta en una entrada.
  await page.locator('#od_pio').fill('21');
  await page.locator('#plan').fill('Control en 1 mes');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  await page.locator('#oi_pio').fill('19');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  await page.locator('#histCard summary').click();
  await expect(page.locator('#histList > li')).toHaveCount(2); // creada + una edición que junta todo
  await expect(page.locator('#histList')).toContainText('PIO');
  // Recargar: todo quedó guardado, sin haber pulsado «Guardar».
  await page.reload();
  await showPatientRecord(page, 'Paciente Automático');
  await page.locator('#patAttentions .pmain').first().click();
  await expect(page.locator('#od_pio')).toHaveValue('21');
  await expect(page.locator('#oi_pio')).toHaveValue('19');
  await expect(page.locator('#plan')).toHaveValue('Control en 1 mes');
});

test('guardado automático: no duplica una atención del mismo paciente ese día', async ({ page }) => {
  await openApp(page);
  await page.locator('#paciente_nombres').fill('Paciente Único');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  await page.locator('#bNew').click();
  await page.locator('#paciente_nombres').fill('Paciente Único');
  await expect(page.locator('#tbState')).toContainText('continúa en la atención existente', { timeout: 5000 });
  await page.waitForTimeout(1600);
  await tab(page, 'Pacientes');
  await showPatientRecord(page, 'Paciente Único');
  await expect(page.locator('#patAttentions .prow')).toHaveCount(1);
});
