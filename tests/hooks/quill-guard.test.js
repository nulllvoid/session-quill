// bin/quill-guard.js as Claude Code runs it: a fresh process per tool call, PreToolUse JSON on
// stdin, the run's QUILL_HANDOFF_* env, one JSON decision on stdout and exit code 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeGrant } from '../../src/handoff/grant.js';
import { writeRunSettings, RUN_SETTINGS_FILE, GUARD_MATCHER } from '../../src/handoff/run-settings.js';

const GUARD = fileURLToPath(new URL('../../bin/quill-guard.js', import.meta.url));

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-guard-bin-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const at = (...p) => path.join(base, ...p);
const dir = (...p) => { const d = at(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const file = (p, text = 'x\n') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

const home = dir('home');
const qh = dir('quill');
const tmp = dir('tmp');
const outside = dir('outside');
file(path.join(outside, 'secret.txt'));
const NO_COMMIT = 'QUILL_DENIED no-commit-permission: git commits need the commit permission, which this run does not have. Leave the changes uncommitted and describe them in the result.';

// One run: its run dir under the Quill home, a git checkout on a branch, and a grant on disk.
let runs = 0;
function makeRun({ grant: over = {}, writeIt = true } = {}) {
  runs += 1;
  const id = `run${runs}`;
  const runDir = dir('quill', 'handoffs', 'runs', id);
  const checkout = dir('quill', 'handoffs', 'worktrees', id);
  file(path.join(checkout, 'src', 'app.js'));
  file(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
  const grant = {
    access: 'autonomous',
    permissions: { read_source: true, edit_source: true },
    scopes: [],
    actionPins: [],
    readableRoots: [checkout, runDir, tmp],
    writableRoots: [checkout, runDir, tmp],
    protectedPaths: [],
    mcpPolicy: { read: [], write: {} },
    trustedMcpServers: [],
    trackerHosts: [],
    defaultBranch: 'main',
    ...over,
  };
  const sha = writeIt ? writeGrant(runDir, grant).sha256 : 'a'.repeat(64);
  return { id, runDir, checkout, grant, sha };
}

function envFor(run, extra = {}) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp, QUILL_HOME: qh, QUILL_HANDOFF_ID: run.id, QUILL_HANDOFF_GUARD: 'enforce', QUILL_HANDOFF_GRANT_SHA256: run.sha };
  delete env.NODE_ENV;
  delete env.QUILL_GUARD_TEST_THROW;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function guard(input, env) {
  const r = spawnSync(process.execPath, [GUARD], { input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '', 'the guard writes nothing to stderr');
  let out;
  assert.doesNotThrow(() => { out = JSON.parse(r.stdout); }, `stdout is one JSON object: ${r.stdout}`);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  const h = out.hookSpecificOutput;
  assert.deepEqual(Object.keys(h).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(typeof h.permissionDecisionReason, 'string');
  return { decision: h.permissionDecision, reason: h.permissionDecisionReason };
}

const hookInput = (run, tool_name, tool_input, over = {}) => ({ session_id: 'sess-1', hook_event_name: 'PreToolUse', cwd: run.checkout, permission_mode: 'dontAsk', tool_name, tool_input, tool_use_id: 'toolu_1', ...over });
const ledgerOf = (run) => {
  const f = path.join(run.runDir, 'ledger.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('allow: a Read inside the checkout is allowed and one guard line is appended to the ledger', () => {
  const run = makeRun();
  file(path.join(run.runDir, 'ledger.jsonl'), `${JSON.stringify({ kind: 'tool_use', tool: 'Read' })}\n`);
  const r = guard(hookInput(run, 'Read', { file_path: path.join(run.checkout, 'src', 'app.js') }), envFor(run));
  assert.equal(r.decision, 'allow', r.reason);
  const lines = ledgerOf(run);
  assert.equal(lines.length, 2, 'appended after the existing line');
  const g = lines[1];
  assert.equal(g.kind, 'guard');
  assert.equal(g.tool_name, 'Read');
  assert.equal(g.decision, 'allow');
  assert.equal(typeof g.reason, 'string');
  assert.equal(typeof g.class, 'string');
  assert.ok(!Number.isNaN(Date.parse(g.ts)), 'ts is a timestamp');
  assert.equal(typeof g.input_excerpt, 'string');
});

test('deny: the exact reason from decide reaches the agent, and the ledger records it', () => {
  const run = makeRun();
  const r = guard(hookInput(run, 'Bash', { command: 'git commit -m "wip"' }), envFor(run));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, NO_COMMIT);
  const [g] = ledgerOf(run);
  assert.equal(g.decision, 'deny');
  assert.equal(g.reason, NO_COMMIT);
  assert.equal(g.tool_name, 'Bash');
});

test('the current branch is read from the checkout per call: a bare git push on a protected branch is denied', () => {
  const run = makeRun({ grant: { permissions: { read_source: true, edit_source: true, commit: true, push_branch: true } } });
  const push = hookInput(run, 'Bash', { command: 'git push' });
  assert.equal(guard(push, envFor(run)).decision, 'allow', 'on feat/x the run may push its branch');
  fs.writeFileSync(path.join(run.checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const onMain = guard(push, envFor(run));
  assert.equal(onMain.decision, 'deny');
  assert.match(onMain.reason, /^QUILL_DENIED protected-branch/);
  fs.writeFileSync(path.join(run.checkout, '.git', 'HEAD'), `${'0'.repeat(40)}\n`);
  assert.match(guard(push, envFor(run)).reason, /^QUILL_DENIED protected-branch/, 'detached HEAD: branch unknown, treated as protected');
});

test('a corrupt, missing or unhashed grant denies anything that touches files', () => {
  const run = makeRun();
  const read = hookInput(run, 'Read', { file_path: path.join(run.checkout, 'src', 'app.js') });
  fs.appendFileSync(path.join(run.runDir, 'grant.json'), ' ');
  const corrupt = guard(read, envFor(run));
  assert.equal(corrupt.decision, 'deny');
  assert.match(corrupt.reason, /^QUILL_DENIED grant-tampered/);
  assert.equal(ledgerOf(run).at(-1).decision, 'deny');

  const missing = makeRun({ writeIt: false });
  assert.match(guard(hookInput(missing, 'Read', { file_path: path.join(missing.checkout, 'src', 'app.js') }), envFor(missing)).reason, /^QUILL_DENIED grant-tampered/);

  const ok = makeRun();
  const okRead = hookInput(ok, 'Read', { file_path: path.join(ok.checkout, 'src', 'app.js') });
  assert.equal(guard(okRead, envFor(ok)).decision, 'allow');
  assert.match(guard(okRead, envFor(ok, { QUILL_HANDOFF_GRANT_SHA256: undefined })).reason, /^QUILL_DENIED grant-tampered/, 'no hash');
  assert.match(guard(okRead, envFor(ok, { QUILL_HANDOFF_ID: undefined })).reason, /^QUILL_DENIED grant-tampered/, 'no run id');
});

test('a thrown error denies Bash but allows Read/Glob/Grep inside the readable roots', () => {
  const run = makeRun();
  const env = envFor(run, { NODE_ENV: 'test', QUILL_GUARD_TEST_THROW: '1' });
  const inside = path.join(run.checkout, 'src', 'app.js');
  const bash = guard(hookInput(run, 'Bash', { command: 'ls' }), env);
  assert.equal(bash.decision, 'deny');
  assert.match(bash.reason, /^QUILL_DENIED guard-error: /);
  assert.equal(guard(hookInput(run, 'Read', { file_path: inside }), env).decision, 'allow');
  assert.equal(guard(hookInput(run, 'Glob', { pattern: 'src/**/*.js' }), env).decision, 'allow');
  assert.equal(guard(hookInput(run, 'Grep', { pattern: 'x', path: path.join(run.checkout, 'src') }), env).decision, 'allow');
  const deniedReads = [
    hookInput(run, 'Read', { file_path: path.join(outside, 'secret.txt') }),
    hookInput(run, 'Read', { file_path: path.join(run.checkout, '..', '..', '..', '..', 'outside', 'secret.txt') }),
    hookInput(run, 'Read', {}),
    hookInput(run, 'Glob', { pattern: '../../../../outside/*' }),
    hookInput(run, 'Glob', { pattern: path.join(outside, '*') }),
    hookInput(run, 'Grep', { pattern: 'x', path: outside }),
    hookInput(run, 'Grep', { pattern: 'x', glob: '../**' }),
    hookInput(run, 'Write', { file_path: inside, content: 'y' }),
  ];
  for (const c of deniedReads) assert.equal(guard(c, env).decision, 'deny', JSON.stringify(c.tool_input));
  const lines = ledgerOf(run);
  assert.ok(lines.length >= 4 + deniedReads.length);
  for (const l of lines) {
    assert.equal(l.kind, 'guard');
    assert.equal(l.error, 'Error');
  }
});

test('without a usable grant, the error fallback reads only the checkout (hook cwd) and the run dir', () => {
  const run = makeRun();
  fs.appendFileSync(path.join(run.runDir, 'grant.json'), ' ');
  const env = envFor(run, { NODE_ENV: 'test', QUILL_GUARD_TEST_THROW: '1' });
  file(path.join(tmp, 'scratch.txt'));
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(run.checkout, 'src', 'app.js') }), env).decision, 'allow');
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(run.runDir, 'grant.json') }), env).decision, 'allow');
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(tmp, 'scratch.txt') }), env).decision, 'deny', 'temp is a grant root only');
});

