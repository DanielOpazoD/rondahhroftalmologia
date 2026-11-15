import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test('en el celular las pestañas van abajo y la barra usa iconos', async ({ page }) => {
  await openApp(page);
  const nav = page.locator('nav');
  const box = await nav.boundingBox();
  const vh = page.viewportSize().height;
  expect(box.y + box.height).toBeGreaterThan(vh - 5);
  await expect(page.locator('#bSave span')).toBeHidden();
  await expect(page.locator('#bSave')).toBeVisible();
  // sin desborde horizontal
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
