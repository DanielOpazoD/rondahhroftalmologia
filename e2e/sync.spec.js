import { test, expect } from './fixtures.js';
import { openApp, fillPatient, save, activateSync, syncNow, openPatient, showPatientRecord, ajustes } from './helpers.js';

/**
 * Dos "PC" (contextos de navegador independientes) contra el mismo servidor:
 * editan campos distintos de la misma atención y ambos terminan con todo.
 */
test('dos PC editan el mismo paciente: se conservan ambos datos', async ({ browser }) => {
  const pcA = await browser.newContext();
  const pcB = await browser.newContext();
  const A = await pcA.newPage();
  const B = await pcB.newPage();
  await openApp(A);
  await openApp(B);
  await activateSync(A);
  await activateSync(B);

  // A registra al paciente
  await A.getByRole('tab', { name: 'Atención' }).click();
  await fillPatient(A, { nombre: 'Paciente Compartido', rut: '10.000.013-K' });
  await save(A);
  await syncNow(A);

  // B lo recibe
  await syncNow(B);
  await openPatient(B, 'Paciente Compartido');
  await openPatient(A, 'Paciente Compartido');

  // Sin sincronizar entre medio: A anota PIO, B anota diagnóstico y plan
  await A.locator('#od_pio').fill('19');
  await save(A);
  await B.locator('#dxChips .chip[data-k="diagnostico_presbicia"]').click();
  await B.locator('#plan').fill('Control en 6 meses');
  await save(B);

  await syncNow(A);
  await syncNow(B);
  await syncNow(A);

  for (const P of [A, B]) {
    await openPatient(P, 'Paciente Compartido');
    await expect(P.locator('#od_pio')).toHaveValue('19');
    await expect(P.locator('#plan')).toHaveValue('Control en 6 meses');
    await expect(P.locator('#dxChips .chip[data-k="diagnostico_presbicia"]')).toHaveClass(/on/);
  }
  await pcA.close();
  await pcB.close();
});

test('atención nueva del mismo paciente el mismo día: ofrece continuar en la existente', async ({ browser }) => {
  const pcA = await browser.newContext();
  const pcB = await browser.newContext();
  const A = await pcA.newPage();
  const B = await pcB.newPage();
  await openApp(A);
  await openApp(B);
  await activateSync(A);
  await activateSync(B);
  await A.getByRole('tab', { name: 'Atención' }).click();
  await fillPatient(A, { nombre: 'Duplicado Evitado', rut: '9.876.543-3' });
  await A.locator('#od_av').fill('20/40');
  await save(A);
  await syncNow(A);
  await syncNow(B);

  await B.getByRole('tab', { name: 'Atención' }).click();
  await fillPatient(B, { nombre: '', rut: '9.876.543-3' });
  await B.locator('#oi_av').fill('20/25');
  await expect(B.locator('#dupBanner')).toBeVisible();
  await B.locator('#dupJoin').click();
  await expect(B.locator('#tbName')).toHaveText('Duplicado Evitado');
  await save(B);
  // La atención existente quedó con lo de ambos PC…
  await expect(B.locator('#od_av')).toHaveValue('20/40');
  await expect(B.locator('#oi_av')).toHaveValue('20/25');
  // …y no se creó una segunda atención para el mismo paciente.
  await showPatientRecord(B, 'Duplicado Evitado');
  await expect(B.locator('#patAttentions .prow')).toHaveCount(1);
  await pcA.close();
  await pcB.close();
});

test('error de sincronización: el aviso queda a la vista hasta cerrarlo (no se pierde en 2 s)', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await ajustes(page, 'Este equipo');
  await page.locator('#syncPass').fill('corta');
  await page.locator('#syncOn').click();
  const notice = page.getByRole('alert').filter({ hasText: 'contraseña' });
  await expect(notice).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(notice).toBeVisible();
  // Con el reloj simulado no corren los cuadros de animación: se omite la espera de «estable» (ya se vio visible).
  await page.getByRole('button', { name: 'Cerrar aviso' }).click({ force: true });
  await expect(notice).toBeHidden();
});
