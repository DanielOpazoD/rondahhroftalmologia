import { test, expect } from './fixtures.js';
import { openApp, fillPatient, save } from './helpers.js';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

// PC en UTC y visor PDF real: la fecha corresponde siempre al hospital.
test.use({ timezoneId: 'UTC', channel: 'chromium' });

async function openReceta(page) {
  await page.locator('#bForms').click();
  await page.getByRole('menuitem', { name: /^Receta para lentes/ }).click();
  return page.getByRole('dialog', { name: 'Receta para lentes' });
}

async function prepare(page) {
  await openApp(page);
  await page.locator('#paciente_apellido_paterno').fill('Ejemplo');
  await page.locator('#paciente_apellido_materno').fill('Ficticio');
  await page.locator('#paciente_nombres').fill('Paciente de Prueba');
  await page.locator('#paciente_rut').fill('12.345.678-5');
  await page.locator('#paciente_fnac').fill('1959-03-20');
  await page.locator('#medicoSel').selectOption('__nuevo');
  await page.locator('#dlg_apellido_paterno').fill('Prueba');
  await page.locator('#dlg_apellido_materno').fill('Ficticio');
  await page.locator('#dlg_nombres').fill('Profesional');
  await page.locator('#dlg_rut').fill('11.111.111-1');
  await page.locator('#dlgOk').click();
  await save(page);
  await page.locator('#dlgOk').click();
}

test('receta: propone paciente y profesional, permite correcciones y descarga los campos originales editables', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-16T03:30:00Z') });
  await prepare(page);
  const dlg = await openReceta(page);
  await expect(dlg.getByLabel('Nombre del paciente')).toHaveValue('Ejemplo Ficticio Paciente de Prueba');
  await expect(dlg.getByLabel('RUT del paciente')).toHaveValue('12.345.678-5');
  await expect(dlg.getByLabel('Edad', { exact: true })).toHaveValue('67');
  await expect(dlg.getByLabel('Nombre del profesional')).toHaveValue('Prueba Ficticio Profesional');
  await expect(dlg.getByLabel('Fecha de la receta')).toHaveValue('2026-11-15');
  await expect(dlg.getByLabel('Lejos OD', { exact: true })).toHaveValue('');
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('-1,00 '.repeat(100));
  await dlg.getByRole('button', { name: 'Descargar receta' }).click();
  await expect(dlg.getByRole('alert')).toContainText('no cabe');
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('−1,00 −0,50 x 90');
  await dlg.getByLabel('Lejos OI', { exact: true }).fill('-1,25 -0,75 x 80');
  await dlg.getByLabel('DP de lejos').fill('64');
  await dlg.getByLabel('Cerca OD', { exact: true }).fill('+1,50 -0,50 x 90');
  await dlg.getByLabel('Cerca OI', { exact: true }).fill('+1,25 -0,75 x 80');
  await dlg.getByLabel('DP de cerca').fill('61');
  await dlg.getByLabel('Eje TABO OD').fill('90');
  await dlg.getByLabel('Eje TABO OI').fill('80');
  await dlg.getByLabel('Nombre del paciente').fill('Ejemplo Ficticio Nombre Corregido');
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Descargar receta' }).click()]);
  expect(download.suggestedFilename()).toBe('Receta_Lentes_2026-11-15_12_345_678-5_Ejemplo_Ficticio_Nombre_Corregido.pdf');
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  const form = pdf.getForm();
  expect(pdf.getPageCount()).toBe(1);
  expect(form.getFields()).toHaveLength(14);
  expect(form.getTextField('paciente_nombre').getText()).toBe('Ejemplo Ficticio Nombre Corregido');
  expect(form.getTextField('lejos_od').getText()).toBe('-1,00 -0,50 x 90');
  expect(form.getTextField('cerca_oi').getText()).toBe('+1,25 -0,75 x 80');
  expect(form.getTextField('tabo_eje_od').getText()).toBe('90');
  expect(form.getTextField('fecha').getText()).toBe('15-11-2026');
  expect(form.getTextField('lejos_od').isReadOnly()).toBe(false);
  expect(form.getSignature('oftalmologo_firma')).toBeTruthy();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#paciente_nombre')).toHaveValue('Ejemplo Ficticio Paciente de Prueba');
  const reopened = await openReceta(page);
  await expect(reopened.getByLabel('Nombre del paciente')).toHaveValue('Ejemplo Ficticio Nombre Corregido');
  await expect(reopened.getByLabel('Lejos OD', { exact: true })).toHaveValue('−1,00 −0,50 x 90');
});

