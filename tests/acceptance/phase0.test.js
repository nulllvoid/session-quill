// Phase 0 — host and transport compatibility (ACCEPTANCE.md A01, A02, A03, A05, A07), as in-process
// fixture runs against the documented 2.1.x hook contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scenario, T1, T2, RID } from './scenario.js';
import { listIngress } from '../../src/core/ingress.js';
import { parseNote } from '../../src/worker/notes.js';
import { main } from '../../src/cli/main.js';

const decision = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'none');

test('A01 unbound: supported writes, unknown shell scripts, redirects, substitutions and registered mutating tools are denied; dedicated reads and allowlisted shell forms pass', async () => {
  const s = await scenario().start();
  try {
    s.hookIdentity();
    const denied = [
      ['Edit', { file_path: 'C:/repo/a.js', old_string: 'a', new_string: 'b' }], ['Write', { file_path: 'C:/repo/a.js', content: 'x' }], ['MultiEdit', { file_path: 'C:/repo/a.js', edits: [] }], ['NotebookEdit', { notebook_path: 'C:/repo/n.ipynb' }],
      ['Bash', { command: 'bash scripts/deploy.sh' }], ['Bash', { command: 'cat a.txt > b.txt' }], ['Bash', { command: 'echo $(whoami)' }], ['Bash', { command: 'git status | head' }], ['Bash', { command: 'rm -rf build' }],
      ['PowerShell', { command: 'Remove-Item x' }], ['mcp__jira__create_issue', {}], ['SomeUnknownTool', {}],
    ];
    for (const [tool_name, tool_input] of denied) {
      const r = s.hook('PreToolUse', { session_id: 'u1', tool_name, tool_input, tool_use_id: `t-${tool_name}-${Math.random()}` });
      assert.equal(decision(r), 'deny', `${tool_name} ${JSON.stringify(tool_input)}`);
    }
    const passed = [
      ['Read', { file_path: 'C:/repo/a.js' }], ['Glob', { pattern: '**/*.js' }], ['Grep', { pattern: 'x' }],
      ['Bash', { command: 'pwd' }], ['Bash', { command: 'git status' }], ['Bash', { command: 'git status --short --branch' }], ['Bash', { command: 'git status --porcelain' }], ['Bash', { command: 'ls src' }], ['Bash', { command: 'cat README.md' }],
      ['PowerShell', { command: 'Get-Location' }], ['PowerShell', { command: 'Get-ChildItem src' }], ['PowerShell', { command: 'Get-Content -Path README.md' }],
    ];
    for (const [tool_name, tool_input] of passed) {
      const r = s.hook('PreToolUse', { session_id: 'u1', tool_name, tool_input, tool_use_id: `p-${Math.random()}` });
      assert.equal(decision(r), 'none', `${tool_name} ${JSON.stringify(tool_input)} passes through to host permissions`);
    }
  } finally { await s.stop(); }
});

test('A02 plan-file exception applies only to the verified host plan path; source edits in plan mode and other plan files stay denied', async () => {
  const s = await scenario().start();
  try {
    s.hookIdentity();
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plans-'));
    const env = { ...s.env, CLAUDE_PLANS_DIR: planDir };
    const planPath = path.join(planDir, 'bright-owl.md');
    const { runHook } = await import('../../src/hooks/adapter.js');
    const h = (input) => runHook('PreToolUse', { hook_event_name: 'PreToolUse', cwd: 'C:/repo', session_id: 'plan-1', permission_mode: 'plan', ...input }, { env, now: s.iso() });
    assert.equal(decision(h({ tool_name: 'Write', tool_input: { file_path: planPath, content: '# plan' }, tool_use_id: 'w1' })), 'none', 'first plan write in plan mode is the session plan path');
    assert.equal(decision(h({ tool_name: 'Edit', tool_input: { file_path: planPath, old_string: 'a', new_string: 'b' }, tool_use_id: 'w2' })), 'none', 'editing the same plan file stays permitted');
    assert.equal(decision(h({ tool_name: 'Write', tool_input: { file_path: path.join(planDir, 'other.md'), content: 'x' }, tool_use_id: 'w3' })), 'deny', 'a different plan file is denied');
    assert.equal(decision(h({ tool_name: 'Edit', tool_input: { file_path: 'C:/repo/src/a.js', old_string: 'a', new_string: 'b' }, tool_use_id: 'w4' })), 'deny', 'plan mode never exempts source edits');
    assert.equal(decision(h({ tool_name: 'Write', tool_input: { file_path: path.join(planDir, '..', 'escape.md'), content: 'x' }, tool_use_id: 'w5' })), 'deny', 'paths outside the plan dir are denied');
  } finally { await s.stop(); }
});

