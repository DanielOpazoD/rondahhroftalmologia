import { test, expect } from '@playwright/test';
import { openApp, tab } from './helpers.js';

test('chequeo del equipo: indica qué falta y lleva a resolverlo; aparece solo tras días sin uso', async ({ page }) => {
  await openApp(page);
  await tab(page, 'Ajustes');
  await page.locator('#checkOpen').click();
  const dlg = page.locator('#checkDlg');
  await expect(dlg).toBeVisible();
  await expect(page.locator('#checkSum')).toHaveText(/puntos? por revisar/);
  await expect(dlg.locator('li', { hasText: 'Versión de la app' })).toContainText('Al día');
  const perfiles = dlg.locator('li', { hasText: 'Perfiles' });
  await expect(perfiles).toHaveClass(/warn/);
  await perfiles.getByRole('button', { name: 'Crear' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#medAdd')).toBeFocused();

  // Tras 8 días sin usar la app, el chequeo aparece al abrirla.
  await page.evaluate(() => localStorage.setItem('oft_ultimo_uso_v1', String(Date.now() - 8 * 24 * 3600 * 1000)));
  await page.reload();
  await expect(dlg).toBeVisible();
  await expect(page.locator('#checkTitle')).toHaveText('Antes de empezar: chequeo del equipo');
});

test('modo práctica: datos de ejemplo aparte, sin sincronización, y los reales no cambian', async ({ page }) => {
  await openApp(page);
  await tab(page, 'Ajustes');
  await page.locator('#practiceEnter').click();
  await expect(page).toHaveURL(/\?practica/);
  await expect(page.locator('#practiceBar')).toBeVisible();
  await tab(page, 'Ingreso');
  await expect(page.locator('#ingList .prow')).toHaveCount(6);
  await expect(page.locator('#ingPend')).toHaveText('5');
  await tab(page, 'Ajustes');
  await expect(page.locator('#syncUnavailable')).toContainText('modo práctica');
  await expect(page.locator('#syncSetup')).toBeHidden();
  // Los archivos descargados se distinguen.
  await tab(page, 'Ingreso');
  await page.locator('#ingList .pmain', { hasText: 'Ana Ejemplo Pakarati' }).click();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.locator('#bPdf').click()]);
  expect(pdf.suggestedFilename()).toMatch(/^PRACTICA_/);
  // Lo que se haga aquí no toca los datos reales.
  await page.locator('#bNew').click();
  await page.locator('#paciente_nombre').fill('Paciente Practicado');
  await page.locator('#bSave').click();
  await page.locator('#dlg').getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await page.locator('#practiceExit').click();
  await expect(page.locator('#practiceBar')).toBeHidden();
  await tab(page, 'Pacientes');
  await expect(page.locator('#regCount')).toHaveText('0');
  // Volver a entrar: lo practicado sigue ahí hasta reiniciar.
  await tab(page, 'Ajustes');
  await page.locator('#practiceEnter').click();
  await tab(page, 'Pacientes');
  await expect(page.locator('#regList .prow', { hasText: 'Paciente Practicado' })).toHaveCount(1);
  await page.locator('#practiceReset').click();
  await page.locator('#msgDlg').getByRole('button', { name: 'Reiniciar' }).click();
  await expect(page.locator('#practiceBar')).toBeVisible();
  await tab(page, 'Pacientes');
  await expect(page.locator('#regList .prow', { hasText: 'Paciente Practicado' })).toHaveCount(0);
  await expect(page.locator('#regList .prow', { hasText: 'Ana Ejemplo Pakarati' })).toHaveCount(1);
});

test('bloqueo con PIN: al abrir, por inactividad y con el candado; recuperación con el código', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await tab(page, 'Ajustes');
  await page.locator('#pinSet').click();
  const dlg = page.locator('#dlg');
  await dlg.locator('#dlg_pin').fill('4821');
  await dlg.locator('#dlg_pin2').fill('4820');
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  await expect(dlg.locator('#dlgErr')).toHaveText('Los PIN no coinciden');
  await dlg.locator('#dlg_pin2').fill('4821');
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  const msg = page.locator('#msgDlg');
  await expect(msg.locator('#msgTitle')).toHaveText('Código de recuperación');
  const code = await msg.locator('#msgCopy').inputValue();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await msg.getByRole('button', { name: /Cerrar|Aceptar|Listo/ }).click();
  await expect(page.locator('#pinState')).toHaveText('Activo');

  // Candado del encabezado.
  const lock = page.locator('#lockDlg');
  await page.locator('#lockNow').click();
  await expect(lock).toBeVisible();
  await page.locator('#lockPin').fill('1111');
  await page.locator('#lockGo').click();
  await expect(page.locator('#lockErr')).toHaveText('PIN incorrecto.');
  await page.locator('#lockPin').fill('4821');
  await page.locator('#lockGo').click();
  await expect(lock).toBeHidden();

  // Inactividad: 10 minutos sin uso.
  await page.clock.fastForward('10:30');
  await expect(lock).toBeVisible();
  await page.locator('#lockPin').fill('4821');
  await page.locator('#lockGo').click();
  await expect(lock).toBeHidden();

  // Al abrir la app ya está bloqueada; con el código de recuperación se desbloquea y se quita el PIN.
  await page.reload();
  await expect(lock).toBeVisible();
  await page.locator('#lockForgot').click();
  await page.locator('#lockCode').fill(code.toLowerCase());
  await page.locator('#lockRecoverGo').click();
  await expect(lock).toBeHidden();
  await tab(page, 'Ajustes');
  await expect(page.locator('#pinState')).toHaveText('Desactivado');
});

