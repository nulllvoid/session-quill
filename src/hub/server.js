// The self-hosted team hub (ADR 0044): a small HTTP service a team runs on its own machine.
// Members' workers push sanitized, read-only copies of their boards; people with a token read
// them in a browser. The hub never writes to a member's store and holds no model or tracker
// credentials. Node built-ins only.
//
//   GET  /healthz                       liveness; no data
//   GET  /login, POST /login            browser sign-in with any token
//   POST /logout
//   GET  /                              team overview (signed in)
//   GET  /b/<member>/<store>/           one board, rendered by the hub's own dashboard copy
//   GET  /v1/team                       the overview as JSON (session or bearer token)
//   PUT  /v1/snapshot                   push a board (bearer token with the member role)
//   DELETE /v1/snapshot/<store>         remove one of your own boards (member)
//   GET  /b/<member>/<store>/t/<ticket> one ticket; POST proposes a change (ADR 0045, member role)
//   GET  /v1/edits?store_id=<store>     proposed changes waiting for your own board (member)
//   POST /v1/edits/ack                  mark them collected
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { renderStaticHtml } from '../export/static.js';
import { toIso } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';
import { initHub, hubSecret, findToken, tokenById, saveBoard, readBoard, listBoards, removeBoard, canSee, listEdits, queueEdit, ackEdits, NAME_RE, STORE_ID_RE } from './store.js';
import { acceptSnapshot } from './accept.js';
import { teamOverview } from './team.js';
import { overviewPage, signInPage, messagePage, ticketPage, boardFramePage, ticketHref, EDIT_STATUSES } from './page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, '..', '..', 'ui');
export const DEFAULT_PORT = 47400;
export const DEFAULT_MAX_BODY = 8 * 1024 * 1024;
export const API_VERSION = 1;
export const MAX_BOARDS_PER_MEMBER = 10;
const SESSION_MS = 7 * 86_400_000;
const COOKIE = 'quill_hub';
const FAIL_WINDOW_MS = 5 * 60_000;
const FAIL_LIMIT = 10;
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_NEXT_ACTION = 2000;
const FONTS = new Set(['Geist-Variable.woff2', 'GeistMono-Variable.woff2']);

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
// The page that frames a board: the hub's own bar above the dashboard, which keeps its own viewport.
const FRAME_PAGE_CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PAGE_CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
const fail = (res, status, code, message, headers = {}) => json(res, status, { error: { code, message } }, headers);
const page = (res, status, html, headers = {}) => send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, ...headers });
const redirect = (res, location, headers = {}) => send(res, 303, '', { Location: location, ...headers });

// A declared length over the limit is refused before any of it is read. A body that grows past
// the limit anyway stops being read; the caller answers 413 and the connection closes.
function readBody(req, max) {
  const tooLarge = () => new TrackerError('body-too-large', `request body exceeds ${Math.round(max / 1024)} KB`);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size > max) { req.off('data', onData); req.pause(); reject(tooLarge()); return; }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The hub's stylesheet: the design tokens and q-* primitives the dashboard kit ships, then the
// hub's own rules. The kit refers to its fonts relatively; here they are served under /ui/fonts.
function hubCss() {
  const read = (file) => fs.readFileSync(file, 'utf8');
  const tokens = read(path.join(UI_DIR, 'assets', 'tokens.css')).replaceAll('url("../fonts/', 'url("/ui/fonts/');
  return `${tokens}\n${read(path.join(UI_DIR, 'assets', 'components.css'))}\n${read(path.join(HERE, 'hub.css'))}`;
}

