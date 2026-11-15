import { test, expect } from '@playwright/test';
import { openApp, tab, fillPatient, save, openPatient, activateSync, syncNow } from './helpers.js';

test('migra a IndexedDB las atenciones guardadas por versiones anteriores', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    localStorage.setItem(
      'oft_atenciones_v1',
      JSON.stringify([{ id: 'old1', updated: 5, f: { paciente_nombre: 'Paciente Antiguo', fecha_atencion: '2026-11-01' } }]),
    );
  });
  await page.reload();
  await tab(page, 'Pacientes');
  await expect(page.locator('.prow', { hasText: 'Paciente Antiguo' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('oft_atenciones_v1'))).toBeNull();
  // Sigue ahí después de recargar: ahora vive en IndexedDB.
  await page.reload();
  await tab(page, 'Pacientes');
  await expect(page.locator('.prow', { hasText: 'Paciente Antiguo' })).toBeVisible();
});

test('historial de cambios con el nombre del equipo', async ({ page }) => {
  await openApp(page);
  await tab(page, 'Ajustes');
  await page.locator('#setDevice').fill('Box Prueba');
  await page.locator('#setDevice').blur();
  await tab(page, 'Atención');
  await fillPatient(page, { nombre: 'Con Historial' });
  await save(page);
  await page.locator('#od_pio').fill('19');
  await save(page);
  await openPatient(page, 'Con Historial');
  const hist = page.locator('#histCard');
  await expect(hist).toBeVisible();
  await expect(hist.locator('#histCount')).toHaveText('2');
  await hist.locator('summary').click();
  const first = hist.locator('#histList > li').first();
  await expect(first.locator('.hmeta')).toContainText('Editada');
  await expect(first.locator('.hmeta')).toContainText('Box Prueba');
  await expect(first).toContainText('PIO OD: vacío → 19');
});

test('el historial incluye lo que grabó otro equipo', async ({ browser }) => {
  const pcA = await browser.newContext();
  const pcB = await browser.newContext();
  const A = await pcA.newPage();
  const B = await pcB.newPage();
  for (const [P, name] of [
    [A, 'Box A'],
    [B, 'Box B'],
  ]) {
    await openApp(P);
    await tab(P, 'Ajustes');
    await P.locator('#setDevice').fill(name);
    await P.locator('#setDevice').blur();
    await activateSync(P);
  }
  await tab(A, 'Atención');
  await fillPatient(A, { nombre: 'Historial Compartido' });
  await save(A);
  await syncNow(A);
  await syncNow(B);
  await openPatient(B, 'Historial Compartido');
  await B.locator('#plan').fill('Lentes');
  await save(B);
  await syncNow(B);
  await syncNow(A);
  await openPatient(A, 'Historial Compartido');
  await A.locator('#histCard summary').click();
  await expect(A.locator('#histList')).toContainText('Box B');
  await expect(A.locator('#histList')).toContainText('Box A');
  await expect(A.locator('#histList')).toContainText('Plan: vacío → Lentes');
  await pcA.close();
  await pcB.close();
});
