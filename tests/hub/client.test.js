import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHubUrl, hubSettings, buildPayload, pushSnapshot, pingHub, createExtension, readHubState } from '../../src/hub/client.js';
import { loadRepoConfig } from '../../src/config/config.js';
import { hubCheck } from '../../src/cli/commands/doctor.js';
import { startHub, rawSnapshot, ticket, NOW } from './helpers.js';

const cfg = (hub) => ({ machine_name: 'laptop', hub });

test('a hub address must be https, except on localhost or by an explicit choice', () => {
  assert.equal(normalizeHubUrl('https://quill.example.org/').url, 'https://quill.example.org');
  assert.equal(normalizeHubUrl('https://example.org/quill/').url, 'https://example.org/quill');
  assert.equal(normalizeHubUrl('http://127.0.0.1:47400').url, 'http://127.0.0.1:47400');
  assert.equal(normalizeHubUrl('http://localhost:47400').url, 'http://localhost:47400');
  assert.match(normalizeHubUrl('http://quill.example.org').problem, /must use https/);
  assert.equal(normalizeHubUrl('http://10.0.0.5:47400', { allowHttp: true }).url, 'http://10.0.0.5:47400');
  assert.match(normalizeHubUrl('https://user:pw@example.org').problem, /user name or password/);
  assert.match(normalizeHubUrl('https://example.org/?x=1').problem, /query or fragment/);
  assert.match(normalizeHubUrl('ftp://example.org').problem, /https/);
  assert.match(normalizeHubUrl('not a url').problem, /not a URL/);
  assert.match(normalizeHubUrl(undefined).problem, /no hub address/);
});

test('pushing needs a confirmed address, the switch and a token from the environment', () => {
  const url = 'https://quill.example.org';
  const env = { QUILL_HUB_TOKEN: 'qh_m_x' };
  assert.equal(hubSettings({}, env).enabled, false);
  assert.equal(hubSettings({}, env).configured, false);
  assert.equal(hubSettings(cfg({ url, enabled: true }), env).enabled, false, 'not confirmed');
  assert.match(hubSettings(cfg({ url, enabled: true }), env).problems.join(), /has not been confirmed/);
  assert.equal(hubSettings(cfg({ url, enabled: true, confirmed_url: 'https://other.example.org' }), env).enabled, false, 'confirmed for another address');
  assert.equal(hubSettings(cfg({ url, enabled: true, confirmed_url: url }), {}).enabled, false, 'no token');
  assert.match(hubSettings(cfg({ url, enabled: true, confirmed_url: url }), {}).problems.join(), /QUILL_HUB_TOKEN/);
  assert.equal(hubSettings(cfg({ url, confirmed_url: url }), env).enabled, false, 'not switched on');
  const on = hubSettings(cfg({ url, enabled: true, confirmed_url: url, interval_seconds: 5, projects: ['a'], fields: ['key', 'bogus', 'title'], token_env: 'MY_HUB' }), { MY_HUB: ' qh_m_y ' });
  assert.equal(on.enabled, true);
  assert.equal(on.token, 'qh_m_y');
  assert.equal(on.interval_ms, 60_000, 'floor of one minute');
  assert.deepEqual(on.projects, ['a']);
  assert.deepEqual(on.fields, ['key', 'title']);
  assert.equal(hubSettings(cfg({ url, token_env: 'not a name' }), env).token_env, 'QUILL_HUB_TOKEN');
});

test('a repository config cannot set or change the hub', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-repo-'));
  fs.writeFileSync(path.join(dir, '.quill.toml'), '[hub]\nurl = "https://evil.example"\nenabled = true\nconfirmed_url = "https://evil.example"\n\n[gate]\nmode = "strict"\n');
  const repo = loadRepoConfig(dir);
  assert.equal('hub' in repo, false);
  assert.deepEqual(repo.gate, { mode: 'strict' });
});

test('the payload is the export sanitizer\'s output: read-only, no checkpoints, project filter applied', () => {
  const snap = rawSnapshot({ tickets: [ticket(1), ticket(2, { project_id: 'other' }), ticket(3, { local_only: true })], extra: { checkpoints: [{ id: 'c', preview: 'plan text' }] } });
  const settings = hubSettings(cfg({ url: 'https://h.example', enabled: true, confirmed_url: 'https://h.example', projects: ['demo'] }), { QUILL_HUB_TOKEN: 't' });
  const p = buildPayload(snap, settings, { now: NOW, storeId: 'store-1', machineName: 'laptop' });
  assert.deepEqual(p.snapshot.tickets.map((t) => t.key), ['PROJ-1']);
  assert.deepEqual(p.snapshot.checkpoints, []);
  assert.equal(p.snapshot.capabilities.edit_tickets, false);
  assert.equal(p.snapshot.export.include_checkpoints, false);
  assert.equal(p.store_id, 'store-1');
});

