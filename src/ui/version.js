/**
 * Versión publicada de la app frente a la que está abierta en este equipo.
 * La usan el chequeo del equipo y el aviso de versión nueva.
 */
import { APP } from '../config/catalogs.js';

/**
 * Compara la compilación abierta con la publicada.
 * @param {string} running compilación abierta (APP.build)
 * @param {{version?: string, build?: string} | null} published contenido de version.json
 * @returns {'same' | 'newer' | 'unknown'}
 */
export function compareBuild(running, published) {
  if (!running || running.startsWith('__') || !published?.build) return 'unknown';
  return published.build === running ? 'same' : 'newer';
}

/**
 * Lee version.json (siempre de la red: el service worker no lo guarda).
 * @returns {Promise<{state: 'same' | 'newer' | 'unknown' | 'offline' | 'file' | 'error', version?: string, status?: number}>}
 */
export async function fetchPublishedVersion(fetchFn = globalThis.fetch.bind(globalThis)) {
  if (location.protocol === 'file:') return { state: 'file' };
  try {
    const res = await fetchFn('version.json', { cache: 'no-store' });
    if (!res.ok) return { state: 'error', status: res.status };
    const pub = await res.json();
    return { state: compareBuild(APP.build, pub), version: pub.version };
  } catch {
    return { state: 'offline' };
  }
}
