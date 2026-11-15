import { test, expect } from './fixtures.js';
import { openApp, tab, activateSync, syncNow, fillPatient, save } from './helpers.js';

const RUT = '17.752.753-K';
const NOMBRE = 'Dra. Admin Prueba';

/** Ingresa con RUT y clave en la pantalla de ingreso. */
async function login(page, rut, pass) {
  await expect(page.locator('#loginDlg')).toBeVisible();
  await page.locator('#loginRut').fill(rut);
  await page.locator('#loginPass').fill(pass);
  await page.locator('#loginGo').click();
}

/** Activa las cuentas desde Ajustes (PC con la contraseña del equipo): primer administrador. */
async function activateAccounts(page) {
  await tab(page, 'Ajustes');
  await page.locator('#acctActivateBtn').click();
  await page.locator('#dlg_rut').fill(RUT);
  await page.locator('#dlg_nombre').fill(NOMBRE);
  await page.locator('#dlgOk').click();
  await expect(page.locator('#msgTitle')).toHaveText('Activar cuentas de usuario');
  await page.locator('#msgDlg').getByRole('button', { name: 'Activar' }).click();
  await expect(page.locator('#msgTitle')).toHaveText('Cuentas activadas', { timeout: 20_000 });
  await page.locator('#msgDlg').getByRole('button').first().click();
}

test('cuentas: activar, primer ingreso con el RUT, crear clave, sincronizar con la sesión; otros PC deben entrar', async ({ browser }) => {
  const [ca, cb, cc] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [A, B, C] = await Promise.all([ca.newPage(), cb.newPage(), cc.newPage()]);
  // A y B sincronizan con la contraseña del equipo (como hasta ahora).
  for (const P of [A, B]) {
    await openApp(P);
    await activateSync(P);
  }
  await tab(A, 'Atención');
  await fillPatient(A, { nombre: 'Paciente Antes De Cuentas' });
  await save(A);
  await syncNow(A);

  // A activa las cuentas y entra con su RUT sin dígito verificador.
  await activateAccounts(A);
  await login(A, RUT, '17752753');
  await expect(A.locator('#pwForm')).toBeVisible();
  await expect(A.locator('#pwHint')).toContainText(NOMBRE);
  // La clave nueva cumple las reglas.
  await A.locator('#pwNew').fill('abcdef');
  await A.locator('#pwNew2').fill('abcdef');
  await A.locator('#pwGo').click();
  await expect(A.locator('#loginErr')).toContainText('mayúscula');
  await A.locator('#pwNew').fill('Ojo2026');
  await A.locator('#pwNew2').fill('Ojo2026');
  await A.locator('#pwGo').click();
  await expect(A.locator('#loginDlg')).toBeHidden();
  await expect(A.locator('#userChip')).toContainText(NOMBRE);
  await expect(A.locator('#syncBadge')).toHaveText('Sincronizado', { timeout: 20_000 });
  // Lo que registra queda a nombre de la cuenta (identidad verificada).
  await tab(A, 'Atención');
  await A.locator('#bNew').click();
  await fillPatient(A, { nombre: 'Paciente Con Cuenta' });
  await save(A);
  await A.locator('#histCard summary').click();
  await expect(A.locator('#histList')).toContainText(NOMBRE);
  await syncNow(A);

  // B (con la contraseña del equipo) ya no puede sincronizar: se le pide entrar.
  await tab(B, 'Ajustes');
  await B.locator('#syncNowBtn').click();
  await expect(B.locator('#loginDlg')).toBeVisible({ timeout: 20_000 });
  await login(B, RUT, 'Ojo2026');
  await expect(B.locator('#loginDlg')).toBeHidden();
  await syncNow(B);
  await tab(B, 'Pacientes');
  await expect(B.locator('#regList')).toContainText('Paciente Con Cuenta');

  // C, un PC nuevo: el servidor dice que hay cuentas, así que pide entrar.
  await C.goto('/');
  await login(C, RUT, 'Mala123');
  await expect(C.locator('#loginErr')).toContainText('incorrectos');
  await C.locator('#loginPass').fill('Ojo2026');
  await C.locator('#loginGo').click();
  await expect(C.locator('#loginDlg')).toBeHidden();
  await syncNow(C);
  await tab(C, 'Pacientes');
  await expect(C.locator('#regList')).toContainText('Paciente Antes De Cuentas');
  // Recargar la pestaña conserva la sesión.
  await C.reload();
  await expect(C.locator('#userChip')).toContainText(NOMBRE);
  await expect(C.locator('#loginDlg')).toBeHidden();

  // Bloquear: pide la clave de la persona.
  await C.locator('#userChip').click();
  await C.getByRole('menuitem', { name: /Bloquear/ }).click();
  await expect(C.locator('#lockTitle')).toHaveText('Sesión bloqueada');
  await C.locator('#lockPin').fill('Mala123');
  await C.locator('#lockGo').click();
  await expect(C.locator('#lockErr')).toHaveText('Clave incorrecta.');
  await C.locator('#lockPin').fill('Ojo2026');
  await C.locator('#lockGo').click();
  await expect(C.locator('#lockDlg')).toBeHidden();

  // Cerrar sesión y entrar SIN conexión con lo guardado en este PC.
  await C.locator('#userChip').click();
  await C.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
  await expect(C.locator('#loginDlg')).toBeVisible();
  await cc.setOffline(true);
  await login(C, RUT, 'Ojo2026');
  await expect(C.locator('#loginDlg')).toBeHidden();
  await expect(C.locator('#toast')).toContainText('Sin conexión');
  // Al volver la conexión, sincroniza sin volver a pedir la clave.
  await cc.setOffline(false);
  await syncNow(C);
  await Promise.all([ca.close(), cb.close(), cc.close()]);
});

