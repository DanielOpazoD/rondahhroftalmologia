import { test, expect } from './fixtures.js';
import { openApp, tab, ajustes } from './helpers.js';
import { normalizeRecord } from '../src/core/record.js';
import { missingPatients } from '../src/core/patient.js';
import { buildBackup } from '../src/core/backup.js';
import { rutCheckDigit } from '../src/core/format.js';

/** Respaldo sintético: 510 pacientes con una atención cada uno, del más nuevo al más antiguo. */
function bigBackup() {
  const records = Array.from({ length: 510 }, (_, i) => {
    const body = String(6_000_000 + i * 7919);
    const day = new Date(Date.UTC(2026, 10, 1) - i * 86_400_000).toISOString().slice(0, 10);
    // Los dos más antiguos se llaman igual (uno sin RUT): «Posibles duplicados» los muestra.
    const old = i >= 508;
    const t = Date.UTC(2026, 10, 1) - i * 1000;
    return normalizeRecord({
      id: 'p' + i.toString(36).padStart(5, '0'),
      created: t,
      updated: t,
      f: {
        fecha_atencion: day,
        paciente_rut: old && i === 509 ? '' : `${body}-${rutCheckDigit(body)}`,
        paciente_apellido_paterno: old ? 'Antiguo' : `Paterno${i}`,
        paciente_apellido_materno: old ? 'Duplicado' : 'Prueba',
        paciente_nombres: old ? 'Zoe' : 'Ana',
        paciente_nombre: old ? 'Antiguo Duplicado Zoe' : `Paterno${i} Prueba Ana`,
      },
    });
  });
  return JSON.stringify(buildBackup({ records, procs: [], patients: missingPatients(records, new Map()) }));
}

test('pacientes: más de 500 se muestran por páginas; «Mostrar más» y «Ver ficha» llevan a la fila correcta', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await ajustes(page, 'Datos');
  await page.locator('#bkImp').setInputFiles({ name: 'respaldo.json', mimeType: 'application/json', buffer: Buffer.from(bigBackup()) });
  await page.locator('#msgDlg').getByRole('button').first().click({ timeout: 60_000 });
  await tab(page, 'Pacientes');
  const rows = page.locator('#regList button[data-p]');
  await expect(rows).toHaveCount(500);
  await expect(page.locator('#regCount')).toHaveText('510');
  // «Ver ficha» desde los posibles duplicados: el paciente está más allá de la página mostrada.
  await page.locator('#dupBox summary').click();
  await page.locator('#dupList button[data-a="view"]').first().click();
  const open = page.locator('#regList button[data-p][aria-expanded="true"]');
  await expect(open).toHaveCount(1);
  await expect(open).toContainText('Antiguo');
  await expect(open).toBeFocused();
  // Una búsqueda vuelve a la primera página; «Mostrar más» deja el foco en la primera fila nueva.
  await page.locator('#regSearch').fill('Prueba');
  await expect(rows).toHaveCount(500);
  await page.getByRole('button', { name: /Mostrar \d+ más/ }).click();
  await expect(rows).toHaveCount(508);
  await expect(rows.nth(500)).toBeFocused();
});
