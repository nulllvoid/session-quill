// Planned files on the run side (ADR 0037): a request's planned_paths are validated, frozen into the
// grant as plannedPaths, and the guard marks allowed writes outside them `drift: true` in the ledger.
// Narrow, never widen (Review Focus 5): planned files never change a decision.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { writeGrant } from '../../src/handoff/grant.js';
import { readLedger } from '../../src/handoff/stream.js';
import { countRunDrift } from '../../src/core/planned-paths.js';
import { handoffRunDir } from '../../src/lib/paths.js';
import { runOptions } from '../../src/cli/commands/handoff.js';
import { parseArgs } from '../../src/cli/context.js';
import { checkout, runDir, outside, tmp, EDIT, FULL, grantWith, bash, call, run } from './guard-fixture.js';
import { bootWorker, makeRepo, until, T1 } from '../handoff/helpers.js';

const REPO = { id: 'demo', default_branch: 'main' };
const FIX = { mode: 'attempt-fix', permissions: { read_source: true, edit_source: true } };
const code = (fn) => { try { fn(); return null; } catch (err) { return err.code; } };

test('a request\'s planned_paths are repo-relative paths or globs, for a guarded run that may edit source', () => {
  const ok = validateHandoffRequest({ ...FIX, access: 'autonomous', planned_paths: ['src\\a.js', './src/core/**', 'src/a.js'] }, { repo: REPO });
  assert.deepEqual(ok.planned_paths, ['src/a.js', 'src/core/**']);
  assert.deepEqual(validateHandoffRequest({ ...FIX, access: 'full', planned_paths: ['README.md'] }, { repo: REPO }).planned_paths, ['README.md']);
  assert.equal('planned_paths' in validateHandoffRequest({ ...FIX, access: 'autonomous' }, { repo: REPO }), false);
  assert.equal('planned_paths' in validateHandoffRequest({ ...FIX, access: 'autonomous', planned_paths: [] }, { repo: REPO }), false);
  for (const bad of [['/etc/hosts'], ['C:\\x.js'], ['../up.js'], ['https://x/y.js'], ['~/.ssh/config'], [7], 'src/a.js', Array.from({ length: 51 }, (_, i) => `f${i}.js`)]) {
    assert.equal(code(() => validateHandoffRequest({ ...FIX, access: 'autonomous', planned_paths: bad }, { repo: REPO })), 'planned-invalid', JSON.stringify(bad));
  }
  for (const access of ['standard', 'settings']) assert.equal(code(() => validateHandoffRequest({ ...FIX, access, planned_paths: ['src/a.js'] }, { repo: REPO })), 'planned-needs-guard', access);
  assert.equal(code(() => validateHandoffRequest({ mode: 'analyse', permissions: { read_source: true }, access: 'autonomous', planned_paths: ['src/a.js'] }, { repo: REPO })), 'permission-dependency');
});

test('quill agent run|handoff --planned repeats or takes a comma list', () => {
  const { flags } = parseArgs(['--planned', 'src/a.js,src/b.js', '--planned', 'docs/**']);
  assert.deepEqual(runOptions(flags).planned_paths, ['src/a.js', 'src/b.js', 'docs/**']);
  assert.equal('planned_paths' in runOptions(parseArgs([]).flags), false);
  assert.equal(code(() => runOptions(parseArgs(['--planned']).flags)), 'usage');
});

// Review Focus 5: the same call gets the same decision and reason with or without planned files.
test('planned files never change a guard decision', () => {
  const planned = { plannedPaths: ['src/app.js'] };
  const calls = [
    call('Write', { file_path: path.join(checkout, 'src', 'app.js'), content: 'x' }),
    call('Write', { file_path: path.join(checkout, 'src', 'other.js'), content: 'x' }),
    call('Edit', { file_path: path.join(checkout, '.git', 'config'), old_string: 'a', new_string: 'b' }),
    call('Write', { file_path: path.join(outside, 'secret.txt'), content: 'x' }),
    call('Write', { file_path: path.join(runDir, 'grant.json'), content: '{}' }),
    call('Write', { file_path: path.join(tmp, 'scratch.txt'), content: 'x' }),
    call('Read', { file_path: path.join(outside, 'secret.txt') }),
    bash('git push origin main'),
    bash('kubectl --context prod delete pod x'),
    bash('echo x > src/other.js'),
  ];
  for (const opts of [{ grant: { permissions: EDIT } }, { grant: { permissions: { read_source: true } } }, { ...FULL, grant: { ...FULL.grant, permissions: EDIT } }]) {
    for (const c of calls) {
      const without = run(c, opts);
      const withPlan = run(c, { ...opts, grant: { ...opts.grant, ...planned } });
      assert.deepEqual([withPlan.decision, withPlan.reason], [without.decision, without.reason], `${c.tool_name} ${JSON.stringify(c.tool_input)}`);
    }
  }
  assert.equal(grantWith(planned).plannedPaths[0], 'src/app.js');
});

// bin/quill-guard.js as Claude Code runs it, with a grant on disk.
const GUARD = fileURLToPath(new URL('../../bin/quill-guard.js', import.meta.url));
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-guard-plan-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

