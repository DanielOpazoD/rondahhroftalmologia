import { test, expect } from '@playwright/test';
import { openApp, tab, activateSync, syncNow, showPatientRecord } from './helpers.js';

// Fecha propia: el servidor de sincronización es compartido por todas las pruebas.
// Fecha propia de cada ejecución: el servidor de sincronización de las pruebas es
// compartido (otras pruebas o repeticiones no deben ver a estos pacientes).
const iso = (d) => d.toISOString().slice(0, 10);
const DIA = new Date(Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 6900) * 86_400_000);
const FECHA = iso(DIA);
const FECHA_2 = iso(new Date(DIA.getTime() + 71 * 86_400_000));
const FECHA_DMY = FECHA.split('-').reverse().join('-');
/** Edad (años cumplidos) de alguien nacido el 1950-03-01 en FECHA. */
const EDAD = String(DIA.getUTCFullYear() - 1950 - (DIA.getUTCMonth() < 2 ? 1 : 0));

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

/** Dígito verificador de un RUT. */
function dv(body) {
  let sum = 0;
  let mul = 2;
  for (const d of String(body).split('').reverse()) {
    sum += Number(d) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}
// RUT y nombres propios de cada ejecución (mismo motivo que la fecha).
const CUERPO = String(10_000_000 + Math.floor(Math.random() * 15_000_000));
const RUT = `${CUERPO.slice(0, -6)}.${CUERPO.slice(-6, -3)}.${CUERPO.slice(-3)}-${dv(CUERPO)}`;
const RUT_SIN_FORMATO = CUERPO + dv(CUERPO);
const SUFIJO = Math.random().toString(36).slice(2, 6);
const ROSA = `Rosa Preingreso ${SUFIJO}`;
const PEDRO = `Pedro Sin Rut ${SUFIJO}`;

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
  await adm.locator('#ing_rut').fill(RUT);
  await adm.locator('#ing_nombre').fill(ROSA);
  await adm.locator('#ing_fnac').fill('1950-03-01');
  await expect(adm.locator('#ing_edad')).toHaveValue(EDAD);
  await adm.locator('#ingSexo button[data-v="F"]').click();
  await adm.locator('#ingAdd').click();
  await adm.locator('#ing_nombre').fill(PEDRO);
  await adm.locator('#ingAdd').click();
  await expect(adm.locator('#ingList .prow')).toHaveCount(2);
  await expect(adm.locator('#ingPend')).toHaveText('2');
  // Ingresar de nuevo al mismo paciente el mismo día no lo duplica.
  await adm.locator('#ing_rut').fill(RUT_SIN_FORMATO);
  await adm.locator('#ingAdd').click();
  await expect(adm.locator('#toast')).toContainText('ya está en la lista');
  await expect(adm.locator('#ingList .prow')).toHaveCount(2);
  await syncNow(adm);

  // 2. Médico y enfermería ven la lista y abren a Rosa al mismo tiempo.
  for (const P of [med, enf]) {
    await syncNow(P);
    await lista(P);
    await expect(P.locator('#ingList .prow')).toHaveCount(2);
    await P.locator('#ingList .pmain', { hasText: ROSA }).click();
    await expect(P.locator('#tbName')).toHaveText(ROSA);
    await expect(P.locator('#paciente_edad')).toHaveValue(EDAD);
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
    const rosa = P.locator('#ingList .prow', { hasText: ROSA });
    await expect(rosa.locator('.state')).toHaveText('Atendido');
    await expect(P.locator('#ingPend')).toHaveText('1');
    await rosa.locator('.pmain').click();
    await expect(P.locator('#od_pio')).toHaveValue('21');
    await expect(P.locator('#oi_pio')).toHaveValue('19');
    await expect(P.locator('#plan')).toHaveValue('Control en 3 meses');
    await expect(P.locator('#dxChips .chip[data-k="diagnostico_glaucoma"]')).toHaveClass(/on/);
  }

  // 4. Rosa es UNA paciente con su historial; una nueva atención otro día se suma a su ficha.
  await showPatientRecord(med, ROSA);
  await expect(med.locator('#patAttentions .prow')).toHaveCount(1);
  await med.locator('#patNew').click();
  await expect(med.locator('#paciente_rut')).toHaveValue(RUT);
  await med.locator('#fecha_atencion').fill(FECHA_2);
  await med.locator('#od_pio').fill('17');
  await med.locator('#bSave').click();
  await expect(med.locator('#patPrev')).toContainText(FECHA_DMY);
  await showPatientRecord(med, ROSA);
  await expect(med.locator('#patAttentions .prow')).toHaveCount(2);

  await Promise.all(ctxs.map((c) => c.close()));
});
