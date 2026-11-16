#!/usr/bin/env node
/**
 * Servidor local para probar la app con sincronización, sin Netlify:
 * sirve dist/ y responde /api/sync/* con la misma lógica que la función de
 * Netlify, guardando en memoria (se pierde al cerrar).
 *
 * Uso:
 *   npm run build
 *   SYNC_TOKEN_SHA256=<valor de Ajustes> npm run dev
 *   -> http://localhost:8787  y  http://127.0.0.1:8787 (dos orígenes = dos "PC" distintos)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncHandler, memoryBlobStore } from '../src/sync/server.js';
import { createAccounts } from '../src/sync/accounts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 8787);
const secret = (process.env.SYNC_TOKEN_SHA256 || '').toLowerCase();
/** Sincronización y cuentas sobre el mismo almacén en memoria (como en Netlify). */
const makeHandlers = () => {
  const store = memoryBlobStore();
  const accounts = createAccounts({ store, secret });
  return { sync: createSyncHandler({ store, tokenHash: secret, accounts }), accounts: accounts.handler };
};
let handlers = makeHandlers();
/** Solo para las pruebas en navegador: cada prueba empieza con el servidor vacío. */
const TEST_RESET = process.env.E2E_RESET === '1';
/** @type {Readonly<Record<string, string>>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

/** @typedef {import('node:http').IncomingMessage} Req @typedef {import('node:http').ServerResponse} Res */

/** Manejador de la API para una ruta, o null si no es de la API. @param {string} pathname */
function apiFor(pathname) {
  if (pathname.startsWith('/api/sync/')) return handlers.sync;
  if (pathname.startsWith('/api/cuentas/')) return handlers.accounts;
  return null;
}

/**
 * Convierte la solicitud de Node en una `Request` estándar (la que reciben las funciones de Netlify).
 * @param {Req} req @param {URL} url
 */
async function toRequest(req, url) {
  const method = req.method || 'GET';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks);
  return new Request(url, { method, headers, body });
}

/** @param {Res} res @param {Response} r */
async function sendResponse(res, r) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

/** Sirve un archivo de dist/ (403 si la ruta sale de dist/). @param {Res} res @param {string} pathname */
async function serveFile(res, pathname) {
  const path = normalize(resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname))));
  if (!path.startsWith(root + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const data = await readFile(path);
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
  res.end(data);
}

/** @param {Req} req @param {Res} res */
async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (TEST_RESET && req.method === 'POST' && url.pathname === '/__test__/reset') {
    handlers = makeHandlers();
    res.writeHead(204);
    res.end();
    return;
  }
  const api = apiFor(url.pathname);
  if (api) await sendResponse(res, await api(await toRequest(req, url)));
  else await serveFile(res, url.pathname);
}

createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch {
    res.writeHead(404);
    res.end('No encontrado');
  }
}).listen(port, () => {
  console.log(`App en http://localhost:${port} y http://127.0.0.1:${port}`);
  if (!process.env.SYNC_TOKEN_SHA256) console.log('Aviso: sin SYNC_TOKEN_SHA256 la sincronización responde 503 (no configurada).');
});
