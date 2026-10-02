// Tests pinning the fixes from the whole-branch review (C1, I1–I7). Each failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeNote, parseNote } from '../../src/worker/notes.js';
import { newState, createTicket, ev, resetSeq, bind } from '../core/helpers.js';
import { runHook } from '../../src/hooks/adapter.js';
import { writeRuntimeIdentity, writeHeartbeat, writeBindingSnapshot } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { main } from '../../src/cli/main.js';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { journalPath } from '../../src/lib/paths.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';
import { readHealthErrors } from '../../src/worker/health.js';
import { redactText } from '../../src/export/sanitize.js';
import { allowedToolsFor, childEnvFor } from '../../src/handoff/runner.js';
import { decideGate } from '../../src/gate/decide.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-10-02T08:00:00Z';

function hookHome({ bound = true, hasTitle = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fix-'));
  const env = { TRACKER_HOME: home };
  writeRuntimeIdentity({ store_id: STORE, machine_id: MACHINE, store_path: path.join(home, 'Tracker'), gate_enabled: true, approval_phrases_enabled: false, allow_tools: [] }, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  if (bound) writeBindingSnapshot('sess-1', { session_id: 'ss', ticket_id: T1, ticket_key: 'LOCAL-x-00000001', ticket_title: 'Demo', binding_revision: 1, gate_enabled: true, project_id: 'demo', revision_committed_at: NOW, has_title: hasTitle }, env);
  return env;
}

test('C1: a note converted to CRLF (or otherwise unrecognized) is a conflict, never overwritten', () => {
  const state = newState();
  const t = createTicket(state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-crlf-'));
  const file = path.join(dir, `${t.key}.md`);
  const index = {};
  writeNote(file, t, { state, index });
  const original = fs.readFileSync(file, 'utf8');
  const crlf = original.replace(/\n/g, '\r\n').replace('## Summary\r\n\r\n', '## Summary\r\n\r\nUser wrote this after an editor converted line endings.\r\n\r\n');
  fs.writeFileSync(file, crlf);
  t.next_action = 'changed';
  const outcome = writeNote(file, t, { state, index });
  assert.equal(outcome, 'conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), crlf, 'file untouched');
  assert.ok(t.validation_issues.some((i) => /generated-/.test(i)), 'conflict reason recorded');
  const parsed = parseNote(crlf);
  assert.match(parsed.authored.summary, /User wrote this/, 'CRLF files still parse so authored text is recoverable');
  // Entirely unrecognized layout (no markers, no frontmatter) must also never be overwritten.
  fs.writeFileSync(file, 'Just some notes the user wrote by hand.\n');
  assert.equal(writeNote(file, t, { state, index }), 'conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), 'Just some notes the user wrote by hand.\n');
  assert.ok(t.validation_issues.includes('note-layout-unrecognized'));
});

test('I1: the gate fails closed for covered tools on malformed input, hook exceptions and capture failure (not only Edit-family tools)', async () => {
  const env = hookHome({ bound: true });
  let out = '';
  const code = await main(['hook', 'PreToolUse'], { env, stdout: (s) => { out += s; }, stderr: () => {}, stdin: async () => '{not json' });
  assert.equal(code, 0);
  assert.match(out, /"permissionDecision":"deny"/, 'malformed input denies the covered call it cannot evaluate');
  out = '';
  await main(['hook', 'PreToolUse'], { env, stdout: (s) => { out += s; }, stderr: () => {}, stdin: async () => JSON.stringify({ session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }) });
  assert.equal(out, '', 'reads still pass through on the same input shape');
  fs.rmSync(path.join(env.TRACKER_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(env.TRACKER_HOME, 'ingress'), 'blocker');
  const bash = runHook('PreToolUse', { session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 't1' }, { env, now: NOW });
  assert.match(bash.stdout, /"deny"/, 'bound Bash with failed capture is denied');
  const mcp = runHook('PreToolUse', { session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'mcp__jira__create', tool_input: {}, tool_use_id: 't2' }, { env, now: NOW });
  assert.match(mcp.stdout, /"deny"/);
  const read = runHook('PreToolUse', { session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 't3' }, { env, now: NOW });
  assert.equal(read.stdout, '');
  const noSession = runHook('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 't4' }, { env: hookHome(), now: NOW });
  assert.match(noSession.stdout, /"deny"/, 'missing identity denies every covered tool');
});

test('I2: only the first prompt of a session contributes a title; later prompts persist no text', () => {
  const fresh = hookHome({ bound: true, hasTitle: false });
  runHook('UserPromptSubmit', { session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'Fix the flaky retry test' }, { env: fresh, now: NOW });
  assert.equal(listIngress(fresh)[0].event.payload.title_candidate, 'Fix the flaky retry test');
  const titled = hookHome({ bound: true, hasTitle: true });
  runHook('UserPromptSubmit', { session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'Now do something secret' }, { env: titled, now: NOW });
  const ev2 = listIngress(titled)[0].event;
  assert.equal(ev2.payload.title_candidate, null);
  assert.equal(JSON.stringify(ev2).includes('secret'), false);
  assert.equal(typeof ev2.payload.length, 'number');
});

test('I3: a malformed journaled event is rejected and recorded, never a poison pill that stops the worker', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-poison-'));
  const storePath = path.join(home, 'Tracker');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Tracker', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] } } };
  const env = { TRACKER_HOME: home };
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: NOW, ...extra });
  const lines = [
    mk('ticket-create', { ticket: { id: T1, key: 'LOCAL-a-00000001', title: 'A', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }),
    mk('session-start', { source: 'startup' }, { session_id: 'h1' }),
    mk('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'h1' }),
    mk('pre-tool', { tool_name: 'Bash' }, { session_id: 'h1', tool_call_id: 'c1', source_identity: 'pre:h1:c1' }),
    mk('post-tool', { tool_name: 'Bash', commit: { sha: 5 }, success: true }, { session_id: 'h1', tool_call_id: 'c1', source_identity: 'post:h1:c1' }),
    // an import that violates an invariant (blocked without blocker) throws inside the reducer
    mk('import', { ticket_id: T1, fields: { status: 'blocked' } }),
    mk('ticket-update', { ticket_id: T1, fields: { next_action: 'after the bad one' }, source: 'manual' }),
  ].map((e, i) => JSON.stringify({ ...e, sequence: i + 1, ingested_at: NOW }));
  fs.mkdirSync(path.dirname(journalPath(env)), { recursive: true });
  fs.writeFileSync(journalPath(env), lines.join('\n') + '\n');
  const w = new Worker({ config, storeMeta: meta, env });
  await w.start();
  try {
    assert.equal(w.state.tickets.get(T1).next_action, 'after the bad one', 'events after the malformed one still apply');
    assert.equal(w.state.tickets.get(T1).status, 'todo', 'the invalid import was not half-applied');
    assert.ok(readHealthErrors(env).some((e) => e.kind === 'apply-error' && e.event_kind === 'import'), 'the rejected event is visible as a health error');
    // live ingestion of malformed or invariant-breaking events does not stop the loop either
    const { writeIngress } = await import('../../src/core/ingress.js');
    writeIngress(mk('post-tool', { tool_name: 'Bash', commit: { sha: { nested: true } }, success: true }, { session_id: 'h1', tool_call_id: 'c2', source_identity: 'post:h1:c2' }), env);
    writeIngress(mk('pre-tool', { tool_name: 'Bash' }, { session_id: 'h1', tool_call_id: 'c2', source_identity: 'pre:h1:c2' }), env);
    writeIngress(mk('import', { ticket_id: T1, fields: { parent_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }), env);
    writeIngress(mk('ticket-update', { ticket_id: T1, fields: { next_action: 'still alive' }, source: 'manual' }), env);
    w.tick();
    assert.equal(w.state.tickets.get(T1).next_action, 'still alive');
    assert.equal(w.state.tickets.get(T1).parent_id, null);
    assert.equal(listIngress(env).length, 0);
    assert.ok(readHealthErrors(env).filter((e) => e.kind === 'apply-error').length >= 2);
  } finally {
    await w.stop();
  }
  const w2 = new Worker({ config, storeMeta: meta, env });
  await w2.start();
  assert.equal(w2.state.tickets.get(T1).next_action, 'still alive', 'restart replays deterministically');
  await w2.stop();
});

test('I4: export redaction covers any absolute path, not just a fixed list of roots, while leaving URLs intact', () => {
  const redacted = redactText('see /srv/work/repo/file.js and /workspace/x/y.ts and /data/dump.sql plus C:\\code\\repo\\a.js and https://github.com/acme/demo/pull/5 ok');
  assert.equal(/\/srv\/|\/workspace\/|\/data\/|C:\\\\code|C:\\code/.test(redacted), false, redacted);
  assert.match(redacted, /https:\/\/github\.com\/acme\/demo\/pull\/5/);
  assert.equal(redactText('ratio 1/2 and src/a.js are not absolute'), 'ratio 1/2 and src/a.js are not absolute');
});

test('I5: attempt-fix tools never grant arbitrary code execution shortcuts, and the agent environment carries no push credentials unless push is permitted', () => {
  const fix = allowedToolsFor({ mode: 'attempt-fix', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false } });
  for (const bad of ['Bash(node *)', 'Bash(npm run*)']) assert.equal(fix.allowed.includes(bad), false, `${bad} must not be allowed`);
  assert.ok(fix.allowed.some((t) => /npm test|node --test/.test(t)));
  const env = childEnvFor({ read_source: true, edit_source: true, commit: true, push_branch: false, open_draft_pr: false }, { GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GIT_ASKPASS: '/bin/ask', PATH: 'p' });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, 'echo');
  const pushEnv = childEnvFor({ read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }, { GH_TOKEN: 'x', PATH: 'p' });
  assert.equal(pushEnv.GH_TOKEN, 'x', 'explicit push/PR permission keeps the credentials');
});

test('I6: the plan-file claim accepts only a Write of a .md file directly inside the plan directory', () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plan-'));
  const env = { ...hookHome({ bound: false }), CLAUDE_PLANS_DIR: planDir };
  const h = (tool_name, file) => runHook('PreToolUse', { session_id: 'plan-s', hook_event_name: 'PreToolUse', permission_mode: 'plan', tool_name, tool_input: { file_path: file, content: 'x' }, tool_use_id: `p-${Math.random()}` }, { env, now: NOW });
  assert.match(h('Write', path.join(planDir, 'script.sh')).stdout, /"deny"/, 'non-markdown files are never plan files');
  assert.match(h('Edit', path.join(planDir, 'first.md')).stdout, /"deny"/, 'an Edit cannot establish the claim');
  assert.equal(h('Write', path.join(planDir, 'first.md')).stdout, '', 'the first Write of a .md in the plan dir is the session plan');
  assert.match(h('Write', path.join(planDir, 'second.md')).stdout, /"deny"/);
  const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
  assert.match(readme, /plan/i);
  assert.ok(fs.existsSync(path.resolve('docs/decisions/0004-plan-path-first-claim.md')));
  assert.equal(decideGate({ tool_name: 'Write', tool_input: { file_path: path.join(planDir, 'first.md') }, binding: { ticket_id: null }, workerHealthy: true, gateEnabled: true, planPath: path.join(planDir, 'first.md'), hostPlanDir: planDir }).decision, 'none');
});

test('I7: dashboard edits applied through request transactions count as substantive activity', () => {
  resetSeq();
  const state = newState();
  const t = createTicket(state, { status: 'active', at: '2026-09-20T08:00:00Z' });
  ev(state, 'request', { id: '44444444-0000-4000-8000-000000000001', kind: 'set-next-action', target_id: T1, expected_revision: t.revision, payload: { next_action: 'triaged from the board' }, created_at: '2026-10-02T09:00:00Z', not_before: '2026-10-02T09:00:10Z', actor_id: 'owner' }, { occurred_at: '2026-10-02T09:00:00Z' });
  ev(state, 'request-tx', { request_id: '44444444-0000-4000-8000-000000000001', outcome: 'applied', mutation: { type: 'ticket-fields', ticket_id: T1, fields: { next_action: 'triaged from the board' } } }, { occurred_at: '2026-10-02T09:00:10Z' });
  assert.equal(t.next_action, 'triaged from the board');
  assert.equal(t.last_activity, '2026-10-02T09:00:10Z');
  void bind;
});
