// Loopback-only JSON API and UI host (TRD §Local dashboard and request transport).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonIfExists } from '../lib/atomic-fs.js';
import { ticketDetailPath } from '../worker/projections.js';
import { getBlob } from '../core/blobs.js';
import { TrackerError } from '../lib/errors.js';
import { submitRequest, cancelRequest } from './requests.js';
import { memoryListing } from '../core/memory.js';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const MAX_BODY = 256 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function fail(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new TrackerError('body-too-large', 'request body exceeds 256 KB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, uiDir, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/ui\//, '').replace(/^\//, '');
  const file = path.resolve(uiDir, rel);
  if (!file.startsWith(path.resolve(uiDir) + path.sep) && file !== path.resolve(uiDir, 'index.html')) return fail(res, 404, 'not-found', 'not found');
  let data;
  try { data = fs.readFileSync(file); } catch { return fail(res, 404, 'not-found', 'not found'); }
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  return send(res, 200, data, { 'Content-Type': type, 'Content-Security-Policy': CSP });
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// What a browser without an owner session sees instead of the dashboard (ADR 0022): how to sign
// in, in the dashboard's own tokens. It carries no data and no script.
export const SIGN_IN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Sign in · Session Quill</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>
  .sign-in { max-width: 34rem; margin: 18vh auto 0; padding: 28px 32px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .sign-in h1 { font-size: 20px; margin: 0 0 8px; }
  .sign-in p { color: var(--text-muted); margin: 8px 0; }
  .sign-in code { color: var(--text); }
</style>
</head>
<body>
<main class="sign-in">
  <h1>Sign in to Session Quill</h1>
  <p>This browser is not signed in to your dashboard, or its sign-in was revoked.</p>
  <p>In Claude Code, run <code>/session-quill:ui</code>. From a terminal, run <code>quill ui</code>.</p>
  <p>Either opens a one-use link that signs this browser in for 7 days.</p>
</main>
</body>
</html>
`;

export function createServer(worker, { auth, uiDir = UI_DIR, exportHandler = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const port = server.address() ? server.address().port : null;
    const url = new URL(req.url, 'http://127.0.0.1');
    const originCheck = auth.checkOrigin(req, port);
    if (!originCheck.ok) return fail(res, 403, 'origin-rejected', originCheck.reason);

    try {
      if (req.method === 'GET' && url.pathname === '/auth') {
        const token = auth.exchangeSecret(url.searchParams.get('secret'));
        if (!token) return fail(res, 403, 'secret-invalid', 'bootstrap secret is invalid, expired or already used; run `quill ui` again');
        // Redirect immediately so the secret leaves the address bar.
        return send(res, 302, '', { Location: '/', 'Set-Cookie': auth.cookieHeader(token) });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/ui/'))) {
        // Scripts, styles and fonts hold no data; the page itself needs an owner session.
        const page = url.pathname === '/' || url.pathname.endsWith('.html');
        if (page) {
          const pageToken = auth.tokenFromRequest(req);
          if (!pageToken) return send(res, 401, SIGN_IN_PAGE, { 'Content-Type': TYPES['.html'], 'Content-Security-Policy': CSP });
          res.setHeader('Set-Cookie', auth.cookieHeader(pageToken));
        }
        return serveStatic(res, uiDir, url.pathname);
      }
      // The page ships an inline SVG icon; answer the browser's automatic probe without a console error.
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(res, 204, '');
      if (!url.pathname.startsWith('/v1/')) return fail(res, 404, 'not-found', 'not found');

      const token = auth.tokenFromRequest(req);
      if (!token) return fail(res, 401, 'unauthenticated', 'owner session required; open the dashboard with `quill ui`');
      // The session slid forward on this request; so does the cookie's Max-Age (ADR 0022).
      res.setHeader('Set-Cookie', auth.cookieHeader(token));

      if (req.method === 'GET') {
        if (url.pathname === '/v1/csrf') return json(res, 200, { csrf: auth.csrfFor(token) });
        if (url.pathname === '/v1/snapshot') return json(res, 200, worker.getSnapshot());
        // Memory (spec §6.4, §9) is served only here, to the owner session: never in the snapshot,
        // so no export, mirror or publisher built from a snapshot can carry it.
        if (url.pathname === '/v1/memory') return json(res, 200, { generated_at: worker.now(), ...memoryListing(worker.state, Date.parse(worker.now())) });
        let m;
        if ((m = /^\/v1\/tickets\/([0-9a-f-]{36})$/.exec(url.pathname))) {
          const gen = url.searchParams.get('generation');
          const current = worker.getSnapshot().generation_id;
          if (gen && gen !== current) return fail(res, 410, 'generation-expired', `generation ${gen} is no longer current (${current}); reload the snapshot`);
          const detail = readJsonIfExists(ticketDetailPath(worker.env, m[1]));
          if (!detail || !worker.state.tickets.has(m[1])) return fail(res, 404, 'not-found', 'ticket not in this generation');
          return json(res, 200, { ...detail, generation_id: current });
        }
        if ((m = /^\/v1\/content\/([0-9a-f]{64})$/.exec(url.pathname))) {
          const gen = url.searchParams.get('generation');
          const current = worker.getSnapshot().generation_id;
          if (gen && gen !== current) return fail(res, 410, 'generation-expired', `generation ${gen} is no longer current (${current})`);
          const text = getBlob(m[1], worker.env);
          if (text === null) return fail(res, 404, 'not-found', 'content unavailable (capture incomplete)');
          return send(res, 200, text, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if ((m = /^\/v1\/requests\/([0-9a-f-]{36})$/.exec(url.pathname))) {
          const r = worker.state.requests.get(m[1]);
          return r ? json(res, 200, r) : fail(res, 404, 'not-found', 'unknown request');
        }
        if (url.pathname === '/v1/export/preview' && exportHandler) return json(res, 200, exportHandler.preview(worker, Object.fromEntries(url.searchParams)));
        return fail(res, 404, 'not-found', 'not found');
      }

      if (req.method === 'POST') {
        if (!auth.verifyCsrf(token, req.headers['x-quill-csrf'])) return fail(res, 403, 'csrf-invalid', 'missing or invalid CSRF token');
        if (req.headers.origin === undefined && !(req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === undefined)) return fail(res, 403, 'origin-rejected', 'cross-site request rejected');
        let body = {};
        const raw = await readBody(req);
        if (raw.trim()) {
          try { body = JSON.parse(raw); } catch { return fail(res, 400, 'request-invalid', 'body is not valid JSON'); }
        }
        if (url.pathname === '/v1/requests') {
          const { status, request } = submitRequest(worker, body);
          return json(res, status, request);
        }
        let m;
        if ((m = /^\/v1\/requests\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname))) {
          const outcome = cancelRequest(worker, m[1]);
          return json(res, outcome.outcome === 'unknown' ? 404 : 200, outcome);
        }
        if (url.pathname === '/v1/export' && exportHandler) return json(res, 200, exportHandler.run(worker, body));
        return fail(res, 404, 'not-found', 'not found');
      }
      return fail(res, 405, 'method-not-allowed', 'method not allowed');
    } catch (err) {
      if (err instanceof TrackerError) return fail(res, err.status ?? 400, err.code, err.message);
      worker.log(`http error: ${err.stack ?? err.message}`);
      return fail(res, 500, 'internal', 'internal error');
    }
  });
  server.keepAliveTimeout = 5000;
  return server;
}

function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// A fixed port keeps the dashboard address stable across restarts (ADR 0022). When something else
// holds it (or the OS reserves it), the server takes a random port rather than not starting.
export async function listen(server, { host = '127.0.0.1', port = 0, fallback = true } = {}) {
  try {
    return await listenOnce(server, host, port);
  } catch (err) {
    if (!fallback || !port || !['EADDRINUSE', 'EACCES'].includes(err && err.code)) throw err;
    return listenOnce(server, host, 0);
  }
}
