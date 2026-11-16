import { test, expect } from './fixtures.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { openApp, tab, activateSync, syncNow, showPatientRecord, ajustes } from './helpers.js';

/** PNG de 1×1 píxel. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** PDF de una página con texto. */
async function pdfBytes(texto) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.drawText(texto, { x: 20, y: 100, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}

/** Adjunta archivos con el selector. */
const attach = (page, files) => page.locator('#attInput').setInputFiles(files);

test('adjuntos: imagen, PDF y Word en la atención; persisten y se eliminan', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#attAdd')).toBeDisabled(); // sin paciente aún
  await page.locator('#paciente_nombre').fill('Paciente Con Adjuntos');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  await attach(page, [
    { name: 'fondo de ojo.png', mimeType: 'image/png', buffer: PNG },
    { name: 'oct.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('OCT macular') },
    {
      name: 'informe.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('PK fake docx'),
    },
  ]);
  await expect(page.locator('#toast')).toContainText('3 archivos adjuntados');
  await expect(page.locator('#attCount')).toHaveText('3');
  await expect(page.locator('#attList .attthumb')).toHaveCount(1); // miniatura de la imagen
  await expect(page.locator('#attList')).toContainText('informe.docx');
  await page.locator('#histCard summary').click();
  await expect(page.locator('#histList')).toContainText('Adjunto');

  // Persisten al recargar.
  await page.reload();
  await showPatientRecord(page, 'Paciente Con Adjuntos');
  await page.locator('#patAttentions .pmain').first().click();
  await expect(page.locator('#attCount')).toHaveText('3');

  // Eliminar uno.
  await page
    .locator('#attList .attrow', { hasText: 'oct.pdf' })
    .getByRole('button', { name: /Eliminar/ })
    .click();
  await page.locator('#msgDlg').getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.locator('#attCount')).toHaveText('2');
  await expect(page.locator('#attList')).not.toContainText('oct.pdf');
});

test('adjuntos: una foto grande se reduce sola (JPEG, lado mayor 2400 px)', async ({ page }) => {
  await openApp(page);
  await page.locator('#paciente_nombre').fill('Paciente Foto');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  // Foto de 3000×2000 con ruido (como una de celular), creada en el navegador.
  const size = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2000;
    const g = c.getContext('2d');
    const img = g.createImageData(3000, 2000);
    // Ruido aleatorio, como el de un sensor: en PNG pesa mucho; en JPEG reducido, poco.
    for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
    g.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'IMG_0001.png', { type: 'image/png' }));
    const input = document.querySelector('#attInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return blob.size;
  });
  expect(size).toBeGreaterThan(1_000_000);
  await expect(page.locator('#attList .attrow')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('#attList')).toContainText('IMG_0001.jpg');
  const shown = await page.locator('#attList .attmain .muted').textContent();
  expect(shown).toMatch(/(KB|MB)/);
  expect(parseFloat(shown.replace(',', '.'))).toBeLessThan(size / 1024 / 1024);
});

test('adjuntos: viajan cifrados a otro equipo', async ({ browser }) => {
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [A, B] = await Promise.all([ca.newPage(), cb.newPage()]);
  for (const P of [A, B]) {
    await openApp(P);
    await activateSync(P);
  }
  await tab(A, 'Atención');
  await A.locator('#paciente_nombre').fill('Paciente Compartido');
  await expect(A.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  await attach(A, [{ name: 'campo visual.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('Campo visual') }]);
  await expect(A.locator('#attCount')).toHaveText('1');
  await syncNow(A);
  await syncNow(B);
  await showPatientRecord(B, 'Paciente Compartido');
  await B.locator('#patAttentions .pmain').first().click();
  await expect(B.locator('#attList')).toContainText('campo visual.pdf');
  await expect(B.locator('#attList')).not.toContainText('llega al sincronizar');
  await Promise.all([ca.close(), cb.close()]);
});

test('PDF con anexos: desde el botón PDF, la hoja y sus adjuntos en un solo documento', async ({ page }) => {
  await openApp(page);
  await page.locator('#paciente_nombre').fill('Paciente PDF Anexos');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  // Sin adjuntos: el menú ofrece el PDF; «PDF + adjuntos» está desactivado.
  await page.locator('#bPdf').click();
  await expect(page.getByRole('menuitem', { name: /PDF \+ adjuntos/ })).toBeDisabled();
  const [plain] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^PDF Hoja/ }).click()]);
  const plainPages = (await PDFDocument.load(await (await import('node:fs/promises')).readFile(await plain.path()))).getPageCount();
  await attach(page, [
    { name: 'retina.png', mimeType: 'image/png', buffer: PNG },
    { name: 'oct.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('OCT') },
    {
      name: 'informe.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('PK'),
    },
  ]);
  await expect(page.locator('#attCount')).toHaveText('3');
  // «Solo la hoja»: igual que antes.
  await page.locator('#bPdf').click();
  await expect(page.getByRole('menu', { name: 'Descargar PDF' })).toBeVisible();
  const [only] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^PDF Hoja/ }).click()]);
  expect(only.suggestedFilename()).not.toContain('con_anexos');
  // «Con anexos»: hoja + índice + imagen + PDF adjunto; el Word va dentro.
  await page.locator('#bPdf').click();
  const [full] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /PDF \+ adjuntos/ }).click()]);
  expect(full.suggestedFilename()).toMatch(/_con_anexos\.pdf$/);
  const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(await full.path()));
  expect(doc.getPageCount()).toBe(plainPages + 3);
  await expect(page.locator('#toast')).toContainText('1 dentro del PDF');
});

