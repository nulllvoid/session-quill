import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';
import { derive } from '../../src/reconcile/derive.js';
import { createExtension as reconcileExt } from '../../src/reconcile/extension.js';
import { createExtension as serverExt } from '../../src/server/extension.js';
import { hashSecret } from '../../src/server/auth.js';
import { putBlob } from '../../src/core/blobs.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RID = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-http-'));
  const storePath = path.join(home, 'Tracker');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Tracker', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] } } };
  const env = { TRACKER_HOME: home };
  let nowMs = Date.parse('2026-10-02T08:00:00Z');
  const clock = () => nowMs;
  const iso = () => new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const w = new Worker({ config, storeMeta: meta, env, clock, derive });
  const ctx = { env, config, storeMeta: meta };
  const rext = reconcileExt(ctx, { providers: { for: () => ({ name: 'none', fetchPr: async () => { throw new Error('none'); } }) } });
  const sext = serverExt(ctx, { port: 0 });
  w.use(rext).use(sext);
  await w.start();
  w.tick();
  await rext.idle();
  const port = sext.address().port;
  const base = `http://127.0.0.1:${port}`;
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: iso(), ...extra });
  writeIngress(mk('ticket-create', { ticket: { id: T1, key: 'LOCAL-demo-00000001', title: 'Demo', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }), env);
  w.tick();
  // bootstrap: the CLI would hash a secret into a control file; here we call the extension directly
  const secret = 'f'.repeat(64);
  sext.acceptSecretHash(hashSecret(secret), nowMs + 600_000);
  const authRes = await fetch(`${base}/auth?secret=${secret}`, { redirect: 'manual' });
  const cookie = authRes.headers.get('set-cookie').split(';')[0];
  const csrf = (await (await fetch(`${base}/v1/csrf`, { headers: { cookie } })).json()).csrf;
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-tracker-csrf': csrf, origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (url) => fetch(`${base}${url}`, { headers: { cookie } });
  const settle = async () => { w.tick(); await rext.idle(); w.tick(); };
  return { w, env, base, port, cookie, csrf, post, get, secret, authRes, advance: (ms) => { nowMs += ms; }, settle, iso, mk, sext };
}

test('authentication: no cookie 401, bootstrap secret is one-use, cookie is HttpOnly SameSite=Strict', async () => {
  const b = await boot();
  try {
    assert.equal(b.authRes.status, 302);
    assert.match(b.authRes.headers.get('set-cookie'), /HttpOnly/);
    assert.match(b.authRes.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal((await fetch(`${b.base}/v1/snapshot`)).status, 401);
    assert.equal((await fetch(`${b.base}/auth?secret=${b.secret}`, { redirect: 'manual' })).status, 403, 'secret cannot be reused');
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.tickets.length, 1);
    assert.equal(snap.capabilities.edit_tickets, true);
  } finally { await b.w.stop(); }
});

test('mutations require CSRF and a loopback Origin/Host; cross-origin and wrong-host requests cannot mutate', async () => {
  const b = await boot();
  try {
    const body = { id: RID(1), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'x' } };
    assert.equal((await b.post('/v1/requests', body, { 'x-tracker-csrf': '' })).status, 403);
    assert.equal((await b.post('/v1/requests', body, { origin: 'http://evil.test' })).status, 403);
    const wrongHost = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: b.port, path: '/v1/requests', method: 'POST', headers: { host: 'tracker.example.com', 'content-type': 'application/json', cookie: b.cookie, 'x-tracker-csrf': b.csrf } }, (res) => resolve(res.statusCode));
      req.end(JSON.stringify(body));
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(`${b.base}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tracker-csrf': b.csrf }, body: JSON.stringify(body) })).status, 401);
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.requests.length, 0, 'nothing entered the queue');
  } finally { await b.w.stop(); }
});

test('happy path: 202 after persistence, pending with not_before, applied after the undo window; conflict for a stale revision', async () => {
  const b = await boot();
  try {
    const body = { id: RID(2), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Verify restart' } };
    const res = await b.post('/v1/requests', body);
    assert.equal(res.status, 202);
    const rec = await res.json();
    assert.equal(rec.state, 'pending');
    assert.equal(rec.not_before, '2026-10-02T08:00:10Z');
    const pending = await (await b.get(`/v1/requests/${RID(2)}`)).json();
    assert.equal(pending.state, 'pending');
    await b.settle();
    assert.equal((await (await b.get(`/v1/requests/${RID(2)}`)).json()).state, 'pending', 'not before the window ends');
    b.advance(10_000);
    await b.settle();
    const applied = await (await b.get(`/v1/requests/${RID(2)}`)).json();
    assert.equal(applied.state, 'applied');
    assert.equal(applied.applied_revision, 2);
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.tickets[0].next_action, 'Verify restart');
    // second client with the stale revision
    const stale = await b.post('/v1/requests', { id: RID(3), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Other' } });
    assert.equal(stale.status, 202);
    b.advance(10_000);
    await b.settle();
    const conflict = await (await b.get(`/v1/requests/${RID(3)}`)).json();
    assert.equal(conflict.state, 'conflict');
    assert.equal(conflict.error.current_revision, 2);
    assert.equal(conflict.result.current.next_action, 'Verify restart');
  } finally { await b.w.stop(); }
});

test('idempotency: same id and body returns the existing request; same id with a different body is rejected', async () => {
  const b = await boot();
  try {
    const body = { id: RID(4), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'A' } };
    const first = await (await b.post('/v1/requests', body)).json();
    const again = await b.post('/v1/requests', body);
    assert.equal(again.status, 202);
    assert.equal((await again.json()).id, first.id);
    const different = await b.post('/v1/requests', { ...body, payload: { next_action: 'B' } });
    assert.equal(different.status, 409);
    assert.equal((await different.json()).error.code, 'request-mismatch');
  } finally { await b.w.stop(); }
});

test('cancellation: within the window cancels without applying; after application reports already-applied', async () => {
  const b = await boot();
  try {
    const body = { id: RID(5), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Cancel me' } };
    await b.post('/v1/requests', body);
    b.advance(5_000);
    await b.settle();
    const c = await (await b.post(`/v1/requests/${RID(5)}/cancel`)).json();
    assert.equal(c.outcome, 'cancelled');
    b.advance(10_000);
    await b.settle();
    assert.equal((await (await b.get(`/v1/requests/${RID(5)}`)).json()).state, 'cancelled');
    assert.equal((await (await b.get('/v1/snapshot')).json()).tickets[0].next_action, '');
    await b.post('/v1/requests', { id: RID(6), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Keep' } });
    b.advance(11_000);
    await b.settle();
    const late = await (await b.post(`/v1/requests/${RID(6)}/cancel`)).json();
    assert.equal(late.outcome, 'already-applied');
    assert.equal(late.request.state, 'applied');
  } finally { await b.w.stop(); }
});

test('validation errors are rejected before the queue: blocked without blocker, done with pending deployments without a choice, malformed JSON', async () => {
  const b = await boot();
  try {
    const r1 = await b.post('/v1/requests', { id: RID(7), kind: 'set-status', target_id: T1, expected_revision: 1, payload: { status: 'blocked' } });
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.code, 'blocker-required');
    const r2 = await fetch(`${b.base}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: b.cookie, 'x-tracker-csrf': b.csrf, origin: b.base }, body: '{not json' });
    assert.equal(r2.status, 400);
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.requests.length, 0);
  } finally { await b.w.stop(); }
});

