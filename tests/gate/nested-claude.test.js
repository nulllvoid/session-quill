// Final review C1 / ruling R57: a guarded run never starts Claude Code. A nested session gets no
// Quill guard yet signs in with the owner's login, connectors and user MCP servers, so every
// spelling the classifier can see is refused in every tier except `full` (observe only).
// Kept apart from run-guard.test.js on purpose: the permission flag is assembled from parts, so no
// literal in the repository spells a Claude Code command line that turns permission checks off.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide } from '../../src/gate/run-guard.js';
import { classifyCall } from '../../src/gate/prod-classify.js';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-nested-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const dir = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

const home = dir('home');
const qh = dir('quill');
const runDir = dir('quill', 'handoffs', 'runs', 'run1');
const checkout = dir('quill', 'handoffs', 'worktrees', 'run1');
const tmp = dir('tmp');
const VARS = { USERPROFILE: home, HOME: home, QUILL_HOME: qh, QUILL_HANDOFF_ID: 'run1', TEMP: tmp, TMP: tmp, TMPDIR: tmp, QUILL_HANDOFF_GUARD: 'enforce' };
const ENV = { cwd: checkout, vars: VARS, currentBranch: 'feat/x', defaultBranch: 'main', installRoot: dir('install') };
const RO = { read_source: true };
const ALL = { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true };
const grantWith = (over = {}) => ({
  access: 'autonomous', permissions: RO, scopes: [], actionPins: [], readableRoots: [checkout, runDir, tmp], writableRoots: [runDir, tmp], protectedPaths: [qh],
  mcpPolicy: { read: [], write: {} }, trustedMcpServers: [], trackerHosts: [], ...over,
});
const FULL = { grant: { access: 'full' }, env: { vars: { ...VARS, QUILL_HANDOFF_GUARD: 'observe' } } };
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const pwsh = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const q = (p) => `'${p}'`;
const denied = (code) => new RegExp(`^QUILL_DENIED ${code}: `);

// Claude Code's permission-skipping flag and mode, assembled from parts.
const SKIP = ['--dangerously', 'skip', 'permissions'].join('-');
const BYPASS = ['bypass', 'Permissions'].join('');

const SPELLINGS = [
  `claude -p "summarise" ${SKIP}`,
  'claude -p hi',
  'claude.exe -p hi',
  '"claude" -p hi',
  'CLAUDE -p hi',
  '/usr/local/bin/claude -p hi',
  'claude-code -p hi',
  'claude --version',
  'npx @anthropic-ai/claude-code -p hi',
  'npx -y @anthropic-ai/claude-code@2.1.300 -p hi',
  'npx --package=@anthropic-ai/claude-code claude -p hi',
  'npx -p @anthropic-ai/claude-code some-bin',
  'pnpm dlx @anthropic-ai/claude-code -p hi',
  'yarn dlx @anthropic-ai/claude-code -p hi',
  'bunx @anthropic-ai/claude-code -p hi',
  'npm exec @anthropic-ai/claude-code -- -p hi',
  'npm exec -- claude -p hi',
  'node node_modules/@anthropic-ai/claude-code/cli.js -p hi',
  'node ~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi',
  'node ~/.local/share/claude/versions/2.1.300 -p hi',
  `env -u CLAUDECODE claude -p hi ${SKIP}`,
  'env CLAUDECODE= claude -p hi',
  'CLAUDECODE= claude -p hi',
  'unset CLAUDECODE; claude -p hi',
  'cmd /c claude -p hi',
  'cmd.exe /c "claude -p hi"',
  'powershell -c "claude -p hi"',
  'pwsh -Command claude -p hi',
  'sh -c "claude -p hi"',
  "bash -c 'claude -p hi'",
  'start claude',
  'start claude -p hi',
  'echo PMO-1 | xargs claude -p',
  'nohup claude -p hi &',
  'timeout 600 claude -p hi',
  'exec claude -p hi',
  'command claude -p hi',
  'sudo -E claude -p hi',
  'parallel claude -p ::: a b',
  `node run.js ${SKIP}`,
  `node run.js ${SKIP.slice(0, 11)}"${SKIP.slice(11)}"`,
  `node run.js --permission-mode ${BYPASS}`,
  `node run.js --permission-mode=${BYPASS}`,
  `node -e "require('@anthropic-ai/claude-code')"`,
];

for (const cmd of SPELLINGS) {
  test(`C1: refused: ${cmd}`, () => {
    const r = decide(bash(cmd), grantWith(), ENV);
    assert.equal(r.decision, 'deny', r.reason);
    assert.match(r.reason, denied('nested-claude-code'));
    assert.match(r.reason, /Task or Agent tool/);
    assert.equal(classifyCall(bash(cmd), { cwd: checkout, home, env: VARS }).class, 'privileged');
  });
}

const OTHER = [
  ['PowerShell call operator on claude.exe by path', pwsh(`& ${q(path.join(home, '.local', 'bin', 'claude.exe'))} -p hi`)],
  ['PowerShell Start-Process claude', pwsh("Start-Process claude -ArgumentList '-p','hi'")],
  ['PowerShell Start-Process claude.exe', pwsh('Start-Process claude.exe -ArgumentList "-p","hi"')],
];
for (const [name, c] of OTHER) {
  test(`C1: refused: ${name}`, () => {
    const r = decide(c, grantWith(), ENV);
    assert.equal(r.decision, 'deny', r.reason);
    assert.match(r.reason, denied('nested-claude-code'));
  });
}

test('C1: refused whatever the run was granted', () => {
  assert.match(decide(bash('claude -p hi'), grantWith({ permissions: ALL, writableRoots: [checkout, runDir, tmp] }), ENV).reason, denied('nested-claude-code'));
});

test('C1: an ordinary node script and a search for the word stay allowed', () => {
  for (const cmd of ['node script.js', 'grep -rn claude src', 'npm test']) assert.equal(decide(bash(cmd), grantWith(), ENV).decision, 'allow', cmd);
});

test('C1: full access may still start Claude Code; the observer records it as privileged (ADR 0026 residual)', () => {
  const r = decide(bash('claude -p hi'), grantWith(FULL.grant), { ...ENV, ...FULL.env });
  assert.equal(r.decision, 'allow');
  assert.deepEqual(r.criticalChange, { scope: 'privileged', target: null });
});
