import { test, expect } from './fixtures.js';
import { openApp, tab, fillPatient, save, showPatientRecord, ajustes } from './helpers.js';

/** Crea un perfil desde Ajustes. */
async function addProfile(page, { nombre, rol, rut = '' }) {
  await ajustes(page, 'Listas');
  await page.locator('#medAdd').click();
  const dlg = page.locator('#dlg');
  await dlg.locator('#dlg_nombres').fill(nombre);
  await dlg.locator('#dlg_rol').selectOption(rol);
  if (rut) await dlg.locator('#dlg_rut').fill(rut);
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  await expect(dlg).toBeHidden();
}

test('quién registra: se elige el perfil y queda en el historial; solo médicos como médico', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#userChip')).toBeHidden(); // sin perfiles no se pregunta nada
  await addProfile(page, { nombre: 'TENS Rapa', rol: 'tens' });
  await addProfile(page, { nombre: 'Dr. Hotu', rol: 'medico', rut: '10.000.013-K' });
  await expect(page.locator('#userChip')).toHaveText('Elegir perfil');
  await expect(page.locator('#medList')).toContainText('TENS');

  await tab(page, 'Atención');
  await expect(page.locator('#medicoSel option', { hasText: 'TENS Rapa' })).toHaveCount(0);
  await expect(page.locator('#medicoSel option', { hasText: 'Dr. Hotu' })).toHaveCount(1);
  await fillPatient(page, { nombre: 'Paciente Perfil' });
  await save(page);
  const dlg = page.locator('#dlg');
  await expect(dlg.locator('#dlgTitle')).toHaveText('¿Quién registra?');
  await dlg.locator('#dlg_perfil').selectOption({ label: 'TENS Rapa · TENS' });
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await expect(page.locator('#userChip')).toHaveText('TENS Rapa');
  await expect(page.locator('#histList')).toContainText('TENS Rapa');

  // Un segundo guardado en la misma sesión no vuelve a preguntar.
  await page.locator('#od_pio').fill('17');
  await save(page);
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await expect(dlg).toBeHidden();

  // Cambia a un médico: la atención nueva lo trae como médico.
  await page.locator('#userChip').click();
  await dlg.locator('#dlg_perfil').selectOption({ label: 'Dr. Hotu · Médico/a' });
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await page.locator('#bNew').click();
  await expect(page.locator('#medicoSel option:checked')).toHaveText('Dr. Hotu · 10.000.013-K');
});

test('identidad: ingresado sin RUT y luego con RUT sigue siendo el mismo paciente', async ({ page }) => {
  await openApp(page);
  await tab(page, 'Ingreso');
  await page.locator('#ingFecha').fill('2018-04-02');
  await page.locator('#ingFecha').dispatchEvent('change');
  await page.locator('#ing_nombres').fill('Rosa Sin Rut');
  await page.locator('#ingAdd').click();
  await page.locator('#ingList .pmain', { hasText: 'Rosa Sin Rut' }).click();
  await page.locator('#paciente_rut').fill('12.345.678-5');
  await save(page);
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  // Otro día la ingresan solo por RUT: la reconoce y no crea otra ficha.
  await tab(page, 'Ingreso');
  await page.locator('#ingFecha').fill('2018-05-07');
  await page.locator('#ingFecha').dispatchEvent('change');
  await page.locator('#ing_rut').fill('123456785');
  await page.locator('#ing_rut').blur();
  await expect(page.locator('#ingHint')).toContainText('Paciente ya registrado');
  await expect(page.locator('#ing_nombre')).toHaveValue('Rosa Sin Rut');
  await page.locator('#ingAdd').click();
  await showPatientRecord(page, 'Rosa Sin Rut');
  await expect(page.locator('#patAttentions .prow')).toHaveCount(2);
  await page.locator('#patBack').click();
  await expect(page.locator('#regList .prow', { hasText: 'Rosa Sin Rut' })).toHaveCount(1);
});

test('posibles duplicados: se detectan y se unen sin perder atenciones', async ({ page }) => {
  await openApp(page);
  await fillPatient(page, { nombre: 'Jose Perez', fecha: '2017-03-01' });
  await save(page);
  await page.locator('#bNew').click();
  await fillPatient(page, { nombre: 'José Pérez', rut: '10.000.013-K', fecha: '2017-09-01' });
  await save(page);
  await tab(page, 'Pacientes');
  const box = page.locator('#dupBox');
  await expect(box).toBeVisible();
  await expect(page.locator('#dupTitle')).toHaveText('1 posible duplicado');
  await box.locator('summary').click();
  await box.getByRole('button', { name: /Unir en José Pérez/ }).click();
  await page.locator('#msgDlg').getByRole('button', { name: 'Unir' }).click();
  await expect(page.locator('#toast')).toContainText('Fichas unidas');
  await expect(box).toBeHidden();
  await expect(page.locator('#regList .prow')).toHaveCount(1);
  await showPatientRecord(page, 'José Pérez');
  await expect(page.locator('#patAttentions .prow')).toHaveCount(2);
});

test('quién registra: «Nuevo perfil…» desde la pregunta crea el perfil y lo usa', async ({ page }) => {
  await openApp(page);
  await addProfile(page, { nombre: 'Dr. Existente', rol: 'medico' });
  await tab(page, 'Atención');
  await fillPatient(page, { nombre: 'Paciente Nuevo Perfil' });
  await save(page);
  const dlg = page.locator('#dlg');
  await dlg.locator('#dlg_perfil').selectOption({ label: '＋ Nuevo perfil…' });
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await expect(dlg.locator('#dlgTitle')).toHaveText('Nuevo perfil');
  await expect(dlg).toBeVisible();
  await dlg.locator('#dlg_nombres').fill('Enf. Nueva');
  await dlg.locator('#dlg_rol').selectOption('enfermeria');
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.locator('#toast')).toContainText('Atención guardada');
  await expect(page.locator('#userChip')).toHaveText('Enf. Nueva');
  await expect(page.locator('#histList')).toContainText('Enf. Nueva');
});

test('quién registra: el guardado automático no reemplaza la pregunta abierta', async ({ page }) => {
  // Antes: al guardar, el guardado automático pendiente (1,2 s tras escribir)
  // abría una segunda pregunta que reemplazaba al formulario «Nuevo perfil».
  await openApp(page);
  await addProfile(page, { nombre: 'Dr. Existente', rol: 'medico' });
  await tab(page, 'Atención');
  await fillPatient(page, { nombre: 'Paciente Espera' });
  await save(page);
  const dlg = page.locator('#dlg');
  await dlg.locator('#dlg_perfil').selectOption({ label: '＋ Nuevo perfil…' });
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await expect(dlg.locator('#dlgTitle')).toHaveText('Nuevo perfil');
  await page.waitForTimeout(2000); // más que la pausa del guardado automático
  await expect(dlg.locator('#dlgTitle')).toHaveText('Nuevo perfil');
  await dlg.locator('#dlg_nombres').fill('Enf. Paciente');
  await dlg.locator('#dlg_rol').selectOption('enfermeria');
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#userChip')).toHaveText('Enf. Paciente');
  await expect(page.locator('#histList')).toContainText('Enf. Paciente');
  // Una sola atención guardada (el guardado automático no creó otra).
  await showPatientRecord(page, 'Paciente Espera');
  await expect(page.locator('#patAttentions .prow')).toHaveCount(1);
});
