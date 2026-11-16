import { test, expect } from './fixtures.js';
import { openApp, fillPatient, showPatientRecord, openPatient, activateSync, syncNow, tab } from './helpers.js';

async function openForm(page, name) {
  await page.locator('#bForms').click();
  await page.getByRole('menuitem', { name: new RegExp('^' + name) }).click();
  return page.locator('dialog.clinical-form');
}
const closeForm = (dlg) => dlg.getByRole('button', { name: 'Cerrar', exact: true }).click();

test('formularios: GES, IPD y receta se guardan al escribir, sobreviven a recarga y cada paciente recupera solo sus datos', async ({
  page,
}) => {
  await openApp(page);
  await fillPatient(page, { nombre: 'Primer Paciente Ficticio', rut: '12.345.678-5' });
  let dlg = await openForm(page, 'Constancia GES');
  await dlg.getByLabel('Confirmación diagnóstica GES').selectOption({ index: 2 });
  const pathology = await dlg.getByLabel('Confirmación diagnóstica GES').inputValue();
  await dlg.getByLabel('Previsión').selectOption('fonasa');
  await dlg.getByLabel('Teléfono celular').fill('912345678');
  await closeForm(dlg);
  await expect(page.locator('#paciente_fono')).toHaveValue('');
  dlg = await openForm(page, 'IPD');
  await dlg.getByLabel('Problema de salud AUGE / GES').selectOption('29');
  await dlg.getByLabel('Subgrupo o subproblema AUGE').fill('Presbicia pura');
  await dlg.getByLabel('Diagnóstico', { exact: true }).fill('Diagnóstico ficticio\nSegunda línea');
  await dlg.getByLabel('Fundamentos del diagnóstico').pressSequentially('Fundamento de prueba con varias teclas');
  await closeForm(dlg);
  await expect(page.locator('#histCount')).toHaveText('2');
  dlg = await openForm(page, 'Receta para lentes');
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('-1,00 -0,50 x 90');
  await dlg.getByLabel('DP de lejos').fill('64');
  await dlg.getByLabel('Nombre del profesional').fill('Profesional Ficticio');
  await closeForm(dlg);
  await page.reload();
  dlg = await openForm(page, 'Constancia GES');
  await expect(dlg.getByLabel('Confirmación diagnóstica GES')).toHaveValue(pathology);
  await expect(dlg.getByLabel('Previsión')).toHaveValue('fonasa');
  await expect(dlg.getByLabel('Teléfono celular')).toHaveValue('912345678');
  await closeForm(dlg);
  dlg = await openForm(page, 'IPD');
  await expect(dlg.getByLabel('Problema de salud AUGE / GES')).toHaveValue('29');
  await expect(dlg.getByLabel('Subgrupo o subproblema AUGE')).toHaveValue('Presbicia pura');
  await expect(dlg.locator('datalist option')).toHaveCount(2);
  await expect(dlg.getByLabel('Diagnóstico', { exact: true })).toHaveValue('Diagnóstico ficticio\nSegunda línea');
  await closeForm(dlg);
  dlg = await openForm(page, 'Receta para lentes');
  await expect(dlg.getByLabel('Lejos OD', { exact: true })).toHaveValue('-1,00 -0,50 x 90');
  await expect(dlg.getByLabel('Nombre del profesional')).toHaveValue('Profesional Ficticio');
  await dlg.getByLabel('DP de lejos').fill('');
  await closeForm(dlg);
  await page.reload();
  dlg = await openForm(page, 'Receta para lentes');
  await expect(dlg.getByLabel('DP de lejos')).toHaveValue('');
  await closeForm(dlg);
  await page.locator('#bNew').click();
  await fillPatient(page, { nombre: 'Segundo Paciente Ficticio', rut: '11.111.111-1' });
  dlg = await openForm(page, 'Constancia GES');
  await expect(dlg.getByLabel('Nombre legal', { exact: true })).toHaveValue('Segundo Paciente Ficticio');
  await expect(dlg.getByLabel('Confirmación diagnóstica GES')).toHaveValue('');
  await closeForm(dlg);
  dlg = await openForm(page, 'IPD');
  await expect(dlg.getByLabel('Problema de salud AUGE / GES')).toHaveValue('');
  await expect(dlg.getByLabel('Diagnóstico', { exact: true })).toHaveValue('');
  await closeForm(dlg);
  dlg = await openForm(page, 'Receta para lentes');
  await expect(dlg.getByLabel('Lejos OD', { exact: true })).toHaveValue('');
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('-3,00');
  await closeForm(dlg);
  await showPatientRecord(page, 'Primer Paciente Ficticio');
  dlg = await openForm(page, 'Receta para lentes');
  await expect(dlg.getByLabel('Lejos OD', { exact: true })).toHaveValue('-1,00 -0,50 x 90');
  await expect(dlg.getByLabel('DP de lejos')).toHaveValue('');
  await closeForm(dlg);
  await page.locator('#plan').fill('Control ficticio pendiente');
  await showPatientRecord(page, 'Primer Paciente Ficticio');
  dlg = await openForm(page, 'Receta para lentes');
  await closeForm(dlg);
  await expect(page.locator('#plan')).toHaveValue('Control ficticio pendiente');
  await page.locator('#plan').fill('Control ficticio antes de otro paciente');
  await showPatientRecord(page, 'Segundo Paciente Ficticio');
  dlg = await openForm(page, 'Receta para lentes');
  await expect(dlg.getByLabel('Nombre del paciente')).toHaveValue('Segundo Paciente Ficticio');
  await closeForm(dlg);
  await openPatient(page, 'Primer Paciente Ficticio');
  await expect(page.locator('#plan')).toHaveValue('Control ficticio antes de otro paciente');
});

