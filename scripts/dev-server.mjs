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
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (TEST_RESET && req.method === 'POST' && url.pathname === '/__test__/reset') {
      handlers = makeHandlers();
      res.writeHead(204);
      return res.end();
    }
    const api = url.pathname.startsWith('/api/sync/') ? handlers.sync : url.pathname.startsWith('/api/cuentas/') ? handlers.accounts : null;
    if (api) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const r = await api(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const path = normalize(resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname))));
    if (!path.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('No encontrado');
  }
}).listen(port, () => {
  console.log(`App en http://localhost:${port} y http://127.0.0.1:${port}`);
  if (!process.env.SYNC_TOKEN_SHA256) console.log('Aviso: sin SYNC_TOKEN_SHA256 la sincronización responde 503 (no configurada).');
});
