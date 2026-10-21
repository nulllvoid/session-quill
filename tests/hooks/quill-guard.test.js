// bin/quill-guard.js as Claude Code runs it: a fresh process per tool call, PreToolUse JSON on
// stdin, the run's QUILL_HANDOFF_* env, one JSON decision on stdout and exit code 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeGrant } from '../../src/handoff/grant.js';
import { writeRunSettings, RUN_SETTINGS_FILE, GUARD_MATCHER } from '../../src/handoff/run-settings.js';
import { reconcileAttempts } from '../../src/handoff/reconcile.js';

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
// R58: the refusal also names the other git commands that write the shared repository
const NO_COMMIT = 'QUILL_DENIED no-commit-permission: git commits, and every git command that writes the shared repository (refs, branches, tags, stash, notes, objects, the index or configuration), need the commit permission, which this run does not have. Use read-only git (status, log, show, diff, blame, grep, ls-files, rev-parse, branch and tag listings, fetch), leave the changes uncommitted and describe them in the result.';

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

test('observe mode (full access) allows on the error paths too, and the ledger says what happened (M1)', () => {
  const run = makeRun({ grant: { access: 'full' } });
  const observe = envFor(run, { QUILL_HANDOFF_GUARD: 'observe' });
  const big = JSON.stringify(hookInput(run, 'Write', { file_path: path.join(run.checkout, 'fixture.json'), content: 'x'.repeat(5 * 1024 * 1024) }));
  const r1 = guard(big, observe);
  assert.equal(r1.decision, 'allow', r1.reason);
  const r2 = guard(hookInput(run, 'Bash', { command: 'ls' }), { ...observe, NODE_ENV: 'test', QUILL_GUARD_TEST_THROW: '1' });
  assert.equal(r2.decision, 'allow', r2.reason);
  const [l1, l2] = ledgerOf(run);
  assert.equal(l1.decision, 'allow');
  assert.equal(l1.error, 'stdin-too-large');
  assert.equal(l2.decision, 'allow');
  assert.equal(l2.error, 'Error');
  // enforce keeps failing closed, and observe without a full grant enforces
  assert.equal(guard(big, envFor(run)).decision, 'deny');
  const partial = makeRun({ grant: { access: 'autonomous' } });
  assert.equal(guard(big, envFor(partial, { QUILL_HANDOFF_GUARD: 'observe' })).decision, 'deny');
  assert.equal(guard(hookInput(partial, 'Bash', { command: 'ls' }), envFor(partial, { QUILL_HANDOFF_GUARD: 'observe', NODE_ENV: 'test', QUILL_GUARD_TEST_THROW: '1' })).decision, 'deny');
});

test('the error fallback keeps decide\'s unreadable carve-outs inside a broad readable root (M3)', () => {
  const run = makeRun({ grant: { readableRoots: [base], writableRoots: [] } });
  const env = envFor(run, { NODE_ENV: 'test', QUILL_GUARD_TEST_THROW: '1' });
  const creds = file(path.join(home, '.aws', 'credentials'));
  const settings = file(path.join(home, '.claude', 'settings.json'));
  const memory = file(path.join(qh, 'memory', 'notes.md'));
  for (const p of [creds, settings, memory]) assert.equal(guard(hookInput(run, 'Read', { file_path: p }), env).decision, 'deny', p);
  assert.equal(guard(hookInput(run, 'Grep', { pattern: 'x', path: path.join(home, '.aws') }), env).decision, 'deny');
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(outside, 'secret.txt') }), env).decision, 'allow', 'not a carve-out: inside the broad root');
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(run.checkout, 'src', 'app.js') }), env).decision, 'deny', 'the checkout below the Quill home is not a root of this grant');
});

test('the error fallback reads the checkout and run dir below the Quill home when they are roots (M3)', () => {
  const run = makeRun();
  const env = envFor(run, { NODE_ENV: 'test', QUILL_GUARD_TEST_THROW: '1' });
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(run.checkout, 'src', 'app.js') }), env).decision, 'allow');
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(run.runDir, 'grant.json') }), env).decision, 'allow');
  assert.equal(guard(hookInput(run, 'Read', { file_path: path.join(qh, 'memory', 'notes.md') }), env).decision, 'deny');
});

