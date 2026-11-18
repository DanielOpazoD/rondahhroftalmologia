/**
 * Comprobaciones de tipo para datos que llegan de afuera (respaldos, red,
 * almacenamiento): reciben `unknown` y, si pasan, el verificador de tipos ya
 * sabe qué forma tienen (sin conversiones a `any`).
 */

/**
 * ¿Es un objeto con propiedades (no nulo ni lista)?
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
