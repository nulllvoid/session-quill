import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHome, startWorker, cli, DESC } from '../cli/helpers.js';
import { loadUserConfig } from '../../src/config/config.js';
import { createHub } from '../../src/hub/server.js';
import { readBoard } from '../../src/hub/store.js';

test('token add shows the token once, list never does, revoke --purge removes the boards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-cli-'));
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-clihome-')) };
  const add = await cli(['hub', 'token', 'add', 'alice', '--dir', dir], env);
  assert.equal(add.code, 0, add.err);
  const token = /qh_m_[A-Za-z0-9_-]{43}/.exec(add.out)[0];
  assert.match(add.out, /shown once/);
  const viewer = await cli(['hub', 'token', 'add', 'vera', '--role', 'viewer', '--dir', dir], { ...env, QUILL_HUB_DIR: '/ignored' });
  assert.match(viewer.out, /qh_v_/);
  assert.match(viewer.out, /cannot push/);
  const list = await cli(['hub', 'token', 'list'], { ...env, QUILL_HUB_DIR: dir });
  assert.match(list.out, /alice\s+member/);
  assert.match(list.out, /vera\s+viewer/);
  assert.equal(list.out.includes(token), false);
  assert.equal(fs.existsSync(path.join(env.QUILL_HOME, 'machine.json')), false, 'hub administration needs no Quill store');
  const dup = await cli(['hub', 'token', 'add', 'alice', '--dir', dir], env);
  assert.notEqual(dup.code, 0);
  assert.match(dup.err, /already exists/);
  const noDir = await cli(['hub', 'token', 'list'], env);
  assert.notEqual(noDir.code, 0);
  assert.match(noDir.err, /--dir <folder>/);
  fs.mkdirSync(path.join(dir, 'boards', 'alice', 'store-1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'boards', 'alice', 'store-1', 'info.json'), '{}');
  const revoke = await cli(['hub', 'token', 'revoke', 'alice', '--dir', dir, '--purge'], env);
  assert.match(revoke.out, /Revoked alice \(member\).*Removed 1 board/);
  assert.equal(fs.existsSync(path.join(dir, 'boards', 'alice')), false);
  const once = await cli(['hub', 'serve', '--dir', dir, '--port', '0', '--once'], env);
  assert.equal(once.code, 0, once.err);
  assert.match(once.out, /listening on http:\/\/127\.0\.0\.1:\d+/);
});

test('join previews first, saves only with --confirm, then push, status and leave work end to end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-e2e-'));
  const hub = createHub({ dir, name: 'E2E' });
  const address = await hub.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const added = await cli(['hub', 'token', 'add', 'alice', '--dir', dir], fx.env);
    const env = { ...fx.env, QUILL_HUB_TOKEN: /qh_m_[A-Za-z0-9_-]{43}/.exec(added.out)[0] };
    await cli(['ticket', 'create', '--description', DESC, 'Shared work', '--session', 'sess-H'], env);
    w.worker.publishGeneration();

    const none = await cli(['hub', 'status'], env);
    assert.match(none.out, /No hub configured/);
    const early = await cli(['hub', 'push'], env);
    assert.notEqual(early.code, 0);
    assert.match(early.err, /no hub is configured/);

    const preview = await cli(['hub', 'join', base], env);
    assert.equal(preview.code, 0, preview.err);
    assert.match(preview.out, /Would push: 1 ticket\(s\)/);
    assert.match(preview.out, /Never pushed:/);
    assert.match(preview.out, /Nothing was changed and nothing was sent/);
    assert.equal(loadUserConfig(env).hub, undefined, 'a preview saves nothing');
    assert.equal(readBoard(dir, 'alice', fx.meta.store_id), null, 'a preview sends nothing');

    const insecure = await cli(['hub', 'join', 'http://quill.example.org', '--confirm'], env);
    assert.notEqual(insecure.code, 0);
    assert.match(insecure.err, /must use https/);
    const tokenAsName = await cli(['hub', 'join', base, '--token-env', 'qh_m_not-a-name!'], env);
    assert.notEqual(tokenAsName.code, 0);
    assert.match(tokenAsName.err, /name of an environment variable/);

    const joined = await cli(['hub', 'join', base, '--confirm'], env);
    assert.equal(joined.code, 0, joined.err);
    assert.match(joined.out, /answered as a Session Quill hub/);
    const saved = loadUserConfig(env).hub;
    assert.deepEqual(saved, { url: base, enabled: true, confirmed_url: base });
    assert.equal(fs.readFileSync(path.join(fx.home, 'config.toml'), 'utf8').includes(env.QUILL_HUB_TOKEN), false, 'the token is never written to config');

    const pushed = await cli(['hub', 'push'], env);
    assert.equal(pushed.code, 0, pushed.err);
    assert.match(pushed.out, /Pushed 1 ticket\(s\), generation gen-\d+, to .* as alice/);
    const board = readBoard(dir, 'alice', fx.meta.store_id);
    assert.equal(board.snapshot.tickets[0].title, 'Shared work');
    assert.equal(board.info.machine_name, fx.config.machine_name);

    const status = JSON.parse((await cli(['hub', 'status', '--json'], env)).out);
    assert.equal(status.enabled, true);
    assert.equal(status.shareable_tickets, 1);
    assert.ok(status.last_success_at);
    assert.equal(status.last_error, null);
    assert.equal(JSON.stringify(status).includes(env.QUILL_HUB_TOKEN), false);

    const inRun = await cli(['hub', 'push'], { ...env, QUILL_HANDOFF_ID: 'run-1' });
    assert.equal(inRun.code, 2, 'an agent run cannot push the board');

    const other = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-other-')), QUILL_HUB_TOKEN: env.QUILL_HUB_TOKEN };
    const stranger = await cli(['hub', 'join', base, '--confirm'], other);
    assert.notEqual(stranger.code, 0, 'a machine without a store cannot join');

    const left = await cli(['hub', 'leave', '--remove'], env);
    assert.equal(left.code, 0, left.err);
    assert.match(left.out, /Stopped pushing.*Your board was removed from the hub/);
    assert.equal(readBoard(dir, 'alice', fx.meta.store_id), null);
    assert.deepEqual(loadUserConfig(env).hub, { url: base, enabled: false });
    const after = await cli(['hub', 'push'], env);
    assert.notEqual(after.code, 0);
    assert.match(after.err, /has not been confirmed/);
  } finally {
    await w.stop();
    await hub.close();
  }
});