test('real guard ledger lines reconcile: only the denied call becomes a refused attempt (I2)', () => {
  const run = makeRun({ grant: { access: 'full' } });
  const enforce = makeRun();
  guard(hookInput(run, 'Bash', { command: 'git commit -m x' }, { tool_use_id: 'toolu_obs' }), envFor(run, { QUILL_HANDOFF_GUARD: 'observe' }));
  guard(hookInput(enforce, 'Bash', { command: 'ls' }, { tool_use_id: 'toolu_ls' }), envFor(enforce));
  guard(hookInput(enforce, 'Bash', { command: 'git commit -m x' }, { tool_use_id: 'toolu_commit' }), envFor(enforce));
  const lines = [...ledgerOf(run), ...ledgerOf(enforce)];
  assert.deepEqual(lines.map((l) => [l.tool_use_id, l.decision, l.enforce_decision ?? null, l.input_summary]), [
    ['toolu_obs', 'allow', 'deny', 'git commit -m x'], ['toolu_ls', 'allow', null, 'ls'], ['toolu_commit', 'deny', null, 'git commit -m x'],
  ]);
  // the stream's own lines for the denied call: tool_use, the hook-error result, permission_denials
  const stream = [
    { kind: 'tool_use', tool: 'Bash', input_summary: 'git commit -m x', tool_use_id: 'toolu_commit' },
    { kind: 'guard', tool: 'Bash', input_summary: 'git commit -m x', decision: 'deny', is_error: true, tool_use_id: 'toolu_commit' },
    { kind: 'denial', tool: 'Bash', input_summary: 'git commit -m x', decision: 'deny', tool_use_id: 'toolu_commit' },
  ];
  const { attempts, added } = reconcileAttempts([{ route: 'list', tool: 'ls', target: '.', outcome: 'worked' }], [...lines, ...stream]);
  assert.equal(attempts[0].verified, 'seen');
  assert.deepEqual(added.map((a) => [a.tool, a.target, a.outcome]), [['Bash', 'git commit -m x', 'refused']]);
});

// ------------------------------------------------------------------ run settings

test('writeRunSettings writes the guard hook into <runDir>/run-settings.json as command + args, owner-only', () => {
  const runDir = dir('settings', 'r1');
  const spaced = path.join(base, 'with space', 'bin', 'quill-guard.js');
  const p = writeRunSettings(runDir, { guardCommand: { command: process.execPath, args: [spaced] }, permissions: { deny: ['WebFetch(domain:evil.example)'] } });
  assert.equal(p, path.join(runDir, RUN_SETTINGS_FILE));
  assert.equal(RUN_SETTINGS_FILE, 'run-settings.json');
  assert.equal(GUARD_MATCHER, 'Bash|PowerShell|Monitor|mcp__.*|WebFetch|WebSearch|Read|Glob|Grep|Edit|Write|MultiEdit|NotebookEdit|Task|Agent');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
    permissions: { allow: [], deny: ['WebFetch(domain:evil.example)'] },
    hooks: { PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [spaced], timeout: 10, onFailure: 'block' }] }] },
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(runDir), [RUN_SETTINGS_FILE], 'no temp file left behind');
});

test('writeRunSettings defaults to this node and this install\'s guard, no deny rules, and replaces an earlier file', () => {
  const runDir = dir('settings', 'r2');
  writeRunSettings(runDir, { permissions: { deny: ['Bash(rm:*)'] } });
  const p = writeRunSettings(runDir, {});
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(s.permissions, { allow: [], deny: [] });
  const [h] = s.hooks.PreToolUse[0].hooks;
  assert.equal(h.command, process.execPath, 'unchanged: no quoting, no slash rewriting');
  assert.deepEqual(h.args, [GUARD]);
});