/** PC con las cuentas activadas y el administrador ya con su clave. */
async function adminReady(page) {
  await openApp(page);
  await activateSync(page);
  await activateAccounts(page);
  await login(page, RUT, '17752753');
  await page.locator('#pwNew').fill('Ojo2026');
  await page.locator('#pwNew2').fill('Ojo2026');
  await page.locator('#pwGo').click();
  await expect(page.locator('#loginDlg')).toBeHidden();
}

test('usuarios: el administrador crea, restablece y desactiva cuentas; siempre queda un administrador', async ({ browser }) => {
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [A, B] = await Promise.all([ca.newPage(), cb.newPage()]);
  await adminReady(A);
  await tab(A, 'Ajustes');
  const card = A.locator('#usersCard');
  await expect(card).toBeVisible();
  await expect(card.locator('#usersList')).toContainText(NOMBRE);
  // Alta de una administrativa.
  await A.locator('#usersAdd').click();
  await A.locator('#dlg_rut').fill('11.111.111-1');
  await A.locator('#dlg_nombre').fill('Ana Admisión');
  await A.locator('#dlg_rol').selectOption('administrativo');
  await A.locator('#dlgOk').click();
  await expect(A.locator('#msgTitle')).toHaveText('Cuenta creada', { timeout: 20_000 });
  await expect(A.locator('#msgDlg')).toContainText('11111111');
  await A.locator('#msgDlg').getByRole('button').first().click();
  await expect(card.locator('#usersList')).toContainText('Ana Admisión');
  await expect(card.locator('#usersList')).toContainText('Clave inicial');
  // RUT repetido.
  await A.locator('#usersAdd').click();
  await A.locator('#dlg_rut').fill('11111111-1');
  await A.locator('#dlg_nombre').fill('Otra Persona');
  await A.locator('#dlgOk').click();
  await expect(A.locator('#dlgErr')).toHaveText('Ya existe una cuenta con ese RUT.');
  await A.locator('#dlg').getByRole('button', { name: 'Cancelar' }).click();

  // Ana entra en otro PC y crea su clave; no ve la administración de usuarios.
  await B.goto('/');
  await login(B, '11.111.111-1', '11111111');
  await B.locator('#pwNew').fill('Admis1');
  await B.locator('#pwNew2').fill('Admis1');
  await B.locator('#pwGo').click();
  await expect(B.locator('#loginDlg')).toBeHidden();
  await expect(B.locator('#userChip')).toContainText('Ana Admisión');
  await tab(B, 'Ajustes');
  await expect(B.locator('#usersCard')).toBeHidden();

  // El administrador no puede quitarse el rol siendo el único.
  const me = card.locator('.prow', { hasText: NOMBRE });
  await me.getByRole('button', { name: /Editar/ }).click();
  await A.locator('#dlg_admin').selectOption('no');
  await A.locator('#dlgOk').click();
  await expect(A.locator('#msgDlg')).toContainText('al menos un administrador', { timeout: 20_000 });
  await A.locator('#msgDlg').getByRole('button').first().click();

  // Desactivar a Ana: su sesión se corta y ya no puede entrar.
  const ana = card.locator('.prow', { hasText: 'Ana Admisión' });
  await ana.getByRole('button', { name: 'Desactivar' }).click();
  await A.locator('#msgDlg').getByRole('button', { name: 'Desactivar' }).click();
  await expect(ana).toContainText('Desactivada', { timeout: 20_000 });
  await B.locator('#syncNowBtn').click();
  await expect(B.locator('#loginDlg')).toBeVisible({ timeout: 20_000 });
  await expect(B.locator('#loginErr')).toContainText('desactivada');
  // Reactivar y restablecer: vuelve a entrar con la clave inicial.
  await ana.getByRole('button', { name: 'Reactivar' }).click();
  await expect(ana).not.toContainText('Desactivada', { timeout: 20_000 });
  await ana.getByRole('button', { name: /Restablecer/ }).click();
  await A.locator('#msgDlg').getByRole('button', { name: 'Restablecer' }).click();
  await expect(ana).toContainText('Clave inicial', { timeout: 20_000 });
  await login(B, '11.111.111-1', '11111111');
  await expect(B.locator('#pwForm')).toBeVisible();
  await Promise.all([ca.close(), cb.close()]);
});

