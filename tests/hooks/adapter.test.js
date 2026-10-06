import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../../src/hooks/adapter.js';
import { writeBindingSnapshot, bindingSnapshotPath, writeHeartbeat, writeRuntimeIdentity } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { getBlob } from '../../src/core/blobs.js';

const FIX = path.resolve('tests/fixtures/hooks');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-02T08:00:00Z';

function setup({ bound = false, heartbeat = true, approval = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hook-'));
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: STORE, machine_id: MACHINE, store_path: path.join(home, 'Quill'), gate_enabled: true, approval_phrases_enabled: approval, allow_tools: [] }, env);
  if (heartbeat) writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  if (bound) writeBindingSnapshot('sess-0001', { ticket_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ticket_key: 'LOCAL-x-00000001', ticket_title: 'Demo', binding_revision: 1, gate_enabled: true, project_id: 'demo', revision_committed_at: NOW }, env);
  return env;
}

const run = (name, env, now = NOW) => runHook(fixture(name).hook_event_name, fixture(name), { env, now });
const events = (env) => listIngress(env).map((x) => x.event);

test('unbound Edit is denied with a structured PreToolUse decision and the attempt is recorded as denied', () => {
  const env = setup();
  const r = run('pre-tool-use-edit', env);
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /session-quill:ticket/);
  const evs = events(env);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'pre-tool');
  assert.equal(evs[0].payload.denied, true);
  assert.equal(evs[0].tool_call_id, 'toolu_01A');
});