test('the command and args written by writeRunSettings run the guard without a shell', async () => {
  const run = makeRun();
  const p = writeRunSettings(run.runDir, {});
  const { command, args } = JSON.parse(fs.readFileSync(p, 'utf8')).hooks.PreToolUse[0].hooks[0];
  const child = spawn(command, args, { env: envFor(run), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stdin.end(JSON.stringify(hookInput(run, 'Bash', { command: 'git commit -m x' })));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason, NO_COMMIT);
});

test('writeRunSettings refuses relative paths, characters the hook would not pass through, and bad deny rules', () => {
  const runDir = dir('settings', 'r3');
  const bad = [
    { guardCommand: { command: 'node', args: [GUARD] } },
    { guardCommand: { command: process.execPath, args: ['bin/quill-guard.js'] } },
    { guardCommand: { command: process.execPath, args: [] } },
    { guardCommand: { command: process.execPath } },
    { guardCommand: { command: process.execPath, args: [path.join(base, '${HOME}.js')] } },
    { guardCommand: { command: process.execPath, args: [path.join(base, 'a\nb.js')] } },
    { guardCommand: { command: process.execPath, args: [path.join(base, 'a\0b.js')] } },
    { permissions: { deny: 'Bash' } },
    { permissions: { deny: [1] } },
  ];
  for (const opts of bad) assert.throws(() => writeRunSettings(runDir, opts), { code: 'run-settings-invalid' }, JSON.stringify(opts));
  assert.deepEqual(fs.readdirSync(runDir), []);
});

test('MCP calls: the server source comes from <runDir>/mcp-servers.json; a project, unknown or unlisted server is refused unless trusted (R20)', () => {
  const run = makeRun({ grant: { trustedMcpServers: ['trusted-db'] } });
  const call = (tool) => guard(hookInput(run, tool, { id: 'X-1' }), envFor(run));
  const before = call('mcp__claude_ai_Atlassian__getJiraIssue');
  assert.equal(before.decision, 'deny', 'no inventory yet: the server is not known to be trusted');
  assert.match(before.reason, /^QUILL_DENIED untrusted-mcp-server: MCP server claude_ai_Atlassian/);
  fs.writeFileSync(path.join(run.runDir, 'mcp-servers.json'), JSON.stringify({ claude_ai_Atlassian: 'claudeai', 'claude.ai Gmail': 'claudeai', 'repo-db': 'project', 'trusted-db': 'project', mine: 'user', plug: 'plugin' }));
  for (const tool of ['mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__claude_ai_Gmail__search_threads', 'mcp__mine__list_things', 'mcp__plug__get_status', 'mcp__trusted-db__list_tables']) {
    const r = call(tool);
    assert.equal(r.decision, 'allow', `${tool}: ${r.reason}`);
  }
  for (const tool of ['mcp__repo-db__list_tables', 'mcp__absent__get_thing']) {
    const r = call(tool);
    assert.equal(r.decision, 'deny', tool);
    assert.match(r.reason, /^QUILL_DENIED untrusted-mcp-server/);
  }
  fs.writeFileSync(path.join(run.runDir, 'mcp-servers.json'), '{not json');
  assert.equal(call('mcp__claude_ai_Atlassian__getJiraIssue').decision, 'deny', 'an unreadable inventory trusts nothing');
});

test('a run cannot rewrite its own mcp-servers.json', () => {
  const run = makeRun();
  const r = guard(hookInput(run, 'Write', { file_path: path.join(run.runDir, 'mcp-servers.json'), content: '{"repo-db":"user"}' }), envFor(run));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^QUILL_DENIED protected-path/);
  assert.equal(guard(hookInput(run, 'Write', { file_path: path.join(run.runDir, 'notes.txt'), content: 'x' }), envFor(run)).decision, 'allow');
});

test('the ledger keeps a tool name by its shape, not through the secret rules, so reconcile still matches it', () => {
  const run = makeRun();
  const tool = 'mcp__s3v2__putObjectV2InBucket4Region9';
  guard(hookInput(run, tool, { Bucket: 'b' }, { tool_use_id: 'toolu_mcp' }), envFor(run));
  const [g] = ledgerOf(run);
  assert.equal(g.tool_name, tool, 'an MCP tool name is an identifier, not a high-entropy secret');
  const recon = reconcileAttempts([{ route: 'mcp', tool, outcome: 'refused' }], ledgerOf(run));
  assert.equal(recon.attempts[0].verified, 'seen', 'the attempt matches its ledger line');
  for (const bad of ['Bash; rm -rf /', 'x'.repeat(201), 'tab\tname', 7]) {
    guard(hookInput(run, bad, {}, { tool_use_id: 'toolu_bad' }), envFor(run));
    assert.equal(ledgerOf(run).at(-1).tool_name, '[invalid tool name]', String(bad).slice(0, 20));
  }
});