/** Crea una cuenta desde el panel de usuarios (el administrador ya está en Ajustes). */
async function createUser(page, { rut, nombre, rol }) {
  await page.locator('#usersAdd').click();
  await page.locator('#dlg_rut').fill(rut);
  await page.locator('#dlg_nombre').fill(nombre);
  await page.locator('#dlg_rol').selectOption(rol);
  await page.locator('#dlgOk').click();
  await expect(page.locator('#msgTitle')).toHaveText('Cuenta creada', { timeout: 20_000 });
  await page.locator('#msgDlg').getByRole('button').first().click();
}

test('permisos: una administrativa ve las atenciones sin editarlas, hace el ingreso y no cambia ajustes', async ({ browser }) => {
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [A, B] = await Promise.all([ca.newPage(), cb.newPage()]);
  await adminReady(A);
  await tab(A, 'Atención');
  await A.locator('#bNew').click();
  await fillPatient(A, { nombre: 'Paciente Clínico' });
  await A.locator('#plan').fill('Control en 6 meses');
  await save(A);
  await syncNow(A);
  await tab(A, 'Ajustes');
  await createUser(A, { rut: '11.111.111-1', nombre: 'Ana Admisión', rol: 'administrativo' });

  await B.goto('/');
  await login(B, '11.111.111-1', '11111111');
  await B.locator('#pwNew').fill('Admis1');
  await B.locator('#pwNew2').fill('Admis1');
  await B.locator('#pwGo').click();
  await expect(B.locator('#loginDlg')).toBeHidden();
  await syncNow(B);
  // Ve la atención, en solo lectura.
  await tab(B, 'Pacientes');
  await B.locator('#regList .pmain', { hasText: 'Paciente Clínico' }).click();
  await expect(B.locator('#patNew')).toBeHidden();
  await expect(B.locator('#patAttentions [data-a="del"]')).toBeHidden();
  await B.locator('#patAttentions .pmain').first().click();
  await expect(B.locator('#roBanner')).toBeVisible();
  await expect(B.locator('#plan')).toHaveValue('Control en 6 meses');
  await expect(B.locator('#plan')).toBeDisabled();
  await expect(B.locator('#paciente_nombre')).toBeDisabled();
  await expect(B.locator('#bSave')).toBeHidden();
  await expect(B.locator('#bNew')).toBeHidden();
  await expect(B.locator('#attAdd')).toBeHidden();
  // Puede descargar el PDF.
  await B.locator('#bPdf').click();
  const [pdf] = await Promise.all([B.waitForEvent('download'), B.getByRole('menuitem', { name: /^PDF Hoja/ }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  // Hace el ingreso.
  await tab(B, 'Ingreso');
  await B.locator('#ing_nombre').fill('Paciente Ingresado Por Admisión');
  await B.locator('#ingAdd').click();
  await expect(B.locator('#ingList')).toContainText('Paciente Ingresado Por Admisión');
  // No cambia ajustes del sistema.
  await tab(B, 'Ajustes');
  for (const id of ['#ajAdd', '#bkImpBtn', '#medAdd', '#opAdd', '#wipe', '#usersCard']) await expect(B.locator(id)).toBeHidden();
  // El administrador (médico) sí edita.
  await tab(A, 'Atención');
  await expect(A.locator('#roBanner')).toBeHidden();
  await expect(A.locator('#plan')).toBeEnabled();

  // Registro de accesos: lo que abrió y descargó Ana, con el nombre del paciente.
  await syncNow(B); // envía los eventos pendientes
  await expect
    .poll(
      async () =>
        B.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith('cuentas_eventos_v1') && localStorage.getItem(k) === '[]')),
      { timeout: 15_000 },
    )
    .toBe(true);
  await tab(A, 'Ajustes');
  await expect(A.locator('#auditCard')).toBeVisible();
  await A.locator('#audLoad').click();
  const result = A.locator('#audResult');
  await expect(result).toContainText('Sesiones', { timeout: 20_000 });
  await A.locator('#audUser').selectOption({ label: 'Ana Admisión' });
  await expect(result).toContainText('Abrió la ficha');
  await expect(result).toContainText('Abrió la atención');
  await expect(result).toContainText('Descargó el PDF');
  await expect(result).toContainText('Paciente Clínico');
  await expect(result).toContainText('Guardó cambios'); // su ingreso
  await A.locator('#audGroup').selectOption('sesiones');
  await expect(result).toContainText('Inició sesión');
  const [xlsx] = await Promise.all([A.waitForEvent('download'), A.locator('#audXlsx').click()]);
  expect(xlsx.suggestedFilename()).toMatch(/^registro_accesos_.*\.xlsx$/);
  // Ana no ve el registro.
  await expect(B.locator('#auditCard')).toBeHidden();
  await Promise.all([ca.close(), cb.close()]);
});