test('formularios: botón circular fijo, menú exclusivo, ficha compacta y navegación móvil despejada', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openApp(page);
  await fillPatient(page, { nombre: 'Paciente Ficticio Compacto', rut: '12.345.678-5' });
  const button = page.getByRole('button', { name: 'Formularios del paciente', exact: true });
  const before = await button.boundingBox();
  expect(before.width).toBe(before.height);
  expect(await button.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  expect((await button.boundingBox()).y).toBe(before.y);
  await page.locator('#bPdf').click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await button.click();
  await expect(page.getByRole('menu', { name: 'Formularios del paciente' })).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  const ids = ['paciente_rut', 'paciente_apellido_paterno', 'paciente_apellido_materno', 'paciente_nombres'];
  const ys = await Promise.all(ids.map(async (id) => (await page.locator('#' + id).boundingBox()).y));
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(1);
  const height = await page.locator('#paciente_rut').evaluate((el) => el.closest('.card').getBoundingClientRect().height);
  expect(height).toBeLessThan(190);
  await tab(page, 'Pacientes');
  await expect(button).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await button.boundingBox(),
    nav = await page.locator('nav').boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(nav.y - 8);
  await button.click();
  const menu = await page.getByRole('menu', { name: 'Formularios del paciente' }).boundingBox();
  expect(menu.x).toBeGreaterThanOrEqual(8);
  expect(menu.x + menu.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const lastCard = await page.locator('#histCard').boundingBox();
  expect(lastCard.y + lastCard.height).toBeLessThanOrEqual((await button.boundingBox()).y - 8);
});

test('formularios: un fallo de almacenamiento se avisa y evita cerrar hasta guardar el texto pendiente', async ({ page }) => {
  await openApp(page);
  await fillPatient(page, { nombre: 'Paciente Ficticio Almacenamiento', rut: '12.345.678-5' });
  const dlg = await openForm(page, 'Receta para lentes');
  await page.evaluate(() => {
    window.__storageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).includes('borrador_v1')) throw new DOMException('Sin espacio de prueba', 'QuotaExceededError');
      return window.__storageSetItem.call(this, key, value);
    };
  });
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('-2,00');
  await expect(dlg.getByRole('alert')).toContainText('No se pudieron guardar');
  await closeForm(dlg);
  await expect(dlg).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__storageSetItem;
  });
  await closeForm(dlg);
  await expect(dlg).toHaveCount(0);
  const reopened = await openForm(page, 'Receta para lentes');
  await expect(reopened.getByLabel('Lejos OD', { exact: true })).toHaveValue('-2,00');
});

