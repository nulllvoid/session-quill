import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runTestCommand, testGateSettings, TAIL_CHARS } from '../../src/handoff/test-gate.js';
import { bootWorker, makeRepo, until, git, T1 } from './helpers.js';

const RID = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fix = { mode: 'attempt-fix', note: 'fix it', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false }, branch: null };

// A stand-in test suite: passes always, never, or once src.js carries the repair marker, and can
// hang to exercise the timeout. Kept outside the repository and run by absolute path.
function gateScript(behaviour) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-'));
  const file = path.join(dir, 'gate.js');
  fs.writeFileSync(file, [
    "const fs = require('fs');",
    `const behaviour = ${JSON.stringify(behaviour)};`,
    "console.log('running 3 tests');",
    "if (behaviour === 'hang') setTimeout(() => {}, 60000);",
    'else {',
    "  const src = fs.readFileSync('src.js', 'utf8');",
    "  const ok = behaviour === 'pass' || (behaviour === 'repair' && src.includes('repaired by fake-claude'));",
    "  if (!ok) { console.error('not ok 2 - retry test: expected 3, got 2'); process.exit(1); }",
    "  console.log('ok 3 tests');",
    '}',
  ].join('\n'));
  return `"${process.execPath}" "${file}"`;
}

async function runFix(b, rid, payload = fix) {
  const t = b.ticket(T1, 'LOCAL-a-00000001');
  b.request(rid, { target_id: T1, expected_revision: t.revision, payload });
  b.w.tick();
  const hid = b.w.state.requests.get(rid).result.handoff_id;
  return until(() => { b.w.tick(); const h = b.w.state.handoffs.get(hid); return ['done', 'failed', 'timed-out', 'cancelled'].includes(h.state) ? h : null; }, { timeoutMs: 20_000 });
}

test('test gate settings: a trimmed command per repository and a positive timeout, 10 minutes by default', () => {
  assert.deepEqual(testGateSettings({ test_command: '  npm test ' }), { command: 'npm test', timeoutMs: 600_000 });
  assert.deepEqual(testGateSettings({ test_command: 'npm test', test_timeout_ms: 5000 }), { command: 'npm test', timeoutMs: 5000 });
  assert.deepEqual(testGateSettings({ test_command: 'npm test', test_timeout_ms: -1 }), { command: 'npm test', timeoutMs: 600_000 });
  assert.deepEqual(testGateSettings({ test_command: '   ' }), { command: null, timeoutMs: 600_000 });
  assert.deepEqual(testGateSettings(null), { command: null, timeoutMs: 600_000 });
});

test('runTestCommand reports pass, failure with the output tail, and timeout', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-cwd-'));
  fs.writeFileSync(path.join(cwd, 'src.js'), 'x');
  const pass = await runTestCommand({ command: gateScript('pass'), cwd, timeoutMs: 20_000 });
  assert.equal(pass.status, 'passed');
  assert.equal(pass.exit_code, 0);
  assert.ok(Number.isInteger(pass.ms));
  const fail = await runTestCommand({ command: gateScript('never'), cwd, timeoutMs: 20_000 });
  assert.equal(fail.status, 'failed');
  assert.equal(fail.exit_code, 1);
  assert.match(fail.tail, /expected 3, got 2/);
  const long = path.join(cwd, 'long.js');
  fs.writeFileSync(long, "process.stdout.write('a'.repeat(20000) + 'END');");
  const big = await runTestCommand({ command: `"${process.execPath}" "${long}"`, cwd, timeoutMs: 20_000 });
  assert.ok(big.tail.length <= TAIL_CHARS && big.tail.endsWith('END'), 'keeps only the last few KB');
  const hang = await runTestCommand({ command: gateScript('hang'), cwd, timeoutMs: 400 });
  assert.equal(hang.status, 'timeout');
  assert.equal(hang.exit_code, null);
});

test('a passing gate is recorded on the fix run as worker evidence, with its time', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { test_command: gateScript('pass') }, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const h = await runFix(b, RID(1));
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    assert.equal(h.test_gate.status, 'passed');
    assert.equal(h.test_gate.exit_code, 0);
    assert.equal(h.test_gate.attempts, 1);
    assert.match(h.test_gate.tail, /ok 3 tests/);
    assert.ok(Number.isInteger(h.timings.test_ms));
    assert.ok(b.w.liveSnapshot().handoffs.find((x) => x.id === h.id).test_gate, 'the gate reaches the projection');
    assert.equal(b.w.liveSnapshot().repos.find((r) => r.id === 'demo').test_command, h.test_gate.command, 'the handoff form can name the command');
  } finally { await b.w.stop(); }
});