test('QUILL_GUARD_TEST_THROW is ignored unless NODE_ENV is test', () => {
  const run = makeRun();
  const r = guard(hookInput(run, 'Bash', { command: 'ls' }), envFor(run, { QUILL_GUARD_TEST_THROW: '1' }));
  assert.equal(r.decision, 'allow', r.reason);
});

test('input the guard cannot read is denied: not JSON, not an object, empty, over the stdin cap', () => {
  const run = makeRun();
  const env = envFor(run);
  for (const raw of ['not json', '[1,2]', '', 'null']) {
    const r = guard(raw, env);
    assert.equal(r.decision, 'deny', JSON.stringify(raw));
    assert.match(r.reason, /^QUILL_DENIED /);
  }
  const big = JSON.stringify(hookInput(run, 'Read', { file_path: path.join(run.checkout, 'src', 'app.js'), pad: 'x'.repeat(5 * 1024 * 1024) }));
  assert.equal(guard(big, env).decision, 'deny', 'over 4 MB');
});

test('the ledger never holds raw tool input, argv or path specs; secrets are redacted and the excerpt is capped', () => {
  const run = makeRun();
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const command = `curl -H "Authorization: Bearer ${secret}" https://api.example.com/x -o ${path.join(run.checkout, 'out.json')} ${'y'.repeat(4000)}`;
  guard(hookInput(run, 'Bash', { command }), envFor(run));
  const text = fs.readFileSync(path.join(run.runDir, 'ledger.jsonl'), 'utf8');
  assert.doesNotMatch(text, new RegExp(secret));
  const [g] = ledgerOf(run);
  assert.ok(Buffer.byteLength(g.input_excerpt) <= 2048, `excerpt ${Buffer.byteLength(g.input_excerpt)} bytes`);
  for (const k of ['tool_input', 'argv', 'calls', 'readSpecs', 'writeSpecs', 'classification', 'env', 'vars']) assert.ok(!(k in g), `no ${k}`);
});