test('formularios: si la atención pendiente no se puede guardar, conserva sus datos antes de abrir otro paciente', async ({ page }) => {
  await openApp(page);
  await fillPatient(page, { nombre: 'Paciente Ficticio Pendiente', rut: '12.345.678-5' });
  await page.locator('#bSave').click();
  await page.locator('#bNew').click();
  await fillPatient(page, { nombre: 'Paciente Ficticio Seleccionado', rut: '11.111.111-1' });
  await page.locator('#bSave').click();
  await openPatient(page, 'Paciente Ficticio Pendiente');
  await page.locator('#plan').fill('Indicaciones ficticias pendientes');
  await page.locator('#fecha_atencion').fill('');
  await showPatientRecord(page, 'Paciente Ficticio Seleccionado');
  await page.locator('#bForms').click();
  await expect(page.getByRole('tab', { name: 'Atención', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tbName')).toHaveText('Paciente Ficticio Pendiente');
  await expect(page.locator('#plan')).toHaveValue('Indicaciones ficticias pendientes');
  await expect(page.locator('#fecha_atencion')).toHaveValue('');
  await expect(page.locator('dialog.clinical-form, #msgDlg[open]')).toHaveCount(0);
});

test('formularios: la sincronización conserva ediciones de dos PC y cierra una ventana que quedó desactualizada', async ({
  page: a,
  browser,
}) => {
  await openApp(a);
  await fillPatient(a, { nombre: 'Paciente Ficticio Dos Equipos', rut: '12.345.678-5' });
  let dlgA = await openForm(a, 'Receta para lentes');
  await closeForm(dlgA);
  await activateSync(a);
  const contextB = await browser.newContext();
  try {
    const b = await contextB.newPage();
    await b.addInitScript(() => {
      window.__revokedFormUrls = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        window.__revokedFormUrls.push(url);
        revoke(url);
      };
      document.addEventListener(
        'load',
        (event) => {
          const frame = event.target;
          if (frame instanceof HTMLIFrameElement && frame.src.startsWith('blob:')) frame.contentWindow.print = () => {};
        },
        true,
      );
    });
    await openApp(b);
    await activateSync(b);
    await openPatient(b, 'Paciente Ficticio Dos Equipos');
    const dlgB = await openForm(b, 'Receta para lentes');
    await dlgB.getByLabel('Lejos OI', { exact: true }).fill('-2,00');
    await dlgB.getByLabel('Nombre del profesional').fill('Profesional Ficticio');
    await dlgB.getByRole('button', { name: 'Imprimir', exact: true }).click();
    const preview = b.getByRole('dialog', { name: 'Vista previa del PDF' });
    await expect(preview).toBeVisible();
    const pdfUrl = await preview.locator('iframe').getAttribute('src');
    await tab(a, 'Atención');
    dlgA = await openForm(a, 'Receta para lentes');
    await dlgA.getByLabel('Lejos OD', { exact: true }).fill('-1,00');
    await closeForm(dlgA);
    await syncNow(a);
    // Invoca el mismo comando mientras el diálogo está abierto, como hace la sincronización de fondo.
    await b.locator('#syncNowBtn').evaluate((el) => el.click());
    await expect(dlgB).toHaveCount(0);
    await expect(preview).toHaveCount(0);
    expect(await b.evaluate((url) => window.__revokedFormUrls.includes(url), pdfUrl)).toBe(true);
    const fresh = await openForm(b, 'Receta para lentes');
    await expect(fresh.getByLabel('Lejos OD', { exact: true })).toHaveValue('-1,00');
    await expect(fresh.getByLabel('Lejos OI', { exact: true })).toHaveValue('-2,00');
    await closeForm(fresh);
    await b.locator('#bForms').click();
    // Actualización del MISMO registro mientras su menú espera una elección.
    await tab(a, 'Atención');
    dlgA = await openForm(a, 'Receta para lentes');
    await dlgA.getByLabel('Lejos OD', { exact: true }).fill('-4,00');
    await closeForm(dlgA);
    await syncNow(a);
    await b.locator('#syncNowBtn').evaluate((el) => el.click());
    await expect(b.locator('#syncBadge')).toHaveText('Sincronizado');
    await b.getByRole('menuitem', { name: /^Receta para lentes/ }).click();
    const current = b.locator('dialog.clinical-form');
    await expect(current.getByLabel('Lejos OD', { exact: true })).toHaveValue('-4,00');
    // Eliminar la atención en otro PC también cierra la ventana, sin recrear el registro.
    await showPatientRecord(a, 'Paciente Ficticio Dos Equipos');
    await a.locator('#patAttentions .prow').first().locator('[data-a="del"]').click();
    await a.locator('#msgDlg').getByRole('button', { name: 'Eliminar', exact: true }).click();
    await syncNow(a);
    await b.locator('#syncNowBtn').evaluate((el) => el.click());
    await expect(current).toHaveCount(0);
  } finally {
    await contextB.close();
  }
});

test('formularios: cerrar durante la generación cancela la salida y conserva lo escrito', async ({ page }) => {
  await openApp(page);
  await fillPatient(page, { nombre: 'Paciente Ficticio Cancelación', rut: '12.345.678-5' });
  const dlg = await openForm(page, 'Receta para lentes');
  await dlg.getByLabel('Nombre del profesional').fill('Profesional Ficticio');
  await dlg.getByLabel('Lejos OD', { exact: true }).fill('-1,00');
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.evaluate(() => {
    window.__formDuringBuild = false;
    const form = document.querySelector('dialog.clinical-form form');
    const observer = new MutationObserver(() => {
      if (![...form.querySelectorAll('input, select, textarea')].every((el) => el.disabled)) return;
      observer.disconnect();
      window.__formDuringBuild = true;
      form.querySelector('[data-action="cancel"]').click();
    });
    observer.observe(form, { attributes: true, subtree: true, attributeFilter: ['disabled'] });
  });
  await dlg.getByRole('button', { name: 'Imprimir', exact: true }).click();
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => window.__formDuringBuild)).toBe(true);
  const restored = await openForm(page, 'Receta para lentes');
  await expect(restored.getByLabel('Lejos OD', { exact: true })).toHaveValue('-1,00');
  await expect(page.getByRole('dialog', { name: 'Vista previa del PDF' })).toHaveCount(0);
  expect(downloads).toHaveLength(0);
});