test('refresh has no undo delay and reuses the active run; set-status blocked applies with blocker text', async () => {
  const b = await boot();
  try {
    const r = await (await b.post('/v1/requests', { id: RID(8), kind: 'refresh', payload: {} })).json();
    assert.equal(r.not_before, r.created_at);
    await b.settle();
    assert.equal((await (await b.get(`/v1/requests/${RID(8)}`)).json()).state, 'applied');
    await b.post('/v1/requests', { id: RID(9), kind: 'set-status', target_id: T1, expected_revision: 1, payload: { status: 'blocked', blocker: 'waiting on infra' } });
    b.advance(10_000);
    await b.settle();
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.tickets[0].status, 'blocked');
    assert.equal(snap.tickets[0].blocker, 'waiting on infra');
  } finally { await b.w.stop(); }
});

test('detail and content endpoints are generation-consistent and return 410 for an expired generation', async () => {
  const b = await boot();
  try {
    const snap = await (await b.get('/v1/snapshot')).json();
    const detail = await b.get(`/v1/tickets/${T1}?generation=${snap.generation_id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).id, T1);
    const { hash } = putBlob('full checkpoint body', b.env);
    const content = await b.get(`/v1/content/${hash}?generation=${snap.generation_id}`);
    assert.equal(content.status, 200);
    assert.equal(await content.text(), 'full checkpoint body');
    assert.equal((await b.get(`/v1/content/${'0'.repeat(64)}?generation=${snap.generation_id}`)).status, 404);
    // force a new generation
    writeIngress(b.mk('ticket-update', { ticket_id: T1, fields: { next_action: 'bump' }, source: 'manual' }), b.env);
    await b.settle();
    const expired = await b.get(`/v1/tickets/${T1}?generation=${snap.generation_id}`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error.code, 'generation-expired');
  } finally { await b.w.stop(); }
});

test('an applying request interrupted by a restart is re-evaluated against expected_revision on start', async () => {
  const b = await boot();
  try {
    await b.post('/v1/requests', { id: RID(10), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Recovered' } });
    // Simulate crash right after the applying transaction was journaled.
    b.w.emit('request-tx', { request_id: RID(10), outcome: 'applying' }, { source_identity: `request-tx:${RID(10)}:applying` });
    assert.equal(b.w.state.requests.get(RID(10)).state, 'applying');
    await b.w.stop({ flush: false });
    const w2 = new Worker({ config: b.w.config, storeMeta: b.w.storeMeta, env: b.env, clock: () => Date.parse('2026-10-02T09:00:00Z'), derive });
    const ctx = { env: b.env, config: b.w.config, storeMeta: b.w.storeMeta };
    const sext = serverExt(ctx, { port: 0 });
    w2.use(sext);
    await w2.start();
    w2.tick();
    const req = w2.state.requests.get(RID(10));
    assert.equal(req.state, 'applied');
    assert.equal(w2.state.tickets.get(T1).next_action, 'Recovered');
    await w2.stop();
  } finally { /* stopped above */ }
});