test('the ledger never records env values', () => {
  const run = makeRun();
  guard(hookInput(run, 'Bash', { command: 'git commit -m x' }), envFor(run, { QUILL_GUARD_CANARY: 'canary-value-5521' }));
  assert.doesNotMatch(fs.readFileSync(path.join(run.runDir, 'ledger.jsonl'), 'utf8'), /canary-value-5521/);
});

test('a ledger that cannot be written does not change the decision', () => {
  const run = makeRun();
  fs.mkdirSync(path.join(run.runDir, 'ledger.jsonl'));
  assert.equal(guard(hookInput(run, 'Bash', { command: 'ls' }), envFor(run)).decision, 'allow');
  assert.equal(guard(hookInput(run, 'Bash', { command: 'git commit -m x' }), envFor(run)).reason, NO_COMMIT);
});

test('observe mode (full access) always allows, and the ledger records what enforce would have said', () => {
  const run = makeRun({ grant: { access: 'full' } });
  const r = guard(hookInput(run, 'Bash', { command: 'git commit -m x' }), envFor(run, { QUILL_HANDOFF_GUARD: 'observe' }));
  assert.equal(r.decision, 'allow', r.reason);
  const [g] = ledgerOf(run);
  assert.equal(g.decision, 'allow');
  assert.equal(g.enforce_decision, 'deny');
  assert.equal(g.enforce_reason, NO_COMMIT);
  const enforced = makeRun({ grant: { access: 'autonomous' } });
  assert.equal(guard(hookInput(enforced, 'Bash', { command: 'git commit -m x' }), envFor(enforced, { QUILL_HANDOFF_GUARD: 'observe' })).decision, 'deny', 'observe without a full grant enforces');
});

