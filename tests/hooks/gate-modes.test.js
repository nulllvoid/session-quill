import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../../src/hooks/adapter.js';
import { writeHeartbeat, writeRuntimeIdentity } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { normalizeTracker } from '../../src/core/external-keys.js';
import { main } from '../../src/cli/main.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-02T08:00:00Z';
const CWD = path.resolve(os.tmpdir(), 'gate-modes-repo');

function setup(mode, { tracker = null, repos = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-modes-'));
  const env = { QUILL_HOME: home };
  const identity = { store_id: STORE, machine_id: MACHINE, store_path: path.join(home, 'Quill'), gate_enabled: true, approval_phrases_enabled: false, allow_tools: [], tracker, default_project_id: 'demo', repos };
  if (mode !== undefined) identity.gate_mode = mode;
  writeRuntimeIdentity(identity, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  return env;
}

const pre = (env, tool_name, tool_input, extra = {}) => runHook('PreToolUse', { session_id: 's1', hook_event_name: 'PreToolUse', cwd: CWD, tool_name, tool_use_id: `u-${tool_name}`, tool_input, ...extra }, { env, now: NOW });

test('nudge mode: unbound writes, unknown shell and MCP tools get no decision and are recorded as not denied', () => {
  const env = setup('nudge');
  for (const [tool, input] of [['Edit', { file_path: path.join(CWD, 'a.js') }], ['Bash', { command: 'npm test' }], ['mcp__jira__create_issue', {}]]) {
    assert.equal(pre(env, tool, input).stdout, '', tool);
  }
  const evs = listIngress(env).map((x) => x.event).filter((e) => e.kind === 'pre-tool');
  assert.equal(evs.length, 3);
  assert.ok(evs.every((e) => e.payload.denied === false && e.payload.gate_mode === 'nudge'));
});

test('nudge mode: a capture failure or a missing session id never blocks', () => {
  const env = setup('nudge');
  fs.rmSync(path.join(env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(env.QUILL_HOME, 'ingress'), 'blocker');
  assert.equal(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout, '');
  assert.equal(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }, { session_id: undefined }).stdout, '');
});

test('strict mode with a tracker: the denial says that mentioning a key links the session', () => {
  const env = setup('strict', { tracker: normalizeTracker({ prefixes: ['PMLA'] }) });
  const reason = JSON.parse(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /PMLA-123/);
  assert.match(reason, /\/session-quill:ticket bind/);
});

test('an identity without gate_mode (older worker) keeps strict behaviour', () => {
  const env = setup(undefined);
  assert.equal(JSON.parse(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('a registered repository scope overrides the identity default by longest path', () => {
  const env = setup('nudge', { repos: [{ repo_id: 'demo', path: CWD, project_id: 'demo', gate_mode: 'strict', tracker: null }] });
  assert.equal(JSON.parse(pre(env, 'Edit', { file_path: path.join(CWD, 'a.js') }).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(pre(env, 'Edit', { file_path: 'x' }, { cwd: os.tmpdir() }).stdout, '', 'outside the repository the nudge default applies');
});

async function hookCli(env, stdin) {
  let out = '';
  const code = await main(['hook', 'PreToolUse'], { env, stdout: (s) => { out += s; }, stderr: () => {}, stdin: async () => stdin });
  return { code, out };
}

test('malformed hook input denies only when a non-nudge scope is configured', async () => {
  assert.equal((await hookCli(setup('nudge'), '{not json')).out, '');
  assert.match((await hookCli(setup('strict'), '{not json')).out, /"permissionDecision":"deny"/);
  assert.match((await hookCli(setup('nudge', { repos: [{ repo_id: 'r', path: CWD, gate_mode: 'strict' }] }), '{not json')).out, /"permissionDecision":"deny"/);
});
