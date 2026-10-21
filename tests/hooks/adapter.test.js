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

// Live host (Claude Code 2.1, 2026-10-10): the next-prompt suggestion agent fired SubagentStop with
// agent_type "" and no SubagentStart; its message was the user's predicted next prompt.
test('a host helper agent (empty agent_type) is not captured; a real subagent still is', () => {
  const env = setup({ bound: true });
  const helper = { ...fixture('subagent-stop'), agent_id: 'abf8755c1666880f7', agent_type: '', last_assistant_message: 'start on A1–A3 in a worktree' };
  const r = runHook('SubagentStop', helper, { env, now: NOW });
  assert.equal(r.stdout, '');
  assert.deepEqual(events(env), []);
  run('subagent-stop', env);
  assert.deepEqual(events(env).map((e) => e.kind), ['subagent-stop']);
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

// Autonomous runs (spec §4.1): with QUILL_HANDOFF_GUARD set, the per-run guard decides every tool
// call, so the plugin's PreToolUse hook only captures and never returns a permission decision.
const HANDOFF = { QUILL_HANDOFF_ID: 'run-1', QUILL_HANDOFF_TICKET_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', QUILL_HANDOFF_TICKET_KEY: 'LOCAL-x-00000002' };

test('with QUILL_HANDOFF_GUARD set, PreToolUse returns no decision and still captures the call', () => {
  for (const guard of ['enforce', 'observe']) {
    const env = { ...setup({ heartbeat: false }), ...HANDOFF, QUILL_HANDOFF_GUARD: guard };
    for (const name of ['pre-tool-use-edit', 'pre-tool-use-bash-npm', 'pre-tool-use-read']) {
      const r = run(name, env);
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, '', `${guard} ${name}: no permission decision`);
      assert.equal(r.persisted, true);
    }
    const evs = events(env);
    assert.deepEqual(evs.map((e) => e.kind), ['pre-tool', 'pre-tool', 'pre-tool']);
    assert.ok(evs.every((e) => e.payload.denied === false && e.ticket_id === HANDOFF.QUILL_HANDOFF_TICKET_ID));
    assert.equal(evs[0].payload.tool_name, 'Edit');
    assert.equal(evs[0].payload.write_target, 'C:/repo/src/a.js');
  }
});

test('with QUILL_HANDOFF_GUARD set, a capture failure or a missing session id does not deny either', () => {
  const env = { ...setup({ bound: true }), ...HANDOFF, QUILL_HANDOFF_GUARD: 'enforce' };
  const noSession = { ...fixture('pre-tool-use-edit') };
  delete noSession.session_id;
  const r1 = runHook('PreToolUse', noSession, { env, now: NOW });
  assert.equal(r1.stdout, '');
  fs.rmSync(path.join(env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(env.QUILL_HOME, 'ingress'), 'blocker');
  const r2 = run('pre-tool-use-edit', env);
  assert.equal(r2.stdout, '');
  assert.equal(r2.persisted, false);
  assert.match(r2.stderr, /capture gap/i);
});

test('without QUILL_HANDOFF_GUARD (or with it empty) the handoff PreToolUse output is unchanged', () => {
  for (const extra of [{}, { QUILL_HANDOFF_GUARD: '' }]) {
    const env = { ...setup({ heartbeat: false }), ...HANDOFF, ...extra };
    const r = run('pre-tool-use-edit', env);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'stale heartbeat still gates a handoff session');
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /worker unavailable/);
    assert.equal(events(env)[0].payload.denied, true);
  }
});

// The context card (ADR 0038): SessionStart reads the worker's projection, never git, and the hook
// stays within its budget with the extra file read.
test('a bound SessionStart appends the context card the worker wrote, within the hook budget', () => {
  const env = setup({ bound: true });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const home = env.QUILL_HOME;
  fs.mkdirSync(path.join(home, 'projections', 'tickets'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projections', 'context'), { recursive: true });
  fs.writeFileSync(path.join(home, 'projections', 'tickets', `${id}.json`), JSON.stringify({ id, key: 'LOCAL-x-00000001', status: 'active', summary: '', next_action: 'Finish the retry loop', files_touched: [{ relative_path: 'src/a.js', last_seen: NOW }], last_activity: NOW }));
  fs.writeFileSync(path.join(home, 'projections', 'context', `${id}.json`), JSON.stringify({ format: 1, ticket_id: id, co_change: [{ file: 'src/a.js', partner: 'src/b.js', n: 3 }], related: [], guard: [] }));
  const input = fixture('session-start');
  const r = runHook('SessionStart', input, { env, now: NOW });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Next action: Finish the retry loop\. Recently changed: src\/a\.js\. Context: Often changed together: src\/b\.js with src\/a\.js \(3 commits\)\./);
  // A card written for another ticket id is ignored.
  fs.writeFileSync(path.join(home, 'projections', 'context', `${id}.json`), JSON.stringify({ ticket_id: 'other', co_change: [{ file: 'x', partner: 'y', n: 9 }] }));
  assert.doesNotMatch(JSON.parse(runHook('SessionStart', input, { env, now: NOW }).stdout).hookSpecificOutput.additionalContext, / Context: Often/);
  const durations = [];
  for (let i = 0; i < 50; i += 1) {
    const started = process.hrtime.bigint();
    runHook('SessionStart', { ...input, source: `resume-${i}` }, { env, now: NOW });
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.floor(durations.length * 0.95)];
  assert.ok(p95 < 200, `SessionStart p95 was ${p95.toFixed(1)} ms`);
});
