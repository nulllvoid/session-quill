import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../../src/config/config.js';
import { createExtension as serverExt, endpointPath, secretsDir, revokePath, sessionsPath } from '../../src/server/extension.js';
import { revokeSessions, issueOwnerUrl } from '../../src/cli/commands/ui.js';
import { loadContext } from '../../src/cli/context.js';
import { hashSecret } from '../../src/server/auth.js';
import { cli } from '../cli/helpers.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';

function home(uiPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-endpoint-'));
  const storePath = path.join(dir, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, ui_port: uiPort };
  const env = { QUILL_HOME: dir };
  return { env, config, meta };
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function boot(h) {
  const w = new Worker({ config: h.config, storeMeta: h.meta, env: h.env });
  const sext = serverExt({ env: h.env, config: h.config, storeMeta: h.meta });
  w.use(sext);
  await w.start();
  return { w, sext };
}

test('the server takes the configured port when it is free and records it in ui-endpoint.json', async () => {
  const port = await freePort();
  const h = home(port);
  const { w, sext } = await boot(h);
  try {
    assert.equal(sext.address().port, port);
    const ep = JSON.parse(fs.readFileSync(endpointPath(h.env), 'utf8'));
    assert.equal(ep.port, port);
    assert.equal(ep.host, '127.0.0.1');
    assert.equal(ep.pid, process.pid);
    assert.equal(ep.configured_port, undefined, 'no fallback, nothing to warn about');
  } finally { await w.stop(); }
});

test('a taken port falls back to a random one instead of failing the worker', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const h = home(taken);
  const { w, sext } = await boot(h);
  try {
    const port = sext.address().port;
    assert.notEqual(port, taken);
    assert.ok(port > 0);
    const ep = JSON.parse(fs.readFileSync(endpointPath(h.env), 'utf8'));
    assert.equal(ep.port, port);
    assert.equal(ep.configured_port, taken, 'the fallback is recorded so quill ui and the status line can say so');
  } finally {
    await w.stop();
    await new Promise((r) => blocker.close(r));
  }
});

async function signIn(sext) {
  const secret = 'f'.repeat(64);
  sext.acceptSecretHash(hashSecret(secret), Date.now() + 600_000);
  const res = await fetch(`http://127.0.0.1:${sext.address().port}/auth?secret=${secret}`, { redirect: 'manual' });
  return res.headers.get('set-cookie').split(';')[0];
}

function cliHome(h) {
  saveUserConfig(h.config, h.env);
  fs.writeFileSync(path.join(h.env.QUILL_HOME, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'test' }));
}

test('a signed-in browser stays signed in across a worker restart, and quill ui --revoke signs it out', async () => {
  const h = home(0);
  cliHome(h);
  let { w, sext } = await boot(h);
  let cookie;
  try { cookie = await signIn(sext); } finally { await w.stop(); }
  ({ w, sext } = await boot(h));
  const timer = setInterval(() => { try { w.tick(); } catch { /* ignore */ } }, 20);
  try {
    const base = `http://127.0.0.1:${sext.address().port}`;
    assert.equal((await fetch(`${base}/v1/snapshot`, { headers: { cookie } })).status, 200, 'still signed in after the restart');
    const r = await cli(['ui', '--revoke'], h.env);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /signed out/i);
    assert.equal((await fetch(`${base}/v1/snapshot`, { headers: { cookie } })).status, 401);
  } finally { clearInterval(timer); await w.stop(); }
});

test('quill ui --revoke without a running worker clears stored sessions and pending secrets', async () => {
  const h = home(0);
  cliHome(h);
  const { w, sext } = await boot(h);
  let cookie;
  try { cookie = await signIn(sext); } finally { await w.stop(); }
  fs.mkdirSync(secretsDir(h.env), { recursive: true });
  fs.writeFileSync(path.join(secretsDir(h.env), 'abc.json'), JSON.stringify({ hash: hashSecret('x'), expires_at: '2999-01-01T00:00:00Z' }));
  const r = await cli(['ui', '--revoke'], h.env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /next start/i);
  assert.deepEqual(fs.readdirSync(secretsDir(h.env)), []);
  assert.ok(fs.existsSync(revokePath(h.env)), 'the sign-out waits for the next worker start');
  const again = await boot(h);
  try {
    assert.equal(fs.existsSync(revokePath(h.env)), false, 'applied at start');
    assert.equal((await fetch(`http://127.0.0.1:${again.sext.address().port}/v1/snapshot`, { headers: { cookie } })).status, 401);
  } finally { await again.w.stop(); }
});

test('a worker that does not confirm the revoke in time keeps the marker and never serves the revoked session', async () => {
  const h = home(0);
  cliHome(h);
  const { w, sext } = await boot(h);
  try {
    const cookie = await signIn(sext);
    // The worker is up but not ticking, so it cannot confirm.
    const result = await revokeSessions(loadContext(h.env), { timeoutMs: 200 });
    assert.equal(result.confirmed, false);
    assert.ok(fs.existsSync(revokePath(h.env)), 'left for the worker to apply');
    assert.equal((await fetch(`http://127.0.0.1:${sext.address().port}/v1/snapshot`, { headers: { cookie } })).status, 401);
    assert.equal(fs.existsSync(sessionsPath(h.env)) ? JSON.parse(fs.readFileSync(sessionsPath(h.env), 'utf8')).sessions.length : 0, 0);
    w.tick();
    assert.equal(fs.existsSync(revokePath(h.env)), false);
  } finally { await w.stop(); }
});

test('quill ui says when the configured port was taken and which one serves instead', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const h = home(taken);
  cliHome(h);
  const { w, sext } = await boot(h);
  const timer = setInterval(() => { try { w.tick(); } catch { /* ignore */ } }, 20);
  try {
    const { base, fallback } = await issueOwnerUrl(loadContext(h.env));
    assert.equal(base, `http://127.0.0.1:${sext.address().port}/`);
    assert.equal(fallback, `port ${taken} taken; using ${sext.address().port}`);
  } finally {
    clearInterval(timer);
    await w.stop();
    await new Promise((r) => blocker.close(r));
  }
});
