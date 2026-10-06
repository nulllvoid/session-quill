import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli } from './helpers.js';
import { loadContext, latestSnapshot, workerStatus, effectiveDefaults } from '../../src/cli/context.js';
import { ensureReady, pausePath } from '../../src/runtime/readiness.js';
import { loadUserConfig } from '../../src/config/config.js';
import { runDir } from '../../src/lib/paths.js';
import { writeJsonAtomic } from '../../src/lib/atomic-fs.js';
import { isLocked } from '../../src/worker/lock.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-onboard-'));
  const repo = path.join(root, 'sample-app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', repo], { stdio: 'ignore', windowsHide: true });
  return { root, repo, env: { QUILL_HOME: path.join(root, 'private') } };
}
async function stop(fx) {
  if (loadUserConfig(fx.env).store_path) await cli(['worker', 'stop'], fx.env);
}

test('fresh enable privately registers the git root, captures this session, and is repeatable', async (t) => {
  const fx = fixture(); t.after(() => stop(fx));
  const sub = path.join(fx.repo, 'src'); fs.mkdirSync(sub);
  const r = await cli(['start', '--repo', sub, '--session', 'first-session'], fx.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /This session is now being captured/);
  const ctx = loadContext(fx.env);
  assert.equal(ctx.config.store_path, path.join(fx.env.QUILL_HOME, 'store'));
  assert.equal(fs.existsSync(path.join(fx.repo, '.quill.toml')), false);
  assert.equal(fs.existsSync(path.join(sub, '.quill.toml')), false);
  assert.equal(ctx.config.repos['sample-app'].canonical_path, fx.repo);
  assert.equal(ctx.config.gate.mode, 'nudge');
  const pid = workerStatus(ctx).pid;
  const again = await cli(['start', '--repo', fx.repo], fx.env);
  assert.equal(again.code, 0, again.err);
  assert.equal(workerStatus(ctx).pid, pid);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !latestSnapshot(ctx)?.sessions.some((s) => s.host_session_id === 'first-session')) await new Promise((r) => setTimeout(r, 100));
  assert.ok(latestSnapshot(ctx).sessions.some((s) => s.host_session_id === 'first-session'));
});

test('dashboard bootstraps a fresh home and an explicit stop stays paused until start', async (t) => {
  const fx = fixture(); t.after(() => stop(fx));
  const result = await cli(['ui', '--repo', fx.repo, '--no-open'], fx.env);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /http:\/\/127\.0\.0\.1:\d+\/auth\?secret=/);
  assert.equal((await cli(['worker', 'stop'], fx.env)).code, 0);
  const hook = await cli(['hook', 'SessionStart'], fx.env, { stdin: JSON.stringify({ session_id: 'paused-session', cwd: fx.repo }) });
  assert.equal(hook.code, 0);
  assert.match(hook.err, /paused/);
  const ctx = loadContext(fx.env);
  assert.equal(await isLocked(ctx.storeMeta.store_id, ctx.machineId, fx.env), false);
  assert.equal((await cli(['ui', '--no-open'], fx.env)).code, 1);
  assert.equal((await cli(['start', '--repo', fx.repo], fx.env)).code, 0);
  assert.equal(fs.existsSync(pausePath(fx.env)), false);
});

test('session startup recovers a missing worker without waiting for readiness; concurrent callers share it', async (t) => {
  const fx = fixture(); t.after(() => stop(fx));
  assert.equal((await cli(['start', '--repo', fx.repo], fx.env)).code, 0);
  await stop(fx);
  fs.rmSync(pausePath(fx.env));
  fs.rmSync(path.join(runDir(fx.env), 'worker-start-attempt.json'));
  fs.rmSync(path.join(fx.env.QUILL_HOME, 'state', 'control', 'stop.json'), { force: true });
  const hook = await cli(['hook', 'SessionStart'], fx.env, { stdin: JSON.stringify({ session_id: 'resumed-session', cwd: fx.repo }) });
  assert.equal(hook.code, 0, hook.err);
  const ctx = loadContext(fx.env);
  const results = await Promise.all([ensureReady(ctx), ensureReady(ctx), ensureReady(ctx)]);
  assert.ok(results.every((r) => r.state === 'ready'));
  assert.equal(await isLocked(ctx.storeMeta.store_id, ctx.machineId, fx.env), true);
});