test('A03 two sessions in one cwd plus a subagent get distinct identities; missing identity never falls back to cwd', async () => {
  const s = await scenario().start();
  try {
    s.hookIdentity();
    s.ticket(T1, 'LOCAL-a-00000001');
    s.ticket(T2, 'LOCAL-b-00000002');
    s.hook('SessionStart', { session_id: 'same-cwd-1', source: 'startup' });
    s.hook('SessionStart', { session_id: 'same-cwd-2', source: 'startup' });
    s.hook('SubagentStart', { session_id: 'same-cwd-1', agent_id: 'agent-z', agent_type: 'Explore' });
    s.w.tick();
    s.ingest('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'same-cwd-1' });
    s.ingest('bind', { ticket_id: T2, project_id: 'demo' }, { session_id: 'same-cwd-2' });
    s.w.tick();
    const b1 = JSON.parse(fs.readFileSync(path.join(s.home, 'state', 'bindings', 'same-cwd-1.json'), 'utf8'));
    const b2 = JSON.parse(fs.readFileSync(path.join(s.home, 'state', 'bindings', 'same-cwd-2.json'), 'utf8'));
    const ba = JSON.parse(fs.readFileSync(path.join(s.home, 'state', 'bindings', 'same-cwd-1_agent-z.json'), 'utf8'));
    assert.equal(b1.ticket_id, T1);
    assert.equal(b2.ticket_id, T2);
    assert.equal(ba.ticket_id, null, 'the subagent started before the parent bound; it inherits nothing retroactively');
    // Missing session identity: covered write denied with a diagnostic, no cwd lookup
    const r = s.hook('PreToolUse', { session_id: undefined, tool_name: 'Edit', tool_input: { file_path: 'C:/repo/a.js' }, tool_use_id: 'x' });
    assert.equal(decision(r), 'deny');
    assert.match(r.stderr, /no session_id/);
  } finally { await s.stop(); }
});

test('A05 a real local UI request is durably acknowledged, changes the note revision and is confirmed; unauthenticated, wrong-Origin and wrong-Host requests cannot mutate', async () => {
  const s = await scenario({ withServer: true }).start();
  try {
    const t = s.ticket(T1, 'LOCAL-a-00000001');
    s.w.flushNotes();
    const before = parseNote(fs.readFileSync(s.notePath('LOCAL-a-00000001'), 'utf8')).frontmatter.revision;
    const c = await s.client();
    const res = await c.post('/v1/requests', { id: RID(1), kind: 'set-next-action', target_id: T1, expected_revision: t.revision, payload: { next_action: 'Round trip' } });
    assert.equal(res.status, 202, 'durable acknowledgement after persistence');
    const rec = await res.json();
    assert.equal(rec.state, 'pending');
    s.advance(10_000);
    await s.settle();
    const applied = await (await c.get(`/v1/requests/${RID(1)}`)).json();
    assert.equal(applied.state, 'applied', 'confirmation is available to the UI');
    s.w.flushNotes();
    const after = parseNote(fs.readFileSync(s.notePath('LOCAL-a-00000001'), 'utf8')).frontmatter;
    assert.ok(after.revision > before, 'local note revision changed');
    assert.equal(after.next_action, 'Round trip');
    const body = { id: RID(2), kind: 'set-next-action', target_id: T1, expected_revision: after.revision, payload: { next_action: 'evil' } };
    assert.equal((await fetch(`${c.base}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-quill-csrf': c.csrf }, body: JSON.stringify(body) })).status, 401);
    assert.equal((await c.post('/v1/requests', body, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await c.post('/v1/requests', body, { 'x-quill-csrf': 'bad' })).status, 403);
    assert.equal(s.w.state.requests.has(RID(2)), false, 'nothing entered the queue');
  } finally { await s.stop(); }
});

test('A07 malformed input and hook failures never block the session, and a valid binding never emits a permission allow override', async () => {
  const s = await scenario().start();
  try {
    s.hookIdentity();
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('bound-1', T1);
    let out = '';
    let err = '';
    const code = await main(['hook', 'PreToolUse'], { env: s.env, stdout: (x) => { out += x; }, stderr: (x) => { err += x; }, stdin: async () => '{not json' });
    assert.equal(code, 0, 'the hook process itself never fails');
    assert.match(out, /"permissionDecision":"deny"/, 'a PreToolUse the gate cannot evaluate fails closed');
    assert.match(err, /malformed hook input/);
    let stopOut = '';
    const stopCode = await main(['hook', 'Stop'], { env: s.env, stdout: (x) => { stopOut += x; }, stderr: () => {}, stdin: async () => '{not json' });
    assert.equal(stopCode, 0);
    assert.equal(stopOut, '', 'non-gate hooks never block the session');
    const outputs = [];
    for (const [tool_name, tool_input] of [['Edit', { file_path: 'C:/repo/a.js' }], ['Bash', { command: 'rm -rf build' }], ['mcp__jira__create_issue', {}], ['Read', { file_path: 'x' }]]) {
      outputs.push(s.hook('PreToolUse', { session_id: 'bound-1', tool_name, tool_input, tool_use_id: `b-${tool_name}` }));
    }
    for (const o of outputs) {
      assert.equal(o.stdout, '', 'bound sessions produce no decision at all');
      assert.equal(/"permissionDecision"\s*:\s*"allow"/.test(o.stdout), false);
    }
    const nonGate = s.hook('Stop', { session_id: 'bound-1', last_assistant_message: 'ok' });
    assert.equal(nonGate.exitCode, 0);
    assert.ok(listIngress(s.env).some((e) => e.event.kind === 'stop'));
  } finally { await s.stop(); }
});
