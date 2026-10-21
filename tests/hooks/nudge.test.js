import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../../src/hooks/adapter.js';
import { writeBindingSnapshot, writeHeartbeat, writeRuntimeIdentity } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { normalizeTracker } from '../../src/core/external-keys.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-02T08:00:00Z';
const TRACKER = normalizeTracker({ system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PMLA'] });

function setup({ mode = 'nudge', tracker = TRACKER, bound = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-nudge-'));
  const repo = path.resolve(os.tmpdir(), 'nudge-repo');
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: STORE, machine_id: 'M', store_path: home, gate_enabled: true, gate_mode: mode, approval_phrases_enabled: false, allow_tools: [], tracker, default_project_id: 'demo', repos: [] }, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  if (bound) writeBindingSnapshot('s1', { ticket_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ticket_key: 'PMLA-1', binding_revision: 1, gate_enabled: true }, env);
  return { env, repo };
}

const hook = (fx, name, extra = {}) => runHook(name, { session_id: 's1', cwd: fx.repo, hook_event_name: name, ...extra }, { env: fx.env, now: NOW });
const edit = (fx, id = 'u1') => hook(fx, 'PostToolUse', { tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: path.join(fx.repo, 'src', 'a.js') }, tool_response: { filePath: path.join(fx.repo, 'src', 'a.js') } });
const stop = (fx, active = false) => hook(fx, 'Stop', { stop_hook_active: active, last_assistant_message: 'Done.' });

test('in nudge mode an unbound session that changed files is asked once at Stop', () => {
  const fx = setup();
  edit(fx);
  const out = JSON.parse(stop(fx).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /PMLA-123/);
  assert.match(out.reason, /Do not ask again/);
  assert.equal(listIngress(fx.env).map((x) => x.event).filter((e) => e.kind === 'stop')[0].payload.nudged, true);
  assert.equal(stop(fx, true).stdout, '', 'the continuation Claude runs because of the nudge is never blocked');
  edit(fx, 'u2');
  assert.equal(stop(fx).stdout, '', 'once per session');
});

test('no nudge when bound, when nothing changed, in strict or off mode, or for subagents', () => {
  const bound = setup({ bound: true });
  edit(bound);
  assert.equal(stop(bound).stdout, '');
  const idle = setup();
  assert.equal(stop(idle).stdout, '');
  for (const mode of ['strict', 'off']) {
    const fx = setup({ mode });
    edit(fx);
    assert.equal(stop(fx).stdout, '', mode);
  }
  const sub = setup();
  edit(sub);
  assert.equal(hook(sub, 'SubagentStop', { agent_id: 'a1', last_assistant_message: 'x' }).stdout, '');
});

test('without a tracker the nudge points at the bind command', () => {
  const fx = setup({ tracker: null });
  edit(fx);
  assert.match(JSON.parse(stop(fx).stdout).reason, /\/session-quill:ticket bind <KEY>/);
});

// Plan drift (ADR 0037): a write outside the approved plan's files is raised once at Stop.
const plan = (fx, text, id = 'p1') => hook(fx, 'PostToolUse', { tool_name: 'ExitPlanMode', tool_use_id: id, tool_input: { plan: text }, tool_response: 'User has approved your plan.' });
const write = (fx, rel, id) => hook(fx, 'PostToolUse', { tool_name: 'Write', tool_use_id: id, tool_input: { file_path: path.join(fx.repo, ...rel.split('/')), content: 'x' }, tool_response: {} });

test('a write outside the plan\'s files is raised once per session at Stop, in nudge mode; the write itself is never refused', () => {
  const fx = setup({ bound: true });
  plan(fx, '# Plan\n1. Edit `src/a.js` and its test tests/a.test.js');
  assert.equal(write(fx, 'src/a.js', 'w1').stdout, '');
  assert.equal(stop(fx).stdout, '', 'writes inside the plan are not drift');
  const out = write(fx, 'src/other.js', 'w2');
  assert.equal(out.stdout, '', 'drift never produces a decision on the write');
  const blocked = JSON.parse(stop(fx).stdout);
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.reason, 'Session Quill: You changed "src/other.js" outside your plan. Update the plan or carry on.');
  assert.equal(listIngress(fx.env).map((x) => x.event).filter((e) => e.kind === 'stop').at(-1).payload.drift_nudged, true);
  assert.equal(stop(fx, true).stdout, '', 'the continuation is never blocked');
  write(fx, 'src/third.js', 'w3');
  assert.equal(stop(fx).stdout, '', 'once per session');
  plan(fx, 'Now only `src/b.js`', 'p2');
  write(fx, 'src/c.js', 'w4');
  assert.equal(stop(fx).stdout, '', 'a new plan does not re-arm a nudge already given');
});

test('no drift nudge without planned files, in strict or off mode, in a run, or for writes outside the project', () => {
  const none = setup({ bound: true });
  plan(none, '# Plan\nRefactor the parser.');
  write(none, 'src/x.js', 'w1');
  assert.equal(stop(none).stdout, '', 'a plan that names no files has nothing to drift from');
  for (const mode of ['strict', 'off']) {
    const fx = setup({ mode, bound: true });
    plan(fx, 'Edit src/a.js');
    write(fx, 'src/b.js', 'w1');
    assert.equal(stop(fx).stdout, '', mode);
  }
  const outside = setup({ bound: true });
  plan(outside, 'Edit src/a.js');
  hook(outside, 'PostToolUse', { tool_name: 'Write', tool_use_id: 'w9', tool_input: { file_path: path.join(os.tmpdir(), 'elsewhere', 'notes.md') }, tool_response: {} });
  assert.equal(stop(outside).stdout, '', 'an absolute path outside the session directory is not the project\'s work');
  const fx = setup({ bound: true });
  const runEnv = { ...fx.env, QUILL_HANDOFF_ID: 'h1', QUILL_HANDOFF_TICKET_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const inRun = (name, extra) => runHook(name, { session_id: 's1', cwd: fx.repo, hook_event_name: name, ...extra }, { env: runEnv, now: NOW });
  inRun('PostToolUse', { tool_name: 'ExitPlanMode', tool_use_id: 'p1', tool_input: { plan: 'Edit src/a.js' }, tool_response: 'approved' });
  inRun('PostToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: path.join(fx.repo, 'src', 'b.js') }, tool_response: {} });
  assert.equal(inRun('Stop', { last_assistant_message: 'Done.' }).stdout, '', 'a run is never stopped for drift (ADR 0017)');
});

test('the unlinked-work nudge comes first; drift is raised at the next Stop', () => {
  const fx = setup();
  plan(fx, 'Edit src/a.js');
  write(fx, 'src/b.js', 'w1');
  assert.match(JSON.parse(stop(fx).stdout).reason, /not linked to a ticket/);
  assert.match(JSON.parse(stop(fx).stdout).reason, /outside your plan/);
  assert.equal(stop(fx).stdout, '');
});