test('receta: diálogo compacto, cierre y datos del siguiente paciente sin arrastrar la graduación', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openApp(page);
  await fillPatient(page, { nombre: 'Primer Paciente Ficticio', rut: '12.345.678-5' });
  let dlg = await openReceta(page);
  expect(await dlg.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('-2,00');
  await dlg.getByLabel('Nombre del paciente').fill('Solo en el formulario');
  await dlg.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.locator('#bForms')).toBeFocused();
  await expect(page.locator('#paciente_nombre')).toHaveValue('Primer Paciente Ficticio');
  await page.locator('#bNew').click();
  await fillPatient(page, { nombre: 'Segundo Paciente Ficticio', rut: '11.111.111-1' });
  await page.setViewportSize({ width: 390, height: 844 });
  dlg = await openReceta(page);
  await expect(dlg.getByLabel('Nombre del paciente')).toHaveValue('Segundo Paciente Ficticio');
  await expect(dlg.getByLabel('Lejos OD', { exact: true })).toHaveValue('');
  expect(await dlg.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('receta: descarga sin conexión en modo práctica', async ({ page, context }) => {
  await page.goto('/?practica');
  await page.locator('#dlgOk').click();
  await expect(page.locator('#dlg')).toBeHidden();
  await fillPatient(page, { nombre: 'Paciente Ficticio Práctica', rut: '12.345.678-5' });
  await context.setOffline(true);
  const dlg = await openReceta(page);
  await dlg.getByLabel('Nombre del profesional').fill('Profesional Ficticio');
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Descargar receta' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^PRACTICA_Receta_Lentes_/);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getForm().getTextField('paciente_nombre').getText()).toBe('Paciente Ficticio Práctica');
});

test('receta: PDF visible, solicitud de impresión del documento y cierre al bloquear', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__pdfPrints = [];
    document.addEventListener(
      'load',
      (event) => {
        const frame = event.target;
        if (frame instanceof HTMLIFrameElement && frame.src.startsWith('blob:')) {
          // El diálogo nativo no se automatiza; se observa print en el iframe del PDF real.
          frame.contentWindow.print = () => window.__pdfPrints.push(frame.src);
        }
      },
      true,
    );
  });
  await prepare(page);
  const dlg = await openReceta(page);
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('-1,00');
  await page.screenshot({ path: 'test-results/receta-formulario.png' });
  await dlg.getByRole('button', { name: 'Imprimir', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Vista previa del PDF' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('iframe')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => page.evaluate(() => window.__pdfPrints.length)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('chrome-extension://'))).toBe(true);
  const [download] = await Promise.all([page.waitForEvent('download'), preview.getByRole('button', { name: 'Descargar PDF' }).click()]);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getForm().getTextField('lejos_od').getText()).toBe('-1,00');
  await preview.getByRole('button', { name: 'Volver al formulario' }).click();
  await expect(preview).toHaveCount(0);
  await expect(dlg.getByLabel('Lejos OD', { exact: true })).toHaveValue('-1,00');
  await dlg.getByRole('button', { name: 'Imprimir', exact: true }).click();
  await expect(preview).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('locked'));
  await expect(preview).toHaveCount(0);
  await expect(dlg).toHaveCount(0);
  expect(errors).toEqual([]);
});
