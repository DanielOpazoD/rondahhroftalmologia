import { test, expect } from './fixtures.js';
import { openApp, tab, ajustes, nextFrames } from './helpers.js';

test('chequeo del equipo: indica qué falta y lleva a resolverlo; aparece solo tras días sin uso', async ({ page }) => {
  await openApp(page);
  await ajustes(page, 'Este equipo');
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
  await ajustes(page, 'Este equipo');
  await page.locator('#practiceEnter').click();
  await expect(page).toHaveURL(/\?practica/);
  await expect(page.locator('#practiceBar')).toBeVisible();
  // Al abrir (hay perfiles de ejemplo) se pregunta quién registra, antes de empezar a escribir.
  await expect(page.locator('#dlgTitle')).toHaveText('¿Quién registra?');
  await page.locator('#dlg').getByRole('button', { name: 'Continuar' }).click();
  await tab(page, 'Ingreso');
  await expect(page.locator('#ingList .prow')).toHaveCount(6);
  await expect(page.locator('#ingPend')).toHaveText('5');
  await ajustes(page, 'Este equipo');
  await expect(page.locator('#syncUnavailable')).toContainText('modo práctica');
  await expect(page.locator('#syncSetup')).toBeHidden();
  // Los archivos descargados se distinguen.
  await tab(page, 'Ingreso');
  await page.locator('#ingList .pmain', { hasText: 'Ana Ejemplo Pakarati' }).click();
  await page.locator('#bPdf').click();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^PDF Hoja/ }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/^PRACTICA_/);
  // Lo que se haga aquí no toca los datos reales.
  await page.locator('#bNew').click();
  await page.locator('#paciente_nombres').fill('Paciente Practicado');
  await page.locator('#bSave').click();
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await page.locator('#practiceExit').click();
  await expect(page.locator('#practiceBar')).toBeHidden();
  await tab(page, 'Pacientes');
  await expect(page.locator('#regCount')).toHaveText('0');
  // Volver a entrar: lo practicado sigue ahí hasta reiniciar.
  await ajustes(page, 'Este equipo');
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
  await ajustes(page, 'Este equipo');
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
  await ajustes(page, 'Este equipo');
  await expect(page.locator('#pinState')).toHaveText('Desactivado');
});

/** Configura un PIN en Ajustes; devuelve el código de recuperación. */
async function setPin(page, pin = '4821') {
  await ajustes(page, 'Este equipo');
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
  await page.locator('#paciente_nombres').fill('Paciente Confidencial');
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
  await nextFrames(page);
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
  await ajustes(page, 'Listas');
  await page.locator('#medAdd').click();
  await page.locator('#dlg_nombres').fill('Dra. Real');
  await page.locator('#dlg').getByRole('button', { name: 'Guardar' }).click();
  // En práctica se elige (al abrir) un perfil de ejemplo y se descarga un respaldo.
  await ajustes(page, 'Este equipo');
  await page.locator('#practiceEnter').click();
  await expect(page.locator('#dlgTitle')).toHaveText('¿Quién registra?');
  await page.locator('#dlg_perfil').selectOption({ label: 'Dra. Ejemplo · Médico/a' });
  await page.locator('#dlg').getByRole('button', { name: 'Continuar' }).click();
  await tab(page, 'Atención');
  await page.locator('#paciente_nombres').fill('Paciente de Práctica');
  await page.locator('#bSave').click();
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await ajustes(page, 'Datos');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.locator('#bkExp').click()]);
  expect(bk.suggestedFilename()).toMatch(/^PRACTICA_respaldo/);
  const bkPath = await bk.path();
  await page.locator('#practiceExit').click();
  // De vuelta en la app real: se vuelve a preguntar quién registra (el perfil de práctica no cuenta).
  await expect(page.locator('#dlgTitle')).toHaveText('¿Quién registra?');
  await expect(page.locator('#dlg_perfil option', { hasText: 'Dra. Ejemplo' })).toHaveCount(0);
  await page.locator('#dlg').getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('#userChip')).toHaveText('Dra. Real');
  // El respaldo de práctica no se importa a los datos reales.
  await ajustes(page, 'Datos');
  await page.locator('#bkImp').setInputFiles(bkPath);
  await expect(page.locator('#msgTitle')).toHaveText('No se pudo importar');
  await expect(page.locator('#msgText')).toContainText('modo práctica');
});

test('aviso de versión nueva: aparece al volver a la pestaña si hay una publicada más nueva', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await page.route('**/version.json', (r) => r.fulfill({ json: { version: '9.9.9', build: 'ffffffffffff' } }));
  await expect(page.locator('#updateBar')).toBeHidden();
  await page.clock.fastForward('06:00');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#updateBar')).toBeVisible();
  await expect(page.locator('#updateText')).toContainText('9.9.9');
  await page.locator('#updateLater').click();
  await expect(page.locator('#updateBar')).toBeHidden();
});

test('registro de errores: un error inesperado queda registrado en Ajustes', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => setTimeout(() => Promise.reject(new Error('Falla de prueba'))));
  await ajustes(page, 'Este equipo');
  await expect(page.locator('#errCount')).toHaveText('1');
  await page.locator('#errCard summary').click();
  await expect(page.locator('#errText')).toContainText('Falla de prueba');
  await page.locator('#errClear').click();
  await expect(page.locator('#errCount')).toHaveText('0');
});

test('almacenamiento: si una escritura falla, se avisa y se guarda al reintentar', async ({ page }) => {
  await openApp(page);
  // Simula un disco lleno: las escrituras de IndexedDB fallan hasta que se «libera espacio».
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__fail = true;
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (w.__fail) throw new DOMException('Sin espacio', 'QuotaExceededError');
      return orig.apply(this, a);
    };
  });
  await page.locator('#paciente_nombres').fill('Paciente Sin Disco');
  await page.locator('#bSave').click();
  await expect(page.locator('#saveBar')).toBeVisible();
  await expect(page.locator('#saveText')).toHaveText(/no se pudieron? guardar en este equipo/);
  // Chequeo del equipo: lo marca como problema.
  await ajustes(page, 'Este equipo');
  await page.locator('#checkOpen').click();
  await expect(page.locator('#checkDlg li', { hasText: 'Almacenamiento' })).toHaveClass(/bad/);
  await page.locator('#checkClose').click();
  // Se libera espacio y se reintenta: queda guardado y la barra desaparece.
  await page.evaluate(() => /** @type {any} */ (window.__fail = false));
  await page.locator('#saveRetry').click();
  await expect(page.locator('#saveBar')).toBeHidden();
  await page.reload();
  await tab(page, 'Pacientes');
  await expect(page.locator('#regList .prow', { hasText: 'Paciente Sin Disco' })).toHaveCount(1);
});
