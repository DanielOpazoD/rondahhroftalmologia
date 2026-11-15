import { test, expect } from '@playwright/test';
import { openApp, tab, fillPatient, save, openPatient, showPatientRecord } from './helpers.js';

test.beforeEach(async ({ page }) => openApp(page));

test('guardar una atención completa y verla en Pacientes', async ({ page }) => {
  await fillPatient(page, { nombre: 'Ana Tuki Prueba', rut: '123456785' });
  await page.locator('#paciente_rut').blur();
  await expect(page.locator('#paciente_rut')).toHaveValue('12.345.678-5');
  await page.locator('#sexSeg button[data-v="F"]').click();
  await page.locator('#dxChips .chip[data-k="diagnostico_glaucoma"]').click();
  await page.locator('#procList .proc[data-id="t_aplan"] button[data-v="AO"]').click();
  await page.locator('#procList .proc[data-id="t_aplan"] input[data-e="od"]').fill('21');
  await expect(page.locator('#tbState')).toHaveText('Sin guardar');
  await save(page);
  await expect(page.locator('#toast')).toHaveText('Atención guardada');
  await expect(page.locator('#tbState')).toHaveText('Guardada');

  await tab(page, 'Pacientes');
  const row = page.locator('#regList .prow', { hasText: 'Ana Tuki Prueba' });
  await expect(row).toBeVisible();
  await expect(row.locator('.tag', { hasText: 'Glaucoma' })).toBeVisible();
  await expect(row.locator('.tag', { hasText: '1 atención' })).toBeVisible();
});

test('no guarda sin nombre ni RUT y lo indica junto al campo', async ({ page }) => {
  await save(page);
  await expect(page.locator('[data-msg="paciente_nombre"]')).toHaveText('Requerido (nombre o RUT)');
  await expect(page.locator('#paciente_nombre')).toHaveClass(/invalid/);
});

test('la fecha de nacimiento calcula la edad (solo lectura)', async ({ page }) => {
  await fillPatient(page, { nombre: 'Edad Calculada' });
  await page.locator('#paciente_fnac').fill('1959-11-15');
  await expect(page.locator('#paciente_edad')).toHaveValue('66');
  await expect(page.locator('#paciente_edad')).toHaveJSProperty('readOnly', true);
  await page.locator('#fecha_atencion').fill('2026-11-15');
  await expect(page.locator('#paciente_edad')).toHaveValue('67');
});

test('descarga el PDF con nombre normalizado', async ({ page }) => {
  await fillPatient(page, { nombre: 'Pdf Paciente', rut: '11.111.111-1' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#bPdf').click()]);
  expect(download.suggestedFilename()).toBe('Oftalmo_2026-11-14_11111111-1_Pdf_Paciente.pdf');
});

test('copiar la nota para Eloísa', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fillPatient(page, { nombre: 'Nota Copiada' });
  await page.locator('#bCopy').click();
  await expect(page.locator('#toast')).toHaveText('Nota para Eloísa copiada');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('ATENCIÓN OFTALMOLÓGICA');
  expect(text).toContain('Nota Copiada');
});

test('eliminar pide confirmación con el diálogo de la app', async ({ page }) => {
  await fillPatient(page, { nombre: 'Para Borrar' });
  await save(page);
  await showPatientRecord(page, 'Para Borrar');
  const attention = page.locator('#patAttentions .prow');
  await attention.first().locator('[data-a="del"]').click();
  const dlg = page.locator('#msgDlg');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('#msgTitle')).toHaveText('Eliminar atención');
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  await expect(attention).toHaveCount(1);
  await attention.first().locator('[data-a="del"]').click();
  await dlg.getByRole('button', { name: 'Eliminar' }).click();
  await expect(attention).toHaveCount(0);
});

test('crear un médico desde el menú rellena la atención', async ({ page }) => {
  await page.locator('#medicoSel').selectOption('__nuevo');
  const dlg = page.locator('#dlg');
  await expect(dlg).toBeVisible();
  await dlg.locator('#dlg_nombre').fill('Dra. Prueba E2E');
  await dlg.locator('#dlg_rut').fill('12.345.678-4');
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  await expect(dlg.locator('#dlgErr')).toHaveText('RUT con dígito verificador inválido');
  await dlg.locator('#dlg_rut').fill('12.345.678-5');
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#medicoSel option:checked')).toHaveText('Dra. Prueba E2E · 12.345.678-5');
  await fillPatient(page, { nombre: 'Con Medico' });
  await save(page);
  // Hay perfiles: la primera vez se pregunta quién registra.
  await expect(dlg.locator('#dlgTitle')).toHaveText('¿Quién registra?');
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await openPatient(page, 'Con Medico');
  await expect(page.locator('#medicoSel option:checked')).toHaveText('Dra. Prueba E2E · 12.345.678-5');
});

test('estadística y exportar Excel', async ({ page }) => {
  await fillPatient(page, { nombre: 'Estad Uno' });
  await page.locator('#dxChips .chip[data-k="diagnostico_miopia"]').click();
  await save(page);
  await tab(page, 'Estadística');
  await expect(page.locator('#stOut .kpi').first()).toContainText('1');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#stXlsx').click()]);
  expect(download.suggestedFilename()).toMatch(/^estadistica_oftalmo_.*\.xlsx$/);
});

test('la política de seguridad bloquea scripts inyectados', async ({ page }) => {
  const violations = [];
  page.on('console', (m) => m.type() === 'error' && /Content Security Policy/i.test(m.text()) && violations.push(m.text()));
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inyectado = true';
    document.body.append(s);
  });
  expect(await page.evaluate(() => window.__inyectado)).toBeUndefined();
  expect(violations.length).toBeGreaterThan(0);
});