test('a failing gate gets one repair turn with the failing output, then passes', async () => {
  const repo = makeRepo();
  const capture = path.join(os.tmpdir(), `capture-${randomUUID()}.json`);
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { test_command: gateScript('repair') }, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js', FAKE_CLAUDE_REPAIR_EDIT: 'src.js', FAKE_CLAUDE_CAPTURE: capture } });
  try {
    const h = await runFix(b, RID(2));
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    assert.equal(h.test_gate.status, 'passed');
    assert.equal(h.test_gate.attempts, 2);
    assert.equal(h.test_gate.repaired, true);
    const turns = fs.readFileSync(`${capture}.resume`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const repair = turns.find((t) => /tests failed/i.test(t.prompt));
    assert.ok(repair, 'the repair turn was asked to fix the failing tests');
    assert.match(repair.prompt, /expected 3, got 2/, 'with the failing output');
  } finally { await b.w.stop(); }
});

test('a gate that fails again after the repair turn yields no suggestion, no commit, and the reason', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { test_command: gateScript('never') }, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const before = git(repo.dir, 'rev-parse', 'HEAD');
    const h = await runFix(b, RID(3), { ...fix, permissions: { ...fix.permissions, commit: true } });
    assert.equal(h.state, 'failed');
    assert.equal(h.error.code, 'tests-failed');
    assert.match(h.error.message, /repair/);
    assert.equal(h.test_gate.status, 'failed');
    assert.equal(h.test_gate.attempts, 2);
    assert.equal(h.commit_sha ?? null, null, 'nothing is committed');
    assert.ok(h.patch_path && fs.existsSync(h.patch_path), 'the diff is kept for the owner to inspect');
    assert.equal(b.w.state.tickets.get(T1).next_action, '', 'the next action is not applied');
    assert.equal(git(repo.dir, 'rev-parse', 'HEAD'), before);
  } finally { await b.w.stop(); }
});

test('a gate that times out is killed, repaired once, and fails with the timeout as its reason', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { test_command: gateScript('hang'), test_timeout_ms: 400 }, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const h = await runFix(b, RID(4));
    assert.equal(h.state, 'failed');
    assert.equal(h.error.code, 'tests-timeout');
    assert.equal(h.test_gate.status, 'timeout');
    assert.equal(h.test_gate.attempts, 2);
  } finally { await b.w.stop(); }
});

test('without a test command a fix is recorded as not test-verified', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  try {
    const h = await runFix(b, RID(5));
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    assert.equal(h.test_gate.status, 'skipped');
    assert.match(h.test_gate.reason, /no test_command/);
    assert.equal('test_ms' in h.timings, false, 'no test time without a test run');
  } finally { await b.w.stop(); }
});

test('a draft PR body says the tests passed (worker) only after a real pass', async () => {
  const { gateLine } = await import('../../src/handoff/extension.js');
  assert.match(gateLine({ status: 'passed', command: 'npm test', repaired: false }), /^Tests passed \(worker\): `npm test` exited 0\.$/);
  assert.match(gateLine({ status: 'passed', command: 'npm test', repaired: true }), /after one repair turn/);
  assert.doesNotMatch(gateLine({ status: 'skipped', reason: 'no test_command' }), /passed/i);
  assert.doesNotMatch(gateLine(null), /passed/i);
});

// A suite that passes (or hangs) but first leaves a background process holding stdout and stderr,
// as a watcher or a forgotten server does.
function leakyScript(behaviour, marker = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-leak-'));
  const file = path.join(dir, 'gate.js');
  fs.writeFileSync(file, [
    "const { spawn } = require('child_process');",
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });",
    ...(marker ? [`require('fs').writeFileSync(${JSON.stringify(marker)}, 'started');`] : []),
    "console.log('ok 3 tests');",
    behaviour === 'hang' ? 'setTimeout(() => {}, 60000);' : 'process.exit(0);',
  ].join('\n'));
  return `"${process.execPath}" "${file}"`;
}

test('a passing command that leaves a process holding its output still passes, after a short grace', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-cwd-'));
  const started = Date.now();
  const r = await runTestCommand({ command: leakyScript('pass'), cwd, timeoutMs: 20_000 });
  assert.equal(r.status, 'passed', r.tail);
  assert.equal(r.exit_code, 0);
  assert.match(r.tail, /ok 3 tests/);
  assert.ok(Date.now() - started < 10_000, 'the exit code decides, not the pipes closing');
});

test('stopping a test command through its kill handle ends it promptly even when a background process holds the pipes', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-cwd-'));
  let kill;
  const p = runTestCommand({ command: leakyScript('hang'), cwd, timeoutMs: 60_000, onChild: (_child, k) => { kill = k; } });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(typeof kill, 'function');
  const started = Date.now();
  kill();
  const r = await p;
  assert.notEqual(r.status, 'passed');
  assert.ok(Date.now() - started < 8_000, `ended ${Date.now() - started} ms after the kill`);
});

test('a worker stopped during the test gate waits for it and ends the run as stopped, not interrupted', async () => {
  const repo = makeRepo();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-mark-')), 'started');
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { test_command: leakyScript('hang', marker) }, fakeEnv: { FAKE_CLAUDE_EDIT: 'src.js' } });
  let stopped = false;
  try {
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    b.request(RID(20), { target_id: T1, expected_revision: t.revision, payload: fix });
    b.w.tick();
    const hid = b.w.state.requests.get(RID(20)).result.handoff_id;
    await until(() => { b.w.tick(); return fs.existsSync(marker); }, { timeoutMs: 20_000 });
    await b.w.stop();
    stopped = true;
    const h = b.w.state.handoffs.get(hid);
    assert.equal(h.state, 'failed');
    assert.equal(h.error.code, 'interrupted');
    assert.match(h.error.message, /worker stopped while the run was in progress/);
  } finally { if (!stopped) await b.w.stop(); }
});