/** Configura un PIN en Ajustes; devuelve el código de recuperación. */
async function setPin(page, pin = '4821') {
  await tab(page, 'Ajustes');
  await page.locator('#pinSet').click();
  await page.locator('#dlg_pin').fill(pin);
  await page.locator('#dlg_pin2').fill(pin);
  await page.locator('#dlg').getByRole('button', { name: 'Guardar' }).click();
  const code = await page.locator('#msgCopy').inputValue();
  await page.locator('#msgDlg').getByRole('button', { name: 'Listo' }).click();
  return code;
}

test('bloqueo robusto: no se imprime, Escape no lo cierra, queda sobre otros diálogos y bloquea las otras pestañas', async ({
  page,
  context,
}) => {
  await openApp(page);
  await page.locator('#paciente_nombre').fill('Paciente Confidencial');
  await setPin(page);
  await page.locator('#lockNow').click();
  const lock = page.locator('#lockDlg');
  await expect(lock).toBeVisible();
  await expect(page.locator('#main')).toBeHidden();
  // Ctrl+P: la impresión no muestra la app.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#main')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  // Escape (dos veces) no desbloquea ni deja ver la app.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(lock).toBeVisible();
  await expect(page.locator('#main')).toBeHidden();
  // Otro diálogo que se abre encima (p. ej. un aviso de sincronización): el bloqueo sigue arriba y se puede usar.
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.querySelector('#msgDlg')).showModal());
  await page.locator('#lockPin').fill('4821');
  await page.locator('#lockGo').click();
  await expect(lock).toBeHidden();
  await expect(page.locator('#main')).toBeVisible();
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.querySelector('#msgDlg')).close());

  // Otra pestaña: al abrir pide el PIN; si se bloquea una, se bloquean todas.
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('#lockDlg')).toBeVisible();
  await other.locator('#lockPin').fill('4821');
  await other.locator('#lockGo').click();
  await expect(other.locator('#lockDlg')).toBeHidden();
  await page.locator('#lockNow').click();
  await expect(other.locator('#lockDlg')).toBeVisible();
  await expect(other.locator('#main')).toBeHidden();
});

test('modo práctica: su perfil de sesión y sus respaldos no se mezclan con los reales', async ({ page }) => {
  await openApp(page);
  // Un perfil real.
  await tab(page, 'Ajustes');
  await page.locator('#medAdd').click();
  await page.locator('#dlg_nombre').fill('Dra. Real');
  await page.locator('#dlg').getByRole('button', { name: 'Guardar' }).click();
  // En práctica se elige un perfil de ejemplo y se descarga un respaldo.
  await page.locator('#practiceEnter').click();
  await tab(page, 'Atención');
  await page.locator('#paciente_nombre').fill('Paciente de Práctica');
  await page.locator('#bSave').click();
  await page.locator('#dlg_perfil').selectOption({ label: 'Dra. Ejemplo · Médico/a' });
  await page.locator('#dlg').getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await tab(page, 'Ajustes');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.locator('#bkExp').click()]);
  expect(bk.suggestedFilename()).toMatch(/^PRACTICA_respaldo/);
  const bkPath = await bk.path();
  await page.locator('#practiceExit').click();
  // De vuelta en la app real: se vuelve a preguntar quién registra (el perfil de práctica no cuenta).
  await expect(page.locator('#userChip')).toHaveText('Elegir perfil');
  await tab(page, 'Atención');
  await page.locator('#paciente_nombre').fill('Paciente Real');
  await page.locator('#bSave').click();
  await expect(page.locator('#dlgTitle')).toHaveText('¿Quién registra?');
  await page.locator('#dlg').getByRole('button', { name: 'Continuar' }).click();
  // El respaldo de práctica no se importa a los datos reales.
  await tab(page, 'Ajustes');
  await page.locator('#bkImp').setInputFiles(bkPath);
  await expect(page.locator('#msgTitle')).toHaveText('No se pudo importar');
  await expect(page.locator('#msgText')).toContainText('modo práctica');
});
