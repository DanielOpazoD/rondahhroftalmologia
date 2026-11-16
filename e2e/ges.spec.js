import { test, expect } from './fixtures.js';
import { openApp, fillPatient, save, ajustes, tab } from './helpers.js';
import { GES_PATOLOGIAS } from '../src/specialties/oftalmologia/config.js';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

// El PC está en UTC: la constancia debe seguir usando el reloj de Rapa Nui.
test.use({ timezoneId: 'UTC' });

async function openGes(page) {
  await page.locator('#bForms').click();
  await page.getByRole('menuitem', { name: /^Constancia GES/ }).click();
  return page.getByRole('dialog', { name: 'Constancia GES' });
}

test('constancia GES: datos autocompletados, selección, validación y descarga desde la atención visible', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-16T03:30:00Z') });
  await openApp(page);
  await fillPatient(page, { nombre: 'Ana GES Prueba', rut: '12.345.678-5', fecha: '2020-02-03' });
  await page.locator('#paciente_fono').fill('+56 9 1234 5678');
  await page.locator('#medicoSel').selectOption('__nuevo');
  await page.locator('#dlg_nombres').fill('Profesional GES Prueba');
  await page.locator('#dlg_rut').fill('11.111.111-1');
  await page.locator('#dlgOk').click();
  await save(page);
  await page.locator('#dlgOk').click(); // confirmar quién registra en la sesión local
  const dlg = await openGes(page);
  await expect(dlg.getByLabel('Nombre legal', { exact: true })).toHaveValue('Ana GES Prueba');
  await expect(dlg.getByLabel('Nombre del profesional')).toHaveValue('Profesional GES Prueba');
  await expect(dlg.getByLabel('Teléfono celular')).toHaveValue('+56 9 1234 5678');
  await expect(dlg.getByLabel('Comuna', { exact: true })).toHaveValue('Isla de Pascua');
  await expect(dlg.getByLabel('Región', { exact: true })).toHaveValue('Quinta región');
  await expect(dlg.getByLabel('Fecha de notificación')).toHaveValue('2026-11-15');
  await expect(dlg.getByLabel('Hora de notificación')).toHaveValue('22:30');
  const select = dlg.getByLabel('Confirmación diagnóstica GES');
  expect(await select.locator('option').allTextContents()).toEqual(['Selecciona una patología', ...GES_PATOLOGIAS]);
  await dlg.getByRole('button', { name: 'Descargar constancia GES' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Selecciona una patología GES de la lista.');
  await select.selectOption(GES_PATOLOGIAS[4]);
  await dlg.getByLabel('Previsión').selectOption('fonasa');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dlg.getByRole('button', { name: 'Descargar constancia GES' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Constancia_GES_2026-11-15_12_345_678-5_Ana_GES_Prueba.pdf');
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getForm().getFields()).toHaveLength(0);
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#fecha_atencion')).toHaveValue('2020-02-03');
  await expect(page.locator('#paciente_fono')).toHaveValue('+56 9 1234 5678');
});

test('cerrar GES conserva el formulario sin cambiar los datos demográficos y otro paciente empieza de cero', async ({ page }) => {
  await openApp(page);
  await fillPatient(page, { nombre: 'Primer Paciente Prueba', rut: '12.345.678-5' });
  let dlg = await openGes(page);
  await dlg.getByLabel('Nombre legal', { exact: true }).fill('Cambio solo en el formulario');
  await dlg.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.locator('#paciente_nombre')).toHaveValue('Primer Paciente Prueba');
  await expect(page.locator('#bForms')).toBeFocused();
  await page.locator('#bNew').click();
  await fillPatient(page, { nombre: 'Segundo Paciente Prueba', rut: '11.111.111-1' });
  await page.locator('#paciente_fono').fill('912345678');
  dlg = await openGes(page);
  await expect(dlg.getByLabel('Nombre legal', { exact: true })).toHaveValue('Segundo Paciente Prueba');
  await expect(dlg.getByLabel('Teléfono celular')).toHaveValue('912345678');
  await expect(dlg.getByLabel('Confirmación diagnóstica GES')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('GES se descarga sin red y el modo práctica conserva el prefijo en el archivo', async ({ page, context }) => {
  await page.goto('/?practica');
  await page.locator('#dlgOk').click(); // perfil de práctica al iniciar
  await expect(page.locator('#dlg')).toBeHidden();
  await fillPatient(page, { nombre: 'Paciente GES Práctica', rut: '12.345.678-5' });
  await context.setOffline(true);
  const dlg = await openGes(page);
  await dlg.getByLabel('Nombre del profesional').fill('Profesional Prueba');
  await dlg.getByLabel('RUT del profesional').fill('11.111.111-1');
  await dlg.getByLabel('Confirmación diagnóstica GES').selectOption(GES_PATOLOGIAS[0]);
  await dlg.getByLabel('Previsión').selectOption('fonasa');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dlg.getByRole('button', { name: 'Descargar constancia GES' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^PRACTICA_Constancia_GES_/);
});

test('bloquear por inactividad descarta la constancia y sus datos antes de volver a la sesión', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await ajustes(page, 'Este equipo');
  await page.locator('#pinSet').click();
  await page.locator('#dlg_pin').fill('4821');
  await page.locator('#dlg_pin2').fill('4821');
  await page.locator('#dlgOk').click();
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await tab(page, 'Atención');
  await fillPatient(page, { nombre: 'Paciente GES Privado', rut: '12.345.678-5' });
  const dlg = await openGes(page);
  await expect(dlg).toBeVisible();
  await page.clock.fastForward('10:30');
  await expect(page.locator('#lockDlg')).toBeVisible();
  await expect(dlg).toHaveCount(0);
  await page.locator('#lockPin').fill('4821');
  await page.locator('#lockGo').click();
  await expect(page.locator('#lockDlg')).toBeHidden();
  await expect(dlg).toHaveCount(0);
});
