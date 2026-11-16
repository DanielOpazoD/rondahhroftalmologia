import { test, expect } from './fixtures.js';
import { openApp, ajustes } from './helpers.js';

/** Rectángulos de la marca, cada pestaña y la zona derecha de la cabecera. */
const headerBoxes = (page) =>
  page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width };
    };
    const bar = document.querySelector('.topin');
    const parts = [
      ['marca', document.querySelector('.brand')],
      ...[...document.querySelectorAll('nav button')].map((b) => [`pestaña ${b.textContent.trim()}`, b]),
      ['derecha', document.querySelector('.topr')],
    ].filter(([, el]) => el && getComputedStyle(el).display !== 'none' && el.getClientRects().length);
    return { bar: r(bar), overflow: bar.scrollWidth - bar.clientWidth, parts: parts.map(([n, el]) => ({ n, ...r(el) })) };
  });

test('cabecera: nada se superpone ni se sale, en cualquier ancho y con un nombre de perfil largo', async ({ page }) => {
  await openApp(page);
  await ajustes(page, 'Listas');
  await page.locator('#medAdd').click();
  await page.locator('#dlg_nombre').fill('Dra. María Fernanda de los Ángeles Pakarati Tuki');
  await page.locator('#dlg').getByRole('button', { name: 'Guardar' }).click();
  await page.locator('#userChip').click();
  await page.locator('#dlg').getByRole('button', { name: 'Continuar' }).click();

  for (const width of [1440, 1180, 1040, 1000, 860, 780]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(150); // la cabecera se ajusta en el siguiente cuadro
    const { overflow, parts } = await headerBoxes(page);
    expect(overflow, `a ${width}px el contenido de la cabecera se sale`).toBeLessThanOrEqual(1);
    // Las piezas que están en la misma fila no se cruzan.
    const row = parts.filter((p) => p.top < 60);
    for (let i = 0; i < row.length; i++) {
      for (let j = i + 1; j < row.length; j++) {
        const [a, b] = [row[i], row[j]];
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        expect(overlap, `a ${width}px se superponen «${a.n}» y «${b.n}»`).toBeLessThanOrEqual(0.5);
      }
    }
  }
  // Con espacio, la marca muestra su nombre; sin espacio, solo el logo (y las pestañas su nombre accesible).
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.waitForTimeout(150);
  await expect(page.locator('.brand b')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Pacientes' })).toBeVisible();
});
