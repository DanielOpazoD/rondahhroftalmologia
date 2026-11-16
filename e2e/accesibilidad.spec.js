import { test, expect } from './fixtures.js';
import AxeBuilder from '@axe-core/playwright';
import { openApp, tab, fillPatient, save, ajustes } from './helpers.js';

/** Revisión automática WCAG 2.1 A/AA de lo que se ve en pantalla. */
async function audit(page, where) {
  // Sin animaciones: el contraste se mide con los colores finales, no a mitad de una transición.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const found = r.violations.map((v) => `${where}: ${v.id} (${v.impact}) ×${v.nodes.length} — ${v.nodes[0]?.target.join(' ')}`);
  return found;
}

async function auditGes(page, where) {
  await tab(page, 'Atención');
  await page.locator('#bPdf').click();
  await page.getByRole('menuitem', { name: /^Constancia GES/ }).click();
  const found = await audit(page, where);
  await page.getByRole('dialog', { name: 'Constancia GES' }).getByRole('button', { name: 'Cancelar' }).click();
  await page.locator('#bPdf').click();
  await page.getByRole('menuitem', { name: /^IPD/ }).click();
  found.push(...(await audit(page, where + ' IPD')));
  await page.getByRole('dialog', { name: 'IPD · Informe del proceso diagnóstico' }).getByRole('button', { name: 'Cancelar' }).click();
  await page.locator('#bPdf').click();
  await page.getByRole('menuitem', { name: /^Receta para lentes/ }).click();
  found.push(...(await audit(page, where + ' receta para lentes')));
  await page.getByRole('dialog', { name: 'Receta para lentes' }).getByRole('button', { name: 'Cancelar' }).click();
  return found;
}

test('accesibilidad: pestañas, diálogos, bloqueo y modo práctica sin infracciones WCAG A/AA', async ({ page }) => {
  await openApp(page);
  const all = [];
  // Datos para que las listas no estén vacías.
  await fillPatient(page, { nombre: 'Ana Accesible', rut: '12.345.678-5' });
  await save(page);
  for (const t of ['Ingreso', 'Atención', 'Pacientes', 'Estadística', 'Exportar', 'Ajustes']) {
    await tab(page, t);
    all.push(...(await audit(page, t)));
  }
  all.push(...(await auditGes(page, 'constancia GES')));
  for (const sec of ['Listas', 'Datos']) {
    await ajustes(page, sec);
    all.push(...(await audit(page, `Ajustes · ${sec}`)));
  }
  await ajustes(page, 'Listas');
  await page.locator('#medAdd').click();
  all.push(...(await audit(page, 'diálogo de perfil')));
  await page.locator('#dlgCancel').click();
  await ajustes(page, 'Este equipo');
  await page.locator('#checkOpen').click();
  await expect(page.locator('#checkSum')).not.toHaveText('Revisando…');
  all.push(...(await audit(page, 'chequeo')));
  await page.locator('#checkClose').click();
  await page.locator('#pinSet').click();
  await page.locator('#dlg_pin').fill('4821');
  await page.locator('#dlg_pin2').fill('4821');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('button', { name: 'Listo' }).click();
  await page.locator('#lockNow').click();
  all.push(...(await audit(page, 'bloqueo')));
  await page.locator('#lockPin').fill('4821');
  await page.locator('#lockGo').click();
  await page.goto('/?practica');
  all.push(...(await audit(page, 'modo práctica')));
  expect(all, all.join('\n')).toEqual([]);
});

test('accesibilidad: tema oscuro y celular sin infracciones WCAG A/AA', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page);
  await fillPatient(page, { nombre: 'Ana Oscura', rut: '12.345.678-5' });
  await save(page);
  const all = [];
  for (const t of ['Ingreso', 'Atención', 'Pacientes', 'Estadística', 'Exportar', 'Ajustes']) {
    await tab(page, t);
    all.push(...(await audit(page, 'oscuro ' + t)));
  }
  all.push(...(await auditGes(page, 'oscuro constancia GES')));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  for (const t of ['Ingreso', 'Atención', 'Pacientes']) {
    await tab(page, t);
    all.push(...(await audit(page, 'celular ' + t)));
  }
  all.push(...(await auditGes(page, 'celular constancia GES')));
  expect(all, all.join('\n')).toEqual([]);
});

test('teclado: saltar al contenido, flechas entre pestañas y errores asociados a su campo', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.locator('#tab-t-at').focus();
  await expect(page.locator('nav [role="tab"][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-t-reg')).toBeFocused();
  await expect(page.locator('#tab-t-reg')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#t-reg')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.locator('#tab-t-aj')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-t-ing')).toBeFocused();
  await tab(page, 'Atención');
  await page.locator('#fecha_atencion').fill('');
  await save(page);
  const desc = await page.locator('#fecha_atencion').getAttribute('aria-describedby');
  await expect(page.locator('#' + desc)).not.toHaveText('');
  await expect(page.locator('#fecha_atencion')).toHaveAttribute('aria-invalid', 'true');
});