test('unbound Read and read-only Bash produce no output; non-grammar Bash is denied', () => {
  const env = setup();
  assert.equal(run('pre-tool-use-read', env).stdout, '');
  assert.equal(run('pre-tool-use-bash-ls', env).stdout, '');
  const r = run('pre-tool-use-bash-npm', env);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('bound session Edit produces no decision and records attribution with the binding revision', () => {
  const env = setup({ bound: true });
  const r = run('pre-tool-use-edit', env);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
  const [ev] = events(env);
  assert.equal(ev.kind, 'pre-tool');
  assert.equal(ev.ticket_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(ev.binding_revision, 1);
  assert.equal(ev.payload.denied, false);
  assert.equal(ev.session_id, 'sess-0001');
});

test('stale heartbeat denies covered writes even when bound', () => {
  const env = setup({ bound: true, heartbeat: false });
  const r = run('pre-tool-use-edit', env);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /worker unavailable/);
});

test('subagent PreToolUse uses the agent identity, not the parent binding file', () => {
  const env = setup({ bound: true });
  const r = run('pre-tool-use-edit-subagent', env);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'no agent binding snapshot exists yet');
  writeBindingSnapshot('sess-0001:agent-77', { ticket_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ticket_key: 'LOCAL-x-00000001', binding_revision: 1, gate_enabled: true, project_id: 'demo', revision_committed_at: NOW }, env);
  assert.ok(fs.existsSync(bindingSnapshotPath('sess-0001:agent-77', env)));
  assert.equal(run('pre-tool-use-edit-subagent', env).stdout, '');
  const ev = events(env).at(-1);
  assert.equal(ev.agent_id, 'agent-77');
});

test('PostToolUse for Edit records write paths relative to cwd; git commit output yields commit metadata', () => {
  const env = setup({ bound: true });
  // Fixtures carry Windows-style paths; rebuild them for the current platform so the relative
  // path computation is exercised the way the host would deliver it.
  const repo = path.resolve(os.tmpdir(), 'repo');
  const editInput = fixture('post-tool-use-edit');
  editInput.cwd = repo;
  editInput.tool_input.file_path = path.join(repo, 'src', 'a.js');
  editInput.tool_response.filePath = editInput.tool_input.file_path;
  runHook('PostToolUse', editInput, { env, now: NOW });
  run('post-tool-use-bash-commit', env);
  const edit = events(env).find((e) => e.payload.tool_name === 'Edit');
  const commit = events(env).find((e) => e.payload.tool_name === 'Bash');
  assert.equal(edit.kind, 'post-tool');
  assert.deepEqual(edit.payload.write_paths, ['src/a.js']);
  assert.equal(edit.payload.tool_name, 'Edit');
  assert.equal(edit.source_identity, 'post-tool:sess-0001:toolu_01A');
  assert.equal(commit.payload.commit.sha, '1a2b3c4d');
  assert.equal(commit.payload.commit.message, 'feat: thing');
});

test('ExitPlanMode success stores the plan blob and references it; rejected plans produce no plan_ref', () => {
  const env = setup({ bound: true });
  run('post-tool-use-exit-plan-mode', env);
  const [ev] = events(env);
  assert.ok(ev.payload.plan_ref);
  assert.equal(getBlob(ev.payload.plan_ref, env), '# Plan\n\n1. Write failing test\n2. Implement');
  assert.match(ev.payload.plan_preview, /^# Plan/);
  const env2 = setup({ bound: true });
  run('post-tool-use-exit-plan-mode-rejected', env2);
  assert.equal(events(env2)[0].payload.plan_ref, null);
});

test('Stop persists the full checkpoint blob before the event and extracts conclusions; a missing message is an incomplete capture', () => {
  const env = setup({ bound: true });
  run('stop', env);
  const [ev] = events(env);
  assert.equal(ev.kind, 'stop');
  assert.equal(ev.payload.complete, true);
  assert.equal(getBlob(ev.payload.content_ref, env), fixture('stop').last_assistant_message);
  assert.deepEqual(ev.payload.conclusions, ['the flake came from a shared timer.', 'Use fake timers in tests.']);
  assert.ok(ev.payload.preview.length <= 1500);
  const env2 = setup({ bound: true });
  const r = run('stop-missing-message', env2);
  assert.equal(r.exitCode, 0);
  assert.equal(events(env2)[0].payload.complete, false);
  assert.equal(events(env2)[0].payload.content_ref, null);
});

test('UserPromptSubmit never retains the prompt; title candidate is sanitized to 80 chars; approval candidate only when enabled', () => {
  const env = setup({ bound: true });
  run('user-prompt-submit', env);
  const [ev] = events(env);
  assert.equal(JSON.stringify(ev).includes('flaky retry test in src/retry.js and add coverage'), true, 'title candidate keeps the first 80 chars');
  assert.equal(ev.payload.prompt, undefined);
  assert.ok(ev.payload.title_candidate.length <= 80);
  run('user-prompt-submit-approved', env);
  assert.equal(events(env)[1].payload.approval_candidate, false);
  const env2 = setup({ bound: true, approval: true });
  run('user-prompt-submit-approved', env2);
  assert.equal(events(env2)[0].payload.approval_candidate, true);
});

test('SessionStart injects binding context including the session id; SubagentStart/Stop, PreCompact, SessionEnd and failures map to events', () => {
  const env = setup({ bound: true });
  const r = run('session-start', env);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /LOCAL-x-00000001/);
  assert.match(out.hookSpecificOutput.additionalContext, /sess-0001/);
  run('subagent-start', env);
  run('subagent-stop', env);
  run('pre-compact', env);
  run('post-tool-use-failure', env);
  run('session-end', env);
  const kinds = events(env).map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['pre-compact', 'session-end', 'session-start', 'subagent-start', 'subagent-stop', 'tool-failure']);
  const sub = events(env).find((e) => e.kind === 'subagent-start');
  assert.equal(sub.agent_id, 'agent-77');
  assert.equal(sub.payload.parent_session_id, 'sess-0001');
  const unbound = setup();
  const r2 = run('session-start', unbound);
  assert.match(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext, /unbound/);
});

test('ingress failure never blocks a non-gate hook and never returns a false receipt; covered PreToolUse is denied', () => {
  const env = setup({ bound: true });
  fs.rmSync(path.join(env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(env.QUILL_HOME, 'ingress'), 'blocker');
  const r = run('stop', env);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /capture gap/i);
  assert.equal(r.persisted, false);
  const r2 = run('pre-tool-use-edit', env);
  assert.equal(JSON.parse(r2.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('uninitialized quill stays quiet on tool calls and makes no decision', () => {
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-hook-')) };
  const r = run('pre-tool-use-edit', env);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('hook path stays within budget: 200 bound Edit decisions p95 < 200 ms', () => {
  const env = setup({ bound: true });
  const input = fixture('pre-tool-use-edit');
  const durations = [];
  for (let i = 0; i < 200; i += 1) {
    const started = process.hrtime.bigint();
    runHook('PreToolUse', { ...input, tool_use_id: `toolu_${i}` }, { env, now: NOW });
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.floor(durations.length * 0.95)];
  assert.ok(p95 < 200, `p95 was ${p95.toFixed(1)} ms`);
});