test('a push reaches the hub and is recorded; failures name the cause and never the token', async () => {
  const h = await startHub();
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-home-')) };
  try {
    const settings = (token) => hubSettings(cfg({ url: h.base, enabled: true, confirmed_url: h.base }), { QUILL_HUB_TOKEN: token });
    assert.equal((await pingHub(settings(null))).service, 'quill-hub');
    const ok = await pushSnapshot(rawSnapshot(), settings(h.member.token), { now: NOW, storeId: 'store-1', machineName: 'laptop', env });
    assert.equal(ok.member, 'alice');
    assert.equal(ok.ticket_count, 2);
    assert.deepEqual(readHubState(env), { url: h.base, last_attempt_at: NOW, last_success_at: NOW, last_error: null, generation_id: 'gen-00000007', ticket_count: 2 });
    await assert.rejects(pushSnapshot(rawSnapshot(), settings(h.viewer.token), { now: NOW, storeId: 'store-1', env }), (err) => err.code === 'hub-forbidden' && /member token/.test(err.message));
    const bad = 'qh_m_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    await assert.rejects(pushSnapshot(rawSnapshot(), settings(bad), { now: NOW, storeId: 'store-1', env }), (err) => err.code === 'hub-unauthorized' && !err.message.includes(bad));
    const state = readHubState(env);
    assert.equal(state.last_error.code, 'hub-unauthorized');
    assert.equal(state.last_success_at, NOW, 'the last accepted push is still recorded');
    assert.equal(JSON.stringify(state).includes(bad), false);
    await assert.rejects(pushSnapshot(rawSnapshot(), settings(null), { now: NOW, storeId: 'store-1', env }), (err) => err.code === 'hub-no-token');
  } finally { await h.close(); }
  const gone = hubSettings(cfg({ url: h.base, enabled: true, confirmed_url: h.base }), { QUILL_HUB_TOKEN: 't' });
  await assert.rejects(pushSnapshot(rawSnapshot(), gone, { now: NOW, storeId: 'store-1', env }), (err) => err.code === 'hub-unreachable');
});

test('a redirect is refused, so the token cannot follow it to another host', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, redirect: init.redirect, auth: init.headers.Authorization }); return new Response(JSON.stringify({ ok: true, member: 'a' }), { status: 200 }); };
  const settings = hubSettings(cfg({ url: 'https://h.example', enabled: true, confirmed_url: 'https://h.example' }), { QUILL_HUB_TOKEN: 'tok' });
  await pushSnapshot(rawSnapshot(), settings, { now: NOW, storeId: 's', fetchImpl });
  assert.deepEqual(seen, [{ url: 'https://h.example/v1/snapshot', redirect: 'error', auth: 'Bearer tok' }]);
});

function fakeWorker(config, env) {
  const w = { config, env, lastSnapshot: null, ms: Date.parse(NOW), logs: [], clock: () => w.ms, now: () => new Date(w.ms).toISOString().replace('.000Z', 'Z'), log: (m) => w.logs.push(m) };
  return w;
}

test('the worker pushes each new generation once, at most once per interval, and again on stop', async () => {
  const calls = [];
  let failNext = false;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.snapshot.generation_id);
    if (failNext) { failNext = false; return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 }); }
    return new Response(JSON.stringify({ ok: true, member: 'alice' }), { status: 200 });
  };
  const url = 'https://h.example';
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-w-')), QUILL_HUB_TOKEN: 'tok' };
  const w = fakeWorker(cfg({ url, enabled: true, confirmed_url: url, interval_seconds: 60 }), env);
  const ext = createExtension({ storeMeta: { store_id: 'store-1' }, env }, { fetchImpl });
  ext.tick(w);
  assert.deepEqual(calls, [], 'nothing to push before the first generation');
  w.lastSnapshot = rawSnapshot();
  ext.tick(w);
  await ext.pending;
  assert.deepEqual(calls, ['gen-00000007']);
  w.ms += 120_000;
  ext.tick(w);
  assert.deepEqual(calls, ['gen-00000007'], 'the same generation is not pushed twice');
  w.lastSnapshot = { ...rawSnapshot(), generation_id: 'gen-00000008' };
  w.ms += 1000;
  ext.tick(w);
  await ext.pending;
  assert.deepEqual(calls, ['gen-00000007', 'gen-00000008']);
  w.lastSnapshot = { ...rawSnapshot(), generation_id: 'gen-00000009' };
  w.ms += 10_000;
  ext.tick(w);
  assert.deepEqual(calls.length, 2, 'inside the interval: wait');
  failNext = true;
  w.ms += 60_000;
  ext.tick(w);
  await ext.pending;
  assert.match(w.logs.at(-1), /hub push \(tick\) failed: the hub answered 503: down/);
  w.ms += 60_000;
  ext.tick(w);
  await ext.pending;
  assert.deepEqual(calls.slice(2), ['gen-00000009', 'gen-00000009'], 'a failed push is retried after the interval');
  w.lastSnapshot = { ...rawSnapshot(), generation_id: 'gen-00000010' };
  await ext.onStop(w);
  assert.equal(calls.at(-1), 'gen-00000010', 'the hub copy ends current');
});