function guardRun({ access = 'autonomous', plannedPaths } = {}) {
  const id = `plan${randomUUID().slice(0, 8)}`;
  const home = path.join(base, 'home');
  const qh = path.join(base, 'quill');
  const rd = handoffRunDir({ QUILL_HOME: qh }, id);
  const co = path.join(qh, 'handoffs', 'worktrees', id);
  const t = path.join(base, 'tmp');
  for (const d of [home, rd, path.join(co, 'src'), t]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(co, '.git'), { recursive: true });
  fs.writeFileSync(path.join(co, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
  const grant = { access, permissions: { read_source: true, edit_source: true }, scopes: [], actionPins: [], checkoutRoot: co, readableRoots: [co, rd, t], writableRoots: [co, rd, t], protectedPaths: [path.join(co, '.git')], mcpPolicy: { read: [], write: {} }, trustedMcpServers: [], trackerHosts: [], defaultBranch: 'main', ...(plannedPaths ? { plannedPaths } : {}) };
  const { sha256 } = writeGrant(rd, grant);
  const env = { ...process.env, USERPROFILE: home, HOME: home, TEMP: t, TMP: t, TMPDIR: t, QUILL_HOME: qh, QUILL_HANDOFF_ID: id, QUILL_HANDOFF_GUARD: access === 'full' ? 'observe' : 'enforce', QUILL_HANDOFF_GRANT_SHA256: sha256 };
  delete env.NODE_ENV;
  let n = 0;
  const guard = (tool_name, tool_input) => {
    n += 1;
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: co, tool_use_id: `toolu_${n}`, tool_name, tool_input }), env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  };
  const lines = () => readLedger(path.join(rd, 'ledger.jsonl')).filter((l) => l.kind === 'guard');
  return { co, guard, lines };
}

test('the guard marks an allowed write outside the planned files drift: true, and only that', () => {
  const r = guardRun({ plannedPaths: ['src/a.js', 'docs'] });
  assert.equal(r.guard('Write', { file_path: path.join(r.co, 'src', 'a.js'), content: 'x' }), 'allow');
  assert.equal(r.guard('Write', { file_path: path.join(r.co, 'docs', 'x.md'), content: 'x' }), 'allow');
  assert.equal(r.guard('Write', { file_path: path.join(r.co, 'src', 'b.js'), content: 'x' }), 'allow', 'drift is never refused');
  assert.equal(r.guard('Edit', { file_path: path.join(r.co, '.git', 'HEAD'), old_string: 'a', new_string: 'b' }), 'deny', 'a refused write stays refused');
  assert.equal(r.guard('Write', { file_path: path.join(base, 'tmp', 'scratch.txt'), content: 'x' }), 'allow');
  assert.equal(r.guard('Read', { file_path: path.join(r.co, 'src', 'b.js') }), 'allow');
  const lines = r.lines();
  assert.deepEqual(lines.map((l) => l.drift === true), [false, false, true, false, false, false]);
  assert.equal(countRunDrift(lines), 1);
  const none = guardRun();
  assert.equal(none.guard('Write', { file_path: path.join(none.co, 'src', 'b.js'), content: 'x' }), 'allow');
  assert.equal(none.lines()[0].drift, undefined, 'no planned files, no mark');
});

test('a full-access run (observe mode) records drift the same way', () => {
  const r = guardRun({ access: 'full', plannedPaths: ['src/a.js'] });
  assert.equal(r.guard('Write', { file_path: path.join(r.co, 'src', 'z.js'), content: 'x' }), 'allow');
  assert.equal(r.lines()[0].drift, true);
});

test('worker: a run queued with planned files freezes them into the grant and records scope_drift', async () => {
  const repo = makeRepo();
  const capture = path.join(base, `capture-${randomUUID()}.json`);
  // The fake runtime runs the real guard for each call from its working directory (the checkout).
  const calls = [
    { tool_name: 'Write', tool_input: { file_path: 'src.js', content: 'x' } },
    { tool_name: 'Write', tool_input: { file_path: 'other.js', content: 'x' } },
    { tool_name: 'Edit', tool_input: { file_path: 'lib/third.js', old_string: 'a', new_string: 'b' } },
  ];
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture, FAKE_CLAUDE_GUARD_CALLS: JSON.stringify(calls) } });
  try {
    b.ticket(T1, 'PROJ-37');
    const rid = '77777777-0000-4000-8000-000000000037';
    b.request(rid, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: { recipe: 'attempt-fix', note: '', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false }, access: 'autonomous', planned_paths: ['src.js'] } });
    b.w.tick();
    const req = b.w.state.requests.get(rid);
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const id = req.result.handoff_id;
    assert.deepEqual(b.w.state.handoffs.get(id).planned_paths, ['src.js']);
    const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(id); return ['done', 'failed', 'cancelled', 'timed-out'].includes(x.state) ? x : null; }, { timeoutMs: 20000 });
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.deepEqual(JSON.parse(seen.grant_text).plannedPaths, ['src.js'], 'frozen into the hashed grant');
    assert.deepEqual(seen.guard_decisions, ['allow', 'allow', 'allow'], 'drift never refuses');
    assert.equal(h.scope_drift, 2, JSON.stringify({ state: h.state, error: h.error }));
  } finally {
    await b.w.stop();
    for (const d of [b.home, repo.dir]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