test('recent failed launches are throttled, and another machine cannot start or reconfigure the store', async (t) => {
  const fx = fixture(); t.after(() => stop(fx));
  await cli(['start', '--repo', fx.repo], fx.env);
  await stop(fx);
  fs.rmSync(pausePath(fx.env));
  const ctx = loadContext(fx.env);
  writeJsonAtomic(path.join(runDir(fx.env), 'worker-start-attempt.json'), { store_id: ctx.storeMeta.store_id, at: Date.now() });
  await assert.rejects(ensureReady(ctx, { timeoutMs: 150 }), { code: 'worker-unavailable' });
  assert.equal(await isLocked(ctx.storeMeta.store_id, ctx.machineId, fx.env), false);
  const file = path.join(ctx.config.store_path, 'store.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ ...ctx.storeMeta, owner_machine_id: 'another-machine' }));
  const configBefore = fs.readFileSync(path.join(fx.env.QUILL_HOME, 'config.toml'), 'utf8');
  try {
    const r = await cli(['start', '--repo', fx.repo], fx.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /another machine/);
    assert.equal(fs.readFileSync(path.join(fx.env.QUILL_HOME, 'config.toml'), 'utf8'), configBefore);
  } finally { fs.writeFileSync(file, original); }
});

test('unconfigured hooks quietly expose the enable action without blocking normal tools', async () => {
  const fx = fixture();
  const start = await cli(['hook', 'SessionStart'], fx.env, { stdin: JSON.stringify({ session_id: 'new-session', cwd: fx.repo }) });
  assert.match(start.out, /Session Quill session: new-session/);
  assert.match(start.out, /session-quill:start/);
  const tool = await cli(['hook', 'PreToolUse'], fx.env, { stdin: JSON.stringify({ session_id: 'new-session', tool_name: 'Edit', cwd: fx.repo }) });
  assert.equal(tool.out, '');
  assert.equal(tool.err, '');
});

test('sharing settings is opt-in and existing strict policy survives enable', async (t) => {
  const fx = fixture(); t.after(() => stop(fx));
  fs.writeFileSync(path.join(fx.repo, '.quill.toml'), '[gate]\nmode = "strict"\n');
  const before = fs.readFileSync(path.join(fx.repo, '.quill.toml'), 'utf8');
  assert.equal((await cli(['start', '--repo', fx.repo], fx.env)).code, 0);
  assert.equal(fs.readFileSync(path.join(fx.repo, '.quill.toml'), 'utf8'), before);
  const hook = await cli(['hook', 'PreToolUse'], fx.env, { stdin: JSON.stringify({ session_id: 'strict-session', tool_name: 'Edit', cwd: fx.repo, tool_input: { file_path: 'x.js' } }) });
  assert.match(hook.out, /deny/);
  assert.equal((await cli(['start', '--repo', fx.repo, '--share-settings'], fx.env)).code, 0);
  const shared = fs.readFileSync(path.join(fx.repo, '.quill.toml'), 'utf8');
  assert.match(shared, /repo_id/);
  assert.match(shared, /strict/);
});


test('private registration supplies ticket defaults and concurrent enables keep both repositories', async (t) => {
  const fx = fixture(); t.after(() => stop(fx));
  const other = path.join(fx.root, 'other-app');
  fs.mkdirSync(other); execFileSync('git', ['init', other], { stdio: 'ignore', windowsHide: true });
  const results = await Promise.all([
    cli(['start', '--repo', fx.repo], fx.env),
    cli(['start', '--repo', other], fx.env),
  ]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const ctx = loadContext(fx.env);
  assert.equal(Object.keys(ctx.config.repos).length, 2);
  assert.equal(effectiveDefaults(ctx, path.join(other, 'src'), {}).project_id, 'other-app');
  assert.equal(effectiveDefaults(ctx, path.join(other, 'src'), {}).repo_id, 'other-app');
  assert.equal(effectiveDefaults(ctx, other, { project: 'override' }).project_id, 'override');
  assert.equal(fs.existsSync(path.join(other, '.quill.toml')), false);
});
