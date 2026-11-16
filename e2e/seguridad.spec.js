import { test, expect } from './fixtures.js';
import { openApp, tab, fillPatient, save } from './helpers.js';

/** Registra cada violación de la política de contenido (CSP) que ocurra en la página. */
async function watchCsp(page) {
  await page.addInitScript(() => {
    /** @type {any} */ (window).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      /** @type {any} */ (window).__csp.push(`${e.violatedDirective} ${e.blockedURI || ''} ${e.sample || ''}`.trim()),
    );
  });
}
const violations = (page) => page.evaluate(() => /** @type {any} */ (window).__csp);

test('CSP estricta: ninguna pantalla viola la política y un estilo inyectado se bloquea', async ({ page }) => {
  await watchCsp(page);
  await openApp(page);
  await fillPatient(page, { nombre: 'Ana Segura', rut: '12.345.678-5' });
  await page.locator('#dxChips .chip').first().click();
  await save(page);
  for (const t of ['Ingreso', 'Atención', 'Pacientes', 'Reportes', 'Ajustes']) await tab(page, t);
  // Las barras de Estadística tienen ancho (por CSSOM, sin atributos style).
  await tab(page, 'Estadística');
  const width = await page
    .locator('#stOut .hb')
    .first()
    .evaluate((el) => getComputedStyle(el).width);
  expect(parseFloat(width)).toBeGreaterThan(0);
  await tab(page, 'Ajustes');
  await page.locator('#checkOpen').click();
  await page.locator('#checkClose').click();
  await page.goto('/?practica');
  await expect(page.locator('#practiceBar')).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // Un <style> inyectado (p. ej. por un dato malicioso) no se aplica.
  const applied = await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = 'body { background: rgb(255, 0, 0) !important; }';
    document.head.appendChild(st);
    return getComputedStyle(document.body).backgroundColor;
  });
  expect(applied).not.toBe('rgb(255, 0, 0)');
});
