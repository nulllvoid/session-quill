// Loopback-only JSON API and UI host (TRD §Local dashboard and request transport).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectionsDir } from '../lib/paths.js';
import { readJsonIfExists } from '../lib/atomic-fs.js';
import { getBlob } from '../core/blobs.js';
import { TrackerError } from '../lib/errors.js';
import { submitRequest, cancelRequest } from './requests.js';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const MAX_BODY = 256 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

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
  const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  return send(res, 200, data, { 'Content-Type': type, 'Content-Security-Policy': csp });
}

export function createServer(worker, { auth, uiDir = UI_DIR, exportHandler = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const port = server.address() ? server.address().port : null;
    const url = new URL(req.url, 'http://127.0.0.1');
    const originCheck = auth.checkOrigin(req, port);
    if (!originCheck.ok) return fail(res, 403, 'origin-rejected', originCheck.reason);

    try {
      if (req.method === 'GET' && url.pathname === '/auth') {
        const token = auth.exchangeSecret(url.searchParams.get('secret'));
        if (!token) return fail(res, 403, 'secret-invalid', 'bootstrap secret is invalid, expired or already used; run `tracker ui` again');
        // Redirect immediately so the secret leaves the address bar.
        return send(res, 302, '', { Location: '/', 'Set-Cookie': auth.cookieHeader(token) });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/ui/'))) return serveStatic(res, uiDir, url.pathname);
      if (!url.pathname.startsWith('/v1/')) return fail(res, 404, 'not-found', 'not found');

      const token = auth.tokenFromRequest(req);
      if (!token) return fail(res, 401, 'unauthenticated', 'owner session required; open the dashboard with `tracker ui`');

      if (req.method === 'GET') {
        if (url.pathname === '/v1/csrf') return json(res, 200, { csrf: auth.csrfFor(token) });
        if (url.pathname === '/v1/snapshot') return json(res, 200, worker.getSnapshot());
        let m;
        if ((m = /^\/v1\/tickets\/([0-9a-f-]{36})$/.exec(url.pathname))) {
          const gen = url.searchParams.get('generation');
          const current = worker.getSnapshot().generation_id;
          if (gen && gen !== current) return fail(res, 410, 'generation-expired', `generation ${gen} is no longer current (${current}); reload the snapshot`);
          const detail = readJsonIfExists(path.join(projectionsDir(worker.env), current, 'tickets', `${m[1]}.json`));
          if (!detail) return fail(res, 404, 'not-found', 'ticket not in this generation');
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
        if (!auth.verifyCsrf(token, req.headers['x-tracker-csrf'])) return fail(res, 403, 'csrf-invalid', 'missing or invalid CSRF token');
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

export function listen(server, { host = '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}
