import { test, expect } from './fixtures.js';
import { openApp, save, tab } from './helpers.js';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

test.use({ timezoneId: 'UTC', channel: 'chromium' });
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
async function openIpd(page) {
  await page.locator('#bPdf').click();
  await page.getByRole('menuitem', { name: /^IPD/ }).click();
  return page.getByRole('dialog', { name: 'IPD · Informe del proceso diagnóstico' });
}

test('IPD: autocompleta, deja campos opcionales vacíos, agrupa las 90 patologías y descarga la edición manual', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-16T03:30:00Z') });
  await prepare(page);
  await expect(page.locator('#tbName')).toHaveText('Ejemplo Ficticio Paciente de Prueba');
  const dlg = await openIpd(page);
  await expect(dlg.getByLabel('Fecha del informe')).toHaveValue('2026-11-15');
  await expect(dlg.getByLabel('Hora del informe')).toHaveValue('22:30');
  await expect(dlg.locator('[name="paciente_nombres"]')).toHaveValue('Paciente de Prueba');
  await expect(dlg.locator('[name="profesional_apellido_paterno"]')).toHaveValue('Prueba');
  const select = dlg.getByLabel('Problema de salud AUGE / GES');
  await expect(select.locator('option')).toHaveCount(91);
  await expect(select.locator('optgroup[label="Oftalmología"] option')).toHaveCount(7);
  await select.selectOption('11');
  await expect(dlg.locator('datalist option')).toHaveCount(3);
  await dlg.getByLabel('Subgrupo o subproblema AUGE').fill('Catarata Bilateral');
  await select.selectOption('31');
  await expect(dlg.getByLabel('Subgrupo o subproblema AUGE')).toHaveValue('');
  await expect(dlg.locator('datalist option')).toHaveCount(0);
  await select.selectOption('29');
  await expect(dlg.locator('datalist option')).toHaveCount(2);
  await dlg.getByLabel('Subgrupo o subproblema AUGE').fill('Presbicia pura');
  await dlg.getByLabel('Diagnóstico', { exact: true }).fill('Diagnóstico escrito libremente');
  await dlg.getByLabel('Fundamentos del diagnóstico').fill('Fundamento manual');
  await dlg.getByLabel('Tratamiento e indicaciones').fill('Indicaciones manuales');
  await dlg.locator('[name="paciente_nombres"]').fill('Nombre Corregido');
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Descargar IPD' }).click()]);
  expect(download.suggestedFilename()).toBe('IPD_2026-11-15_12_345_678-5_Ejemplo_Ficticio_Nombre_Corregido.pdf');
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getForm().getFields()).toHaveLength(0);
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#paciente_nombres')).toHaveValue('Paciente de Prueba');
  await tab(page, 'Pacientes');
  await expect(page.locator('#regList')).toContainText('Ejemplo Ficticio Paciente de Prueba');
  await page.reload();
  await expect(page.locator('#tbName')).toHaveText('Ejemplo Ficticio Paciente de Prueba');
});

test('IPD y GES: diálogos compactos caben en 1024×768 y las áreas siguen disponibles en celular', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await prepare(page);
  let dlg = await openIpd(page);
  const bounds = await dlg.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scroll: el.scrollHeight,
    client: el.clientHeight,
    width: el.getBoundingClientRect().width,
  }));
  expect(bounds.height).toBeLessThan(745);
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
  expect(bounds.width).toBeLessThanOrEqual(1024);
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  await page.locator('#bPdf').click();
  await page.getByRole('menuitem', { name: /^Constancia GES/ }).click();
  dlg = page.getByRole('dialog', { name: 'Constancia GES' });
  expect(await dlg.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  dlg = await openIpd(page);
  expect(await dlg.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await dlg.getByLabel('Problema de salud AUGE / GES').selectOption('90');
  await expect(dlg.getByLabel('Problema de salud AUGE / GES')).toHaveValue('90');
});

test('Imprimir abre el PDF local visible y solicita la impresión de ese documento', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__pdfBlobs = new Map();
    const createURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = createURL(blob);
      window.__pdfBlobs.set(url, blob);
      return url;
    };
    window.__pdfPrints = [];
    window.__pdfPrintError = '';
    document.addEventListener(
      'load',
      (event) => {
        const frame = event.target;
        if (!(frame instanceof HTMLIFrameElement) || !frame.src.startsWith('blob:')) return;
        try {
          // Playwright no expone el diálogo nativo: intercepta print del iframe real, como recomienda su documentación.
          frame.contentWindow.print = () => window.__pdfPrints.push(frame.src);
        } catch (e) {
          window.__pdfPrintError = e.message;
        }
      },
      true,
    );
  });
  await prepare(page);
  const dlg = await openIpd(page);
  await dlg.getByLabel('Problema de salud AUGE / GES').selectOption('11');
  await dlg.getByRole('button', { name: 'Imprimir', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Vista previa del PDF' });
  await expect(preview).toBeVisible();
  const frame = preview.locator('iframe');
  await expect(frame).toHaveAttribute('src', /^blob:/);
  await expect(preview.getByRole('button', { name: 'Imprimir', exact: true })).toBeEnabled();
  const pdfInfo = await frame.evaluate(async (el) => {
    const blob = window.__pdfBlobs.get(el.src);
    const b = await blob.arrayBuffer();
    return { type: blob.type, head: new TextDecoder().decode(b.slice(0, 5)), size: b.byteLength };
  });
  expect(pdfInfo.type).toBe('application/pdf');
  expect(pdfInfo.head).toBe('%PDF-');
  expect(pdfInfo.size).toBeGreaterThan(10000);
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://'))).toBe(true);
  await page.screenshot({ path: 'test-results/ipd-preview.png' });
  expect(await page.evaluate(() => window.__pdfPrintError)).toBe('');
  await expect.poll(() => page.evaluate(() => window.__pdfPrints.length)).toBeGreaterThanOrEqual(1);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    preview.getByRole('button', { name: 'Descargar PDF', exact: true }).click(),
  ]);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getPageCount()).toBe(1);
  await preview.getByRole('button', { name: 'Volver al formulario' }).click();
  await expect(preview).toHaveCount(0);
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Imprimir', exact: true }).click();
  await expect(preview).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('locked'));
  await expect(preview).toHaveCount(0);
  await expect(dlg).toHaveCount(0);
  expect(errors).toEqual([]);
});
