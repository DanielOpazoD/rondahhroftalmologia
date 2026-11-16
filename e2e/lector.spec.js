import { test, expect } from './fixtures.js';
import { openApp, tab } from './helpers.js';

/**
 * Lo que anuncia un lector de pantalla: el árbol de accesibilidad (roles,
 * nombres y estados). No reemplaza una prueba con un lector real (ver
 * docs/ACCESIBILIDAD.md), pero impide retrocesos: íconos que se leen como
 * «imagen», botones sin nombre, estados que no se anuncian.
 */

test('pestañas: nombre de cada una y cuál está activa, sin «imagen» de los íconos', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('tablist')).toMatchAriaSnapshot(`
    - tablist "Secciones":
      - tab "Ingreso"
      - tab "Atención" [selected]
      - tab "Pacientes"
      - tab "Estadística"
      - tab "Exportar"
      - tab "Ajustes"
  `);
  expect(await page.getByRole('tablist').ariaSnapshot()).not.toContain('img');
});

test('barra de la atención: botones con nombre y estado del guardado anunciado', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.toolbar')).toMatchAriaSnapshot(`
    - status: Sin datos
    - button "Nueva atención"
    - button "Copiar nota para Eloísa"
    - button "Descargar PDF"
    - button "Guardar"
  `);
  await page.locator('#paciente_nombres').fill('Paciente Lector');
  await expect(page.getByRole('status').filter({ hasText: 'Guardada' })).toBeVisible({ timeout: 5000 });
});

test('formulario: campos con etiqueta, sexo con nombre completo y errores asociados', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#t-at .card').nth(1)).toMatchAriaSnapshot(`
    - heading "Paciente" [level=2]
    - textbox "RUT"
    - textbox "Apellido paterno"
    - textbox "Apellido materno"
    - textbox "Nombres"
    - textbox "Fono"
    - textbox "Fecha de nacimiento"
    - textbox "Edad"
    - group "Sexo":
      - button "Femenino"
      - button "Masculino"
      - button "Otro / no informa"
  `);
  await page.locator('#bSave').click();
  await expect(page.getByRole('textbox', { name: 'Nombres', exact: true })).toHaveAccessibleDescription('Requerido (nombre o RUT)');
});

test('diálogos y bloqueo: nombre del diálogo y de sus controles', async ({ page }) => {
  await openApp(page);
  await tab(page, 'Ajustes');
  await page.locator('#checkOpen').click();
  await expect(page.getByRole('dialog', { name: 'Chequeo del equipo' })).toBeVisible();
  await page.locator('#checkClose').click();
  await page.locator('#pinSet').click();
  await expect(page.getByRole('dialog', { name: 'Configurar PIN' })).toMatchAriaSnapshot(`
    - dialog "Configurar PIN":
      - heading "Configurar PIN" [level=3]
      - text: PIN (4 a 8 números)
      - textbox "PIN (4 a 8 números)"
      - text: Repite el PIN
      - textbox "Repite el PIN"
      - button "Cancelar"
      - button "Guardar"
  `);
  await page.locator('#dlg_pin').fill('4821');
  await page.locator('#dlg_pin2').fill('4821');
  await page.locator('#dlg').getByRole('button', { name: 'Guardar' }).click();
  await page.locator('#msgDlg').getByRole('button', { name: 'Listo' }).click();
  await page.getByRole('button', { name: 'Bloquear ahora' }).click();
  const lock = page.getByRole('dialog', { name: 'Equipo bloqueado' });
  await expect(lock).toBeVisible();
  await expect(lock.getByRole('textbox', { name: 'PIN' })).toBeFocused();
  await expect(lock.getByRole('button', { name: 'Desbloquear' })).toBeVisible();
});