// A board page carries its snapshot and the dashboard bundle inline, like an export. Its policy
// names those two scripts by hash, so nothing else can run on the hub's origin.
function boardCsp(html) {
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return `default-src 'none'; script-src ${hashes.join(' ') || "'none'"}; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
}

export function createHub({ dir, name = 'Team hub', secureCookies = false, trustProxy = false, maxBody = DEFAULT_MAX_BODY, clock = Date.now, log = () => {} }) {
  const now = () => toIso(clock());
  initHub(dir, { now: now() });
  const secret = hubSecret(dir);
  const css = hubCss();
  const mark = fs.readFileSync(path.join(UI_DIR, 'assets', 'brand', 'quill-mark-light.svg'));
  const failures = new Map();
  const boardPages = new Map();

  const clientIp = (req) => {
    const fwd = trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
    return fwd || req.socket.remoteAddress || 'unknown';
  };
  const blocked = (ip) => {
    const f = failures.get(ip);
    return !!f && f.until > clock() && f.count >= FAIL_LIMIT;
  };
  const noteFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || f.until <= clock()) failures.set(ip, { count: 1, until: clock() + FAIL_WINDOW_MS });
    else f.count += 1;
    if (failures.size > 10_000) for (const [k, v] of failures) if (v.until <= clock()) failures.delete(k);
  };

  const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url');
  const cookieFor = (token) => {
    const value = `${token.id}.${clock() + SESSION_MS}`;
    return `${value}.${sign(value)}`;
  };
  const isSecure = (req) => secureCookies || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const cookieHeader = (req, value, maxAgeS) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${isSecure(req) ? '; Secure' : ''}`;

  function sessionToken(req) {
    const raw = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
    const part = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
    if (!part) return null;
    const [id, exp, mac] = part.slice(COOKIE.length + 1).split('.');
    if (!id || !exp || !mac || !/^\d+$/.test(exp)) return null;
    const expected = Buffer.from(sign(`${id}.${exp}`));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (Number(exp) <= clock()) return null;
    // A revoked token signs its browsers out at once.
    return tokenById(dir, id);
  }

  function bearerToken(req) {
    const h = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m ? findToken(dir, m[1]) : null;
  }

  // A form post must come from the hub's own pages. Browsers say so in Sec-Fetch-Site; the Origin
  // comparison covers the ones that do not. A client that sends neither is not a browser, and a
  // cross-site page cannot make a browser omit both.
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string') return site === 'same-origin' || site === 'none';
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  // Parsed boards are kept until their owner pushes again, so the overview does not re-read every
  // snapshot from disk on each request.
  const parsed = new Map();
  // `who` limits the result to the boards that token may read; without it, every board.
  function boards(who = null) {
    const out = [];
    const live = new Set();
    for (const b of listBoards(dir)) {
      const key = `${b.name}/${b.store_id}`;
      live.add(key);
      const hit = parsed.get(key);
      if (who && !canSee(who, b.name)) continue;
      if (hit && hit.info.pushed_at === b.info.pushed_at && hit.info.generation_id === b.info.generation_id) { out.push(hit); continue; }
      const full = readBoard(dir, b.name, b.store_id);
      if (!full) continue;
      const entry = { name: b.name, store_id: b.store_id, info: full.info, snapshot: full.snapshot };
      parsed.set(key, entry);
      out.push(entry);
    }
    for (const key of parsed.keys()) if (!live.has(key)) parsed.delete(key);
    return out;
  }

  function boardPage(member, storeId) {
    const b = readBoard(dir, member, storeId);
    if (!b) return null;
    const key = `${member}/${storeId}`;
    const cached = boardPages.get(key);
    if (cached && cached.pushed_at === b.info.pushed_at && cached.generation_id === b.info.generation_id) return cached;
    const html = renderStaticHtml(b.snapshot).replace(/<title>[^<]*<\/title>/, () => `<title>${member} · Session Quill team hub</title>`);
    const entry = { pushed_at: b.info.pushed_at, generation_id: b.info.generation_id, html, csp: boardCsp(html) };
    boardPages.set(key, entry);
    return entry;
  }

  async function push(req, res, token) {
    if (token.role !== 'member') return fail(res, 403, 'hub-role', 'this token can read the hub but not push to it; pushing needs a member token');
    let body;
    try { body = JSON.parse(await readBody(req, maxBody)); } catch (err) {
      if (err instanceof TrackerError) { res.once('finish', () => req.destroy()); return fail(res, 413, err.code, err.message, { Connection: 'close' }); }
      return fail(res, 400, 'bad-json', 'the request body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad-request', 'expected { store_id, machine_name, snapshot }');
    if (typeof body.store_id !== 'string' || !STORE_ID_RE.test(body.store_id)) return fail(res, 400, 'bad-request', 'store_id must be 1 to 64 letters, digits and dashes');
    let snapshot;
    try { snapshot = acceptSnapshot(body.snapshot); } catch (err) {
      if (err instanceof TrackerError) return fail(res, 422, err.code, err.message);
      throw err;
    }
    // A member's laptop and desktop are two stores; an unbounded number would fill the disk.
    const mine = listBoards(dir).filter((b) => b.name === token.name);
    if (mine.length >= MAX_BOARDS_PER_MEMBER && !mine.some((b) => b.store_id === body.store_id)) {
      return fail(res, 409, 'hub-board-limit', `this token already has ${MAX_BOARDS_PER_MEMBER} boards on the hub; remove one with \`quill hub leave --remove\` on that machine, or ask whoever runs the hub`);
    }
    const info = {
      schema_version: 1,
      pushed_at: now(),
      member: token.name,
      store_id: body.store_id,
      machine_name: typeof body.machine_name === 'string' ? body.machine_name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80) : null,
      generation_id: snapshot.generation_id,
      exported_at: snapshot.meta.exported_at,
      ticket_count: snapshot.tickets.length,
      accepts_edits: body.accepts_edits === true,
    };
    saveBoard(dir, token.name, body.store_id, snapshot, info);
    parsed.delete(`${token.name}/${body.store_id}`);
    boardPages.delete(`${token.name}/${body.store_id}`);
    log(`push ${token.name}/${body.store_id}: ${info.ticket_count} tickets, ${info.generation_id}`);
    return json(res, 200, { ok: true, member: token.name, store_id: body.store_id, pushed_at: info.pushed_at, ticket_count: info.ticket_count });
  }

  // What stands in the way of a proposal on this ticket, or null. A change already on its way
  // blocks the next one: it would be checked against a revision the first is about to replace.
  function editBlock(who, member, board, ticket, edits) {
    if (who.role !== 'member') return 'A viewer token cannot propose changes.';
    if (board.info.accepts_edits !== true) return `${member}'s board does not accept changes from the hub. Its owner can switch that on with: quill hub join --accept-edits --confirm`;
    if (ticket.status === 'done') return 'This ticket is done.';
    if (edits.some((e) => e.expected_revision === ticket.revision)) return `A change proposed here is still on its way to ${member}'s machine. You can propose another once their machine pushes a newer copy of this ticket.`;
    return null;
  }

  function findTicket(who, member, storeId, ticketId) {
    const board = canSee(who, member) ? boards(who).find((b) => b.name === member && b.store_id === storeId) : null;
    const ticket = board ? board.snapshot.tickets.find((t) => t.id === ticketId) : null;
    if (!ticket) return null;
    const edits = listEdits(dir, member, storeId).filter((e) => e.ticket_id === ticketId).sort((a, b) => b.at.localeCompare(a.at));
    return { board, ticket, edits, whyNot: editBlock(who, member, board, ticket, edits) };
  }

  function ticketView(res, who, member, storeId, ticketId, extra = {}) {
    const found = findTicket(who, member, storeId, ticketId);
    if (!found) return page(res, 404, messagePage({ hubName: name, title: 'Ticket not found', message: 'No ticket is stored under that address. Its board may have been removed, or the ticket is no longer shared.' }));
    const { status = 200, ...rest } = extra;
    return page(res, status, ticketPage({ hubName: name, who, member, storeId, info: found.board.info, ticket: found.ticket, edits: found.edits, now: now(), canEdit: !found.whyNot, whyNot: found.whyNot, ...rest }));
  }

  async function proposeEdit(req, res, who, member, storeId, ticketId) {
    if (!sameOrigin(req)) return fail(res, 403, 'forbidden', 'cross-origin request refused');
    const found = findTicket(who, member, storeId, ticketId);
    if (!found) return ticketView(res, who, member, storeId, ticketId);
    if (found.whyNot) return ticketView(res, who, member, storeId, ticketId, { status: 403 });
    const { ticket } = found;
    const again = (status, draft, error) => ticketView(res, who, member, storeId, ticketId, { status, draft, error });
    let form;
    try { form = new URLSearchParams(await readBody(req, 16 * 1024)); } catch { return again(400, null, 'That request could not be read.'); }
    const field = form.get('field');
    const value = (form.get('value') ?? '').replace(/\r\n/g, '\n').trim();
    if (field !== 'status' && field !== 'next_action') return again(400, null, 'That request names no field to change.');
    const draft = { field, value };
    if (field === 'status') {
      if (!EDIT_STATUSES.includes(value)) return again(400, { field, value: '' }, 'Choose a new status first.');
      if (value === ticket.status) return again(400, draft, 'The ticket already has that status on this copy.');
    } else {
      if (value.length > MAX_NEXT_ACTION) return again(400, draft, `A next action is at most ${MAX_NEXT_ACTION} characters.`);
      if (value === (ticket.next_action ?? '').trim()) return again(400, draft, 'Nothing to send: the next action is the same as on this copy.');
    }
    try {
      queueEdit(dir, member, storeId, { ticket_id: ticketId, field, value, expected_revision: Number.isInteger(ticket.revision) ? ticket.revision : 0, by: who.name, at: now() }, clock());
    } catch (err) {
      if (err instanceof TrackerError) return again(409, draft, err.message);
      throw err;
    }
    log(`edit ${who.name} -> ${member}/${storeId} ${ticketId}: ${field}`);
    return redirect(res, `${ticketHref({ member, store_id: storeId, id: ticketId })}?sent=1`);
  }

  async function login(req, res, ip) {
    if (!sameOrigin(req)) return page(res, 403, messagePage({ hubName: name, title: 'Sign-in refused', message: 'That request did not come from this hub\'s own sign-in page.' }));
    if (blocked(ip)) return page(res, 429, signInPage({ hubName: name, error: 'Too many failed attempts from this address. Wait five minutes and try again.' }), { 'Retry-After': '300' });
    let form;
    try { form = new URLSearchParams(await readBody(req, 4096)); } catch { return page(res, 400, signInPage({ hubName: name, error: 'That sign-in request could not be read.' })); }
    const token = findToken(dir, (form.get('token') ?? '').trim());
    if (!token) {
      noteFailure(ip);
      return page(res, 401, signInPage({ hubName: name, error: 'That token is not valid on this hub. Check for missing characters, or ask for a new one.' }));
    }
    return redirect(res, '/', { 'Set-Cookie': cookieHeader(req, cookieFor(token), Math.floor(SESSION_MS / 1000)) });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub.invalid');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    const ip = clientIp(req);

    if (p === '/healthz' && method === 'GET') return json(res, 200, { ok: true, service: 'quill-hub', api: API_VERSION });
    if (p === '/assets/hub.css' && method === 'GET') return send(res, 200, css, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
    if (p === '/assets/mark.svg' && method === 'GET') return send(res, 200, mark, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=86400' });
    if (p.startsWith('/ui/fonts/') && method === 'GET') {
      const file = p.slice('/ui/fonts/'.length);
      if (!FONTS.has(file)) return fail(res, 404, 'not-found', 'not found');
      return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'fonts', file)), { 'Content-Type': 'font/woff2', 'Cache-Control': 'private, max-age=86400' });
    }

    if (p === '/login' && method === 'GET') return sessionToken(req) ? redirect(res, '/') : page(res, 200, signInPage({ hubName: name }));
    if (p === '/login' && method === 'POST') return login(req, res, ip);
    if (p === '/logout' && method === 'POST') {
      if (!sameOrigin(req)) return fail(res, 403, 'forbidden', 'cross-origin request refused');
      return redirect(res, '/login', { 'Set-Cookie': cookieHeader(req, '', 0) });
    }

    if (p.startsWith('/v1/')) {
      if (blocked(ip)) return fail(res, 429, 'too-many-attempts', 'too many failed attempts; wait five minutes', { 'Retry-After': '300' });
      const token = bearerToken(req) ?? (method === 'GET' ? sessionToken(req) : null);
      if (!token) {
        if (req.headers.authorization) noteFailure(ip);
        return fail(res, 401, 'unauthorized', 'a valid hub token is required', { 'WWW-Authenticate': 'Bearer' });
      }
      if (p === '/v1/team' && method === 'GET') return json(res, 200, { hub: name, api: API_VERSION, ...teamOverview(boards(token), now()) });
      if (p === '/v1/edits' && method === 'GET') {
        const storeId = url.searchParams.get('store_id') ?? '';
        if (token.role !== 'member') return fail(res, 403, 'hub-role', 'collecting edits needs a member token');
        if (!STORE_ID_RE.test(storeId)) return fail(res, 400, 'bad-request', 'invalid store id');
        // Only the board's own token collects, and only what is not collected yet.
        return json(res, 200, { edits: listEdits(dir, token.name, storeId).filter((e) => !e.delivered_at).map(({ id, ticket_id, field, value, expected_revision, by, at }) => ({ id, ticket_id, field, value, expected_revision, by, at })) });
      }
      if (p === '/v1/edits/ack' && method === 'POST') {
        if (token.role !== 'member') return fail(res, 403, 'hub-role', 'collecting edits needs a member token');
        let body;
        try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return fail(res, 400, 'bad-json', 'the request body is not valid JSON'); }
        if (!body || typeof body.store_id !== 'string' || !STORE_ID_RE.test(body.store_id) || !Array.isArray(body.ids) || body.ids.some((i) => typeof i !== 'string')) return fail(res, 400, 'bad-request', 'expected { store_id, ids }');
        return json(res, 200, { ok: true, collected: ackEdits(dir, token.name, body.store_id, body.ids.slice(0, 500), now()) });
      }
      if (p === '/v1/snapshot' && method === 'PUT') return push(req, res, token);
      const del = /^\/v1\/snapshot\/([^/]+)$/.exec(p);
      if (del && method === 'DELETE') {
        if (token.role !== 'member') return fail(res, 403, 'hub-role', 'removing a board needs a member token');
        if (!STORE_ID_RE.test(del[1])) return fail(res, 400, 'bad-request', 'invalid store id');
        const removed = removeBoard(dir, token.name, del[1]);
        boardPages.delete(`${token.name}/${del[1]}`);
        parsed.delete(`${token.name}/${del[1]}`);
        if (removed) log(`remove ${token.name}/${del[1]}`);
        return removed ? json(res, 200, { ok: true, removed: true }) : fail(res, 404, 'not-found', 'no such board of yours');
      }
      return fail(res, 404, 'not-found', 'not found');
    }

    const tm = /^\/b\/([^/]+)\/([^/]+)\/t\/([^/]+)$/.exec(p);
    const ticketRoute = tm && NAME_RE.test(tm[1]) && STORE_ID_RE.test(tm[2]) && TICKET_ID_RE.test(tm[3]);
    if (method !== 'GET' && !(method === 'POST' && ticketRoute)) return fail(res, 405, 'method-not-allowed', 'method not allowed', { Allow: 'GET' });
    const who = sessionToken(req);
    if (!who) return method === 'GET' ? redirect(res, '/login') : fail(res, 401, 'unauthorized', 'sign in first');
    if (ticketRoute) {
      if (method === 'POST') return proposeEdit(req, res, who, tm[1], tm[2], tm[3]);
      return ticketView(res, who, tm[1], tm[2], tm[3], { sent: url.searchParams.get('sent') === '1' ? 1 : 0 });
    }
    if (p === '/') return page(res, 200, overviewPage({ hubName: name, who, overview: teamOverview(boards(who), now()) }));
    const m = /^\/b\/([^/]+)\/([^/]+)(\/frame|\/)?$/.exec(p);
    if (m && NAME_RE.test(m[1]) && STORE_ID_RE.test(m[2])) {
      if (!m[3]) return redirect(res, `${p}/`);
      const entry = canSee(who, m[1]) ? boardPage(m[1], m[2]) : null;
      if (!entry) return page(res, 404, messagePage({ hubName: name, title: 'Board not found', message: 'No board is stored under that address. It may have been removed, or never pushed.' }));
      // The dashboard itself, shown only inside the hub's own board page.
      if (m[3] === '/frame') return send(res, 200, entry.html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': entry.csp, 'X-Frame-Options': 'SAMEORIGIN' });
      return page(res, 200, boardFramePage({ hubName: name, who, member: m[1], storeId: m[2], pushedAt: entry.pushed_at, now: now() }), { 'Content-Security-Policy': FRAME_PAGE_CSP });
    }
    return page(res, 404, messagePage({ hubName: name, title: 'Not found', message: 'This hub has no page at that address.' }));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`error ${req.method} ${String(req.url).slice(0, 200)}: ${err.stack ?? err.message}`);
      if (!res.headersSent) fail(res, 500, 'internal', 'the hub could not handle that request');
      else res.end();
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  return {
    server,
    listen: (port = DEFAULT_PORT, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
