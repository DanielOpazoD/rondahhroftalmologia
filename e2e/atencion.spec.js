import { test, expect } from './fixtures.js';
import { openApp, tab, fillPatient, save, openPatient, showPatientRecord, ajustes } from './helpers.js';

test.beforeEach(async ({ page }) => openApp(page));

test('guardar una atención completa y verla en Pacientes', async ({ page }) => {
  await fillPatient(page, { nombre: 'Ana Tuki Prueba', rut: '123456785' });
  await page.locator('#paciente_rut').blur();
  await expect(page.locator('#paciente_rut')).toHaveValue('12.345.678-5');
  await page.locator('#sexSeg button[data-v="F"]').click();
  await page.locator('#dxChips .chip[data-k="diagnostico_glaucoma"]').click();
  await page.locator('#procList .proc[data-id="t_aplan"] button[data-v="AO"]').click();
  await page.locator('#procList .proc[data-id="t_aplan"] input[data-e="od"]').fill('21');
  // Con guardado automático, el estado pasa solo a «Guardando…» y luego a «Guardada».
  await expect(page.locator('#tbState')).toHaveText(/Guardando…|Guardada/);
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
  await expect(page.locator('[data-msg="paciente_nombres"]')).toHaveText('Requerido (nombre o RUT)');
  await expect(page.locator('#paciente_nombres')).toHaveClass(/invalid/);
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
  await page.locator('#bPdf').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^PDF Hoja/ }).click()]);
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
  await dlg.locator('#dlg_nombres').fill('Dra. Prueba E2E');
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

test('ficha creada por error: aparece en «sin atenciones» y se elimina; volver a usarla la restaura', async ({ page }) => {
  await fillPatient(page, { nombre: 'Ficha Por Error' });
  await save(page);
  await showPatientRecord(page, 'Ficha Por Error');
  await page.locator('#patAttentions .prow').first().locator('[data-a="del"]').click();
  await page.locator('#msgDlg').getByRole('button', { name: 'Eliminar' }).click();
  await page.locator('#patBack').click();
  const box = page.locator('#orphBox');
  await expect(box).toBeVisible();
  await expect(page.locator('#orphTitle')).toHaveText('1 ficha sin atenciones');
  await box.locator('summary').click();
  await box.getByRole('button', { name: 'Eliminar ficha de Ficha Por Error' }).click();
  await expect(page.locator('#msgTitle')).toHaveText('Eliminar ficha');
  await page.locator('#msgDlg').getByRole('button', { name: 'Eliminar ficha' }).click();
  await expect(page.locator('#toast')).toHaveText('Ficha eliminada');
  await expect(box).toBeHidden();
  // Persiste al recargar.
  await page.reload();
  await tab(page, 'Pacientes');
  await expect(page.locator('#orphBox')).toBeHidden();
  // Una atención nueva del mismo paciente la vuelve a usar: reaparece.
  await tab(page, 'Atención');
  await fillPatient(page, { nombre: 'Ficha Por Error' });
  await save(page);
  await showPatientRecord(page, 'Ficha Por Error');
  await expect(page.locator('#patAttentions .prow')).toHaveCount(1);
});

test('procedimientos: «PIO» solo en los que la piden; uno quitado de la lista no se muestra ni se cuenta', async ({ page }) => {
  await fillPatient(page, { nombre: 'Paciente Procedimiento' });
  // Marca un procedimiento nuevo (agregado en Ajustes) y guarda.
  await ajustes(page, 'Listas');
  await page.locator('#ajNew').fill('vvv');
  await page.locator('#ajAdd').click();
  const pio = page.locator('#ajList .piotg');
  // Solo T. Aplanática, T. Neumática y Curva de tensión piden PIO (y siguen así tras usar la atención).
  await expect(page.locator('#ajList .piotg.on')).toHaveCount(3);
  await expect(pio.filter({ hasText: /^PIO$/ })).toHaveCount(3);
  await tab(page, 'Atención');
  await page.locator('#procList .proc', { hasText: 'vvv' }).getByRole('button', { name: 'OI' }).click();
  await save(page);
  await expect(page.locator('#procBadge')).toHaveText('1');
  await ajustes(page, 'Listas');
  await expect(page.locator('#ajList .piotg.on')).toHaveCount(3);
  // Se quita «vvv» de la lista: deja de contarse en la atención y en la estadística.
  await page.locator('#ajList .it', { hasText: 'vvv' }).getByRole('button', { name: 'Quitar' }).click();
  await page.locator('#msgDlg').getByRole('button', { name: 'Quitar' }).click();
  await tab(page, 'Atención');
  await expect(page.locator('#procBadge')).toHaveText('0');
  await tab(page, 'Estadística');
  await expect(page.locator('#t-est')).not.toContainText('vvv');
});
