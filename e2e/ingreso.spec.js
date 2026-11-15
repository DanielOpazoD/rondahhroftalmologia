import { test, expect } from '@playwright/test';
import { openApp, tab, activateSync, syncNow, showPatientRecord } from './helpers.js';

// Fecha propia: el servidor de sincronización es compartido por todas las pruebas.
const FECHA = '2019-06-10';

test('verificador de RUT: ✓ verde si es válido, ✗ roja si no', async ({ page }) => {
  await openApp(page);
  const rut = page.locator('#paciente_rut');
  const mark = page.locator('[data-rut-for="paciente_rut"]');
  await expect(mark).toHaveText('');
  await rut.fill('12.345.678-4');
  await expect(mark).toHaveText('✗');
  await expect(mark).toHaveClass(/bad/);
  await rut.fill('12.345.678-5');
  await expect(mark).toHaveText('✓');
  await expect(mark).toHaveClass(/ok/);
  await tab(page, 'Ingreso');
  await page.locator('#ing_rut').fill('10000013k');
  await expect(page.locator('[data-rut-for="ing_rut"]')).toHaveText('✓');
});

/** Abre la lista del día en la pestaña Ingreso. */
async function lista(page) {
  await tab(page, 'Ingreso');
  await page.locator('#ingFecha').fill(FECHA);
  await page.locator('#ingFecha').dispatchEvent('change');
}

test('trabajo simultáneo: ingreso, médico y mediciones en tres PC', async ({ browser }) => {
  const ctxs = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [adm, med, enf] = await Promise.all(ctxs.map((c) => c.newPage()));
  for (const [P, name] of [
    [adm, 'Admisión'],
    [med, 'Box médico'],
    [enf, 'Enfermería'],
  ]) {
    await openApp(P);
    await tab(P, 'Ajustes');
    await P.locator('#setDevice').fill(name);
    await P.locator('#setDevice').blur();
    await activateSync(P);
  }

  // 1. Admisión preingresa a dos pacientes.
  await lista(adm);
  await adm.locator('#ing_rut').fill('12.345.678-5');
  await adm.locator('#ing_nombre').fill('Rosa Preingreso');
  await adm.locator('#ing_fnac').fill('1950-03-01');
  await expect(adm.locator('#ing_edad')).toHaveValue('69');
  await adm.locator('#ingSexo button[data-v="F"]').click();
  await adm.locator('#ingAdd').click();
  await adm.locator('#ing_nombre').fill('Pedro Sin Rut');
  await adm.locator('#ingAdd').click();
  await expect(adm.locator('#ingList .prow')).toHaveCount(2);
  await expect(adm.locator('#ingPend')).toHaveText('2');
  // Ingresar de nuevo al mismo paciente el mismo día no lo duplica.
  await adm.locator('#ing_rut').fill('123456785');
  await adm.locator('#ingAdd').click();
  await expect(adm.locator('#toast')).toContainText('ya está en la lista');
  await expect(adm.locator('#ingList .prow')).toHaveCount(2);
  await syncNow(adm);

  // 2. Médico y enfermería ven la lista y abren a Rosa al mismo tiempo.
  for (const P of [med, enf]) {
    await syncNow(P);
    await lista(P);
    await expect(P.locator('#ingList .prow')).toHaveCount(2);
    await P.locator('#ingList .pmain', { hasText: 'Rosa Preingreso' }).click();
    await expect(P.locator('#tbName')).toHaveText('Rosa Preingreso');
    await expect(P.locator('#paciente_edad')).toHaveValue('69');
  }
  // Médico: diagnóstico y plan. Enfermería: PIO. Sin sincronizar entre medio.
  await med.locator('#dxChips .chip[data-k="diagnostico_glaucoma"]').click();
  await med.locator('#plan').fill('Control en 3 meses');
  await med.locator('#bSave').click();
  await enf.locator('#od_pio').fill('21');
  await enf.locator('#oi_pio').fill('19');
  await enf.locator('#bSave').click();
  for (const P of [med, enf, med, adm]) await syncNow(P);

  // 3. Todos ven a Rosa atendida, con los datos de ambos profesionales.
  for (const P of [adm, med, enf]) {
    await lista(P);
    const rosa = P.locator('#ingList .prow', { hasText: 'Rosa Preingreso' });
    await expect(rosa.locator('.state')).toHaveText('Atendido');
    await expect(P.locator('#ingPend')).toHaveText('1');
    await rosa.locator('.pmain').click();
    await expect(P.locator('#od_pio')).toHaveValue('21');
    await expect(P.locator('#oi_pio')).toHaveValue('19');
    await expect(P.locator('#plan')).toHaveValue('Control en 3 meses');
    await expect(P.locator('#dxChips .chip[data-k="diagnostico_glaucoma"]')).toHaveClass(/on/);
  }

  // 4. Rosa es UNA paciente con su historial; una nueva atención otro día se suma a su ficha.
  await showPatientRecord(med, 'Rosa Preingreso');
  await expect(med.locator('#patAttentions .prow')).toHaveCount(1);
  await med.locator('#patNew').click();
  await expect(med.locator('#paciente_rut')).toHaveValue('12.345.678-5');
  await med.locator('#fecha_atencion').fill('2019-08-20');
  await med.locator('#od_pio').fill('17');
  await med.locator('#bSave').click();
  await expect(med.locator('#patPrev')).toContainText('10-06-2019');
  await showPatientRecord(med, 'Rosa Preingreso');
  await expect(med.locator('#patAttentions .prow')).toHaveCount(2);

  await Promise.all(ctxs.map((c) => c.close()));
});