test('seguridad: un SVG o HTML adjunto se descarga, nunca se abre (no ejecuta scripts en la app)', async ({ page, context }) => {
  await openApp(page);
  await page.locator('#paciente_nombre').fill('Paciente SVG');
  await expect(page.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.parent.__pwned=1</script></svg>');
  await attach(page, [{ name: 'dibujo.svg', mimeType: 'image/svg+xml', buffer: svg }]);
  await expect(page.locator('#attCount')).toHaveText('1');
  await expect(page.locator('#attList .attthumb')).toHaveCount(0); // sin miniatura
  let opened = 0;
  context.on('page', () => opened++);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#attList .attmain').click()]);
  expect(dl.suggestedFilename()).toBe('dibujo.svg');
  expect(opened).toBe(0);
});

test('respaldo con adjuntos: se descarga como ZIP y al importarlo en otro equipo trae el contenido', async ({ browser }) => {
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [A, B] = await Promise.all([ca.newPage(), cb.newPage()]);
  await openApp(A);
  await A.locator('#paciente_nombre').fill('Paciente Respaldo Adjuntos');
  await expect(A.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  await attach(A, [{ name: 'retina.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(A.locator('#attCount')).toHaveText('1');
  await ajustes(A, 'Datos');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.locator('#bkExp').click()]);
  expect(dl.suggestedFilename()).toMatch(/^respaldo_oftalmo_.*\.zip$/);
  await expect(A.locator('#toast')).toContainText('con 1 adjunto');
  // Otro equipo, sin sincronización: importa el ZIP.
  await openApp(B);
  await ajustes(B, 'Datos');
  await B.locator('#bkImp').setInputFiles(await dl.path());
  await expect(B.locator('#msgDlg')).toContainText('1 adjunto(s) nuevo(s)');
  await B.locator('#msgDlg').getByRole('button').first().click();
  await showPatientRecord(B, 'Paciente Respaldo Adjuntos');
  await B.locator('#patAttentions .pmain').first().click();
  await expect(B.locator('#attList')).toContainText('retina.png');
  await expect(B.locator('#attList .attthumb')).toHaveCount(1); // el contenido llegó
  await expect(B.locator('#attList')).not.toContainText('llega al sincronizar');
  await Promise.all([ca.close(), cb.close()]);
});

test('miniaturas: se guardan al adjuntar y se ven en otro equipo antes de que llegue el contenido', async ({ browser }) => {
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [A, B] = await Promise.all([ca.newPage(), cb.newPage()]);
  for (const P of [A, B]) {
    await openApp(P);
    await activateSync(P);
  }
  await tab(A, 'Atención');
  await A.locator('#paciente_nombre').fill('Paciente Miniatura');
  await expect(A.locator('#tbState')).toHaveText('Guardada', { timeout: 5000 });
  await attach(A, [{ name: 'retina.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(A.locator('#attList .attthumb')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await syncNow(A);
  // B recibe los metadatos (con la miniatura), pero se le impide bajar el contenido.
  await B.route(
    (url) => url.search.includes('-adjuntos'),
    (route) => route.abort(),
  );
  // (sin el contenido, la pasada termina con error: se espera a que lleguen las atenciones)
  await ajustes(B, 'Este equipo');
  await B.locator('#syncNowBtn').click();
  await tab(B, 'Pacientes');
  await expect(B.locator('#regList')).toContainText('Paciente Miniatura', { timeout: 20_000 });
  await showPatientRecord(B, 'Paciente Miniatura');
  await B.locator('#patAttentions .pmain').first().click();
  await expect(B.locator('#attList')).toContainText('llega al sincronizar');
  await expect(B.locator('#attList .attthumb')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await Promise.all([ca.close(), cb.close()]);
});