test('the worker says once why it is not pushing, and never sends without a token', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); return new Response('{}', { status: 200 }); };
  const url = 'https://h.example';
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-w2-')) };
  const w = fakeWorker(cfg({ url, enabled: true, confirmed_url: url }), env);
  w.lastSnapshot = rawSnapshot();
  const ext = createExtension({ storeMeta: { store_id: 'store-1' }, env }, { fetchImpl });
  ext.tick(w); ext.tick(w); ext.tick(w);
  assert.deepEqual(calls, []);
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /not pushing: no token: set the QUILL_HUB_TOKEN/);
  const off = fakeWorker(cfg({ url }), env);
  off.lastSnapshot = rawSnapshot();
  ext.tick(off);
  assert.deepEqual(off.logs, [], 'a hub that is not switched on is silent');
});

test('doctor reports the hub only when one is configured, and never fails on it', () => {
  const url = 'https://h.example';
  const on = (extra = {}, env = { QUILL_HUB_TOKEN: 'secret-token' }) => hubSettings(cfg({ url, enabled: true, confirmed_url: url, ...extra }), env);
  assert.equal(hubCheck(hubSettings({}, {}), null), null);
  assert.deepEqual(hubCheck(hubSettings(cfg({ url }), {}), null), { level: 'ok', detail: `${url}: pushing is off (quill hub join <url> --confirm switches it on)` });
  assert.match(hubCheck(on({}, {}), null).detail, /not pushing: no token: set the QUILL_HUB_TOKEN/);
  assert.equal(hubCheck(on({}, {}), null).level, 'warn');
  assert.match(hubCheck(on(), null).detail, /no push recorded yet/);
  assert.deepEqual(hubCheck(on({ accept_edits: true }), { url, last_success_at: NOW, last_error: null }), { level: 'ok', detail: `${url}: last push accepted ${NOW}; edits from the hub accepted` });
  const failed = hubCheck(on(), { url, last_attempt_at: NOW, last_success_at: '2026-11-09T00:00:00Z', last_error: { code: 'hub-unreachable', message: 'could not reach the hub' } });
  assert.equal(failed.level, 'warn');
  assert.match(failed.detail, /failed: could not reach the hub; last accepted 2026-11-09/);
  assert.match(hubCheck(on(), { url: 'https://old.example', last_success_at: NOW }).detail, /no push recorded yet/, 'state for another hub is ignored');
  assert.equal(JSON.stringify([hubCheck(on(), null), failed]).includes('secret-token'), false);
});

test('the worker collects edits once a minute, only when the owner accepts them', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'GET') return new Response(JSON.stringify({ edits: [] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, member: 'alice' }), { status: 200 });
  };
  const url = 'https://h.example';
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-w3-')), QUILL_HUB_TOKEN: 'tok' };
  const ctx = { storeMeta: { store_id: 'store-1' }, machineId: 'm1', env };
  const off = fakeWorker(cfg({ url, enabled: true, confirmed_url: url }), env);
  const extOff = createExtension(ctx, { fetchImpl });
  extOff.tick(off);
  await extOff.collecting;
  assert.deepEqual(calls, [], 'accept_edits is off by default: the hub is never asked for edits');
  const w = fakeWorker(cfg({ url, enabled: true, confirmed_url: url, accept_edits: true }), env);
  const ext = createExtension(ctx, { fetchImpl });
  ext.tick(w);
  await ext.collecting;
  ext.tick(w);
  w.ms += 30_000;
  ext.tick(w);
  assert.deepEqual(calls, ['GET /v1/edits']);
  w.ms += 31_000;
  ext.tick(w);
  await ext.collecting;
  assert.deepEqual(calls, ['GET /v1/edits', 'GET /v1/edits']);
});
