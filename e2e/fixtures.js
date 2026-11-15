/**
 * `test` de las pruebas en navegador: antes de cada prueba se vacía el
 * servidor de sincronización local, así ninguna prueba ve los datos que dejó
 * otra (ni una repetición de sí misma). Todas las pruebas importan desde aquí.
 */
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  syncVacio: [
    async ({ request }, use) => {
      const r = await request.post('/__test__/reset');
      if (r.status() !== 204) throw new Error('El servidor de pruebas no permite reiniciarse (¿falta E2E_RESET=1?)');
      await use(undefined);
    },
    { auto: true },
  ],
});
export { expect };
