import { test, expect } from './fixtures.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { openApp, tab, activateSync, syncNow, showPatientRecord } from './helpers.js';

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