test('a critical change is recorded with its scope and target', () => {
  const run = makeRun({ grant: { scopes: [] } });
  const r = guard(hookInput(run, 'Bash', { command: 'kubectl --context stg apply -f deploy.yaml' }), envFor(run));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^QUILL_CRITICAL_CHANGE scope=/);
  const [g] = ledgerOf(run);
  assert.equal(g.critical, true);
  assert.equal(typeof g.scope, 'string');
});

// ------------------------------------------------------------------ run settings

test('writeRunSettings writes the guard hook into <runDir>/run-settings.json, owner-only', () => {
  const runDir = dir('settings', 'r1');
  const p = writeRunSettings(runDir, { guardCommand: { command: process.execPath, args: [GUARD] }, permissions: { deny: ['WebFetch(domain:evil.example)'] } });
  assert.equal(p, path.join(runDir, RUN_SETTINGS_FILE));
  assert.equal(RUN_SETTINGS_FILE, 'run-settings.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(s.permissions, { allow: [], deny: ['WebFetch(domain:evil.example)'] });
  assert.equal(GUARD_MATCHER, 'Bash|PowerShell|Monitor|mcp__.*|WebFetch|WebSearch|Read|Glob|Grep|Edit|Write|MultiEdit|NotebookEdit|Task|Agent');
  assert.deepEqual(Object.keys(s.hooks), ['PreToolUse']);
  assert.equal(s.hooks.PreToolUse.length, 1);
  const [entry] = s.hooks.PreToolUse;
  assert.equal(entry.matcher, GUARD_MATCHER);
  assert.equal(entry.hooks.length, 1);
  const [h] = entry.hooks;
  assert.equal(h.type, 'command');
  assert.equal(h.timeout, 10);
  assert.equal(h.onFailure, 'block');
  const slash = (s2) => s2.replaceAll('\\', '/');
  assert.equal(h.command, `"${slash(process.execPath)}" "${slash(GUARD)}"`, 'the probe-verified single command string');
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(runDir), [RUN_SETTINGS_FILE], 'no temp file left behind');
});

test('writeRunSettings defaults to this install\'s guard and no deny rules, and replaces an earlier file', () => {
  const runDir = dir('settings', 'r2');
  writeRunSettings(runDir, { permissions: { deny: ['Bash(rm:*)'] } });
  const p = writeRunSettings(runDir, {});
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(s.permissions, { allow: [], deny: [] });
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, `"${process.execPath.replaceAll('\\', '/')}" "${GUARD.replaceAll('\\', '/')}"`);
});

test('the command written by writeRunSettings runs the guard', () => {
  const run = makeRun();
  const p = writeRunSettings(run.runDir, {});
  const { command } = JSON.parse(fs.readFileSync(p, 'utf8')).hooks.PreToolUse[0].hooks[0];
  const parts = [...command.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.equal(parts.length, 2);
  const r = spawnSync(parts[0], parts.slice(1), { input: JSON.stringify(hookInput(run, 'Bash', { command: 'git commit -m x' })), env: envFor(run), encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, NO_COMMIT);
});

test('writeRunSettings refuses relative paths, characters a shell would expand, and bad deny rules', () => {
  const runDir = dir('settings', 'r3');
  const bad = [
    { guardCommand: { command: 'node', args: [GUARD] } },
    { guardCommand: { command: process.execPath, args: ['bin/quill-guard.js'] } },
    { guardCommand: { command: process.execPath, args: [] } },
    { guardCommand: { command: process.execPath, args: [path.join(base, 'a"b.js')] } },
    { guardCommand: { command: process.execPath, args: [path.join(base, '$HOME.js')] } },
    { guardCommand: { command: process.execPath, args: [path.join(base, 'a`b`.js')] } },
    { guardCommand: { command: process.execPath, args: [path.join(base, '%PATH%.js')] } },
    { guardCommand: { command: process.execPath, args: [path.join(base, 'a\nb.js')] } },
    { permissions: { deny: 'Bash' } },
    { permissions: { deny: [1] } },
  ];
  for (const opts of bad) assert.throws(() => writeRunSettings(runDir, opts), { code: 'run-settings-invalid' }, JSON.stringify(opts));
  assert.deepEqual(fs.readdirSync(runDir), []);
});
