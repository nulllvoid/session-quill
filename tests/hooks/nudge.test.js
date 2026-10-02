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
