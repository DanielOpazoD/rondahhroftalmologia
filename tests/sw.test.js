/**
 * Service worker (public/sw.js): uso sin conexión. Se ejecuta el archivo real
 * en un contexto aislado, con caché y red simuladas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.test';

/**
 * Carga el service worker con una caché inicial y una red que responde `net`.
 * @param {{cached?: Record<string, string>, net?: (url: string) => Promise<Response>}} [o]
 */
function load({ cached = {}, net = () => Promise.reject(new TypeError('sin red')) } = {}) {
  /** @type {Map<string, Response>} */
  const store = new Map(Object.entries(cached).map(([u, body]) => [new URL(u, ORIGIN + '/').href, new Response(body)]));
  /** @type {Record<string, (e: any) => void>} */
  const listeners = {};
  const cache = {
    put: async (/** @type {Request} */ req, /** @type {Response} */ res) => void store.set(req.url, res),
    addAll: async () => {},
  };
  const caches = {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
    match: async (/** @type {Request | string} */ req) => store.get(typeof req === 'string' ? new URL(req, ORIGIN + '/').href : req.url),
  };
  const self = { addEventListener: (/** @type {string} */ t, /** @type {any} */ fn) => (listeners[t] = fn) };
  vm.runInNewContext(SOURCE, { self, caches, fetch: net, location: { origin: ORIGIN }, URL, Response, Promise });
  /**
   * Despacha un `fetch`; devuelve la respuesta del service worker, o null si no intervino.
   * @param {string} path ruta, o URL completa de otro origen @param {string} [method]
   */
  const request = async (path, method = 'GET') => {
    /** @type {Promise<Response> | null} */
    let answer = null;
    listeners.fetch({ request: new Request(new URL(path, ORIGIN), { method }), respondWith: (/** @type {any} */ p) => (answer = p) });
    return answer && (await answer);
  };
  return { request, store };
}

test('sw: con red responde de la red y guarda una copia', async () => {
  const sw = load({ net: async () => new Response('nueva') });
  const r = await sw.request('/index.html');
  assert.equal(await r?.text(), 'nueva');
  await new Promise((done) => setImmediate(done));
  assert.ok(sw.store.has(`${ORIGIN}/index.html`));
});

test('sw: sin red usa la copia guardada de esa página', async () => {
  const sw = load({ cached: { './icon.svg': 'icono', './index.html': 'app' } });
  assert.equal(await (await sw.request('/icon.svg'))?.text(), 'icono');
});

test('sw: sin red y sin copia de la página, abre la app guardada', async () => {
  const sw = load({ cached: { './index.html': 'app' } });
  assert.equal(await (await sw.request('/otra')).text(), 'app');
});

test('sw: sin red ni nada guardado responde un error de red explícito', async () => {
  // Antes respondía respondWith(undefined): un error del propio service worker.
  const r = await load().request('/index.html');
  assert.ok(r instanceof Response);
  assert.equal(r.type, 'error');
});

test('sw: no interviene en la API, version.json, otros orígenes ni métodos distintos de GET', async () => {
  let calls = 0;
  const sw = load({ net: async () => (calls++, new Response('x')) });
  assert.equal(await sw.request('/api/sync/pull'), null);
  assert.equal(await sw.request('/version.json'), null);
  assert.equal(await sw.request('/index.html', 'POST'), null);
  assert.equal(await sw.request('https://otro.test/index.html'), null);
  assert.equal(calls, 0);
});
