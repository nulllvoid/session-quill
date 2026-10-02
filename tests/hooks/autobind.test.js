import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHook } from '../../src/hooks/adapter.js';
import { planAutoBind } from '../../src/hooks/autobind.js';
import { writeBindingSnapshot, readBindingSnapshot, bindingSnapshotPath, writeHeartbeat, writeRuntimeIdentity } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';
import { normalizeTracker, externalTicketId } from '../../src/core/external-keys.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-10-02T08:00:00Z';
const TRACKER = normalizeTracker({ system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PMLA', 'PC'] });

function setup({ mode = 'nudge', tracker = TRACKER, branch = null, bound = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-auto-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-autorepo-'));
  if (branch) {
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  }
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: STORE, machine_id: MACHINE, store_path: path.join(home, 'Quill'), gate_enabled: true, gate_mode: mode, approval_phrases_enabled: false, allow_tools: [], tracker: null, default_project_id: 'demo', repos: [{ repo_id: 'demo', path: repo, project_id: 'demo', gate_mode: mode, tracker }] }, env);
  writeHeartbeat({ at: NOW, pid: 1, store_id: STORE }, env);
  if (bound) writeBindingSnapshot('s1', { session_id: 'x', ticket_id: T1, ticket_key: bound, ticket_title: 'Old', ticket_aliases: [], binding_revision: 1, gate_enabled: true, project_id: 'demo', has_title: true }, env);
  return { env, repo };
}

const hook = (fx, name, extra = {}) => runHook(name, { session_id: 's1', cwd: fx.repo, hook_event_name: name, permission_mode: 'default', ...extra }, { env: fx.env, now: NOW });
const binds = (fx) => listIngress(fx.env).map((x) => x.event).filter((e) => e.kind === 'bind');
const context = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test('a prompt mentioning a configured key links an unbound session before its next tool call', () => {
  const fx = setup({ mode: 'strict' });
  const r = hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-1234: fix the flaky retry test' });
  assert.match(context(r), /Linked to PMLA-1234/);
  const [bind] = binds(fx);
  assert.deepEqual(bind.payload.external, { system: 'jira', key: 'PMLA-1234', url: 'https://example.atlassian.net/browse/PMLA-1234' });
  assert.deepEqual([bind.payload.source, bind.payload.title_hint, bind.payload.project_id, bind.payload.repo_id, bind.payload.ensure_only], ['prompt', 'PMLA-1234: fix the flaky retry test', 'demo', 'demo', false]);
  const snap = readBindingSnapshot('s1', fx.env);
  assert.deepEqual([snap.provisional, snap.provisional_event_id, snap.ticket_key, snap.ticket_id, snap.binding_revision], [true, bind.event_id, 'PMLA-1234', externalTicketId(STORE, 'PMLA-1234'), 1]);
  const pre = hook(fx, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'u1', tool_input: { file_path: path.join(fx.repo, 'a.js') } });
  assert.equal(pre.stdout, '', 'the strict gate already sees the binding');
  const preEv = listIngress(fx.env).map((x) => x.event).find((e) => e.kind === 'pre-tool');
  assert.equal(preEv.ticket_id, externalTicketId(STORE, 'PMLA-1234'));
});

test('other prefixes, non-ticket tokens, missing tracker config and unregistered directories never bind', () => {
  const fx = setup();
  hook(fx, 'UserPromptSubmit', { prompt: 'Upgrade to UTF-8 and look at ABC-12' });
  assert.equal(binds(fx).length, 0);
  const none = setup({ tracker: null });
  hook(none, 'UserPromptSubmit', { prompt: 'PMLA-1 please' });
  assert.equal(binds(none).length, 0);
  hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-1 please', cwd: os.tmpdir() });
  assert.equal(binds(fx).length, 0);
});

test('a bound session switches on a new key by default, keeps its key when it is mentioned, and honours add and ignore', () => {
  const fx = setup({ bound: 'PMLA-1' });
  hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-1 depends on PMLA-2' });
  assert.equal(binds(fx).length, 0, 'the current key is mentioned, so nothing changes');
  hook(fx, 'UserPromptSubmit', { prompt: 'now look at PMLA-2' });
  assert.equal(binds(fx).length, 1);
  assert.equal(readBindingSnapshot('s1', fx.env).binding_revision, 2);
  const add = setup({ bound: 'PMLA-1', tracker: normalizeTracker({ prefixes: ['PMLA'], on_new_key: 'add' }) });
  hook(add, 'UserPromptSubmit', { prompt: 'see PMLA-3' });
  assert.equal(binds(add)[0].payload.ensure_only, true);
  assert.equal(readBindingSnapshot('s1', add.env).ticket_key, 'PMLA-1', 'add never rebinds');
  const ignore = setup({ bound: 'PMLA-1', tracker: normalizeTracker({ prefixes: ['PMLA'], on_new_key: 'ignore' }) });
  hook(ignore, 'UserPromptSubmit', { prompt: 'see PMLA-3' });
  assert.equal(binds(ignore).length, 0);
});

test('SessionStart links from the branch name when unbound and never switches an existing binding', () => {
  const fx = setup({ branch: 'feat/pmla-77-retry-flake' });
  const r = hook(fx, 'SessionStart', { source: 'startup' });
  assert.match(context(r), /Bound to PMLA-77 \(retry flake\)/);
  assert.deepEqual([binds(fx)[0].payload.source, binds(fx)[0].payload.title_hint], ['branch', 'retry flake']);
  const kept = setup({ branch: 'feat/PMLA-77-x', bound: 'PMLA-1' });
  hook(kept, 'SessionStart', { source: 'resume' });
  assert.equal(binds(kept).length, 0);
});

test('a session the worker has never seen gets its session id on the first prompt', () => {
  const fx = setup();
  assert.match(context(hook(fx, 'UserPromptSubmit', { prompt: 'hello' })), /Session Quill session: s1\..*Mention a ticket key \(for example PMLA-123\)/);
  const bound = setup({ bound: 'PMLA-1' });
  assert.equal(hook(bound, 'UserPromptSubmit', { prompt: 'hello' }).stdout, '');
});

test('if the bind event cannot be persisted the provisional snapshot is rolled back', () => {
  const fx = setup();
  fs.rmSync(path.join(fx.env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(fx.env.QUILL_HOME, 'ingress'), 'blocker');
  hook(fx, 'UserPromptSubmit', { prompt: 'PMLA-5 go' });
  assert.equal(fs.existsSync(bindingSnapshotPath('s1', fx.env)), false);
  const bound = setup({ bound: 'PMLA-1' });
  fs.rmSync(path.join(bound.env.QUILL_HOME, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(bound.env.QUILL_HOME, 'ingress'), 'blocker');
  hook(bound, 'UserPromptSubmit', { prompt: 'PMLA-5 go' });
  assert.equal(readBindingSnapshot('s1', bound.env).ticket_key, 'PMLA-1');
});

test('planAutoBind: branches never switch, sources are honoured, the first new key wins, aliases count as bound', () => {
  assert.deepEqual(planAutoBind({ source: 'prompt', text: 'PC-1 and PMLA-2', snapshot: null, tracker: TRACKER }), { key: 'PC-1', ensure_only: false });
  assert.equal(planAutoBind({ source: 'branch', text: 'PMLA-2', snapshot: { ticket_id: T1, ticket_key: 'PMLA-1' }, tracker: TRACKER }), null);
  assert.equal(planAutoBind({ source: 'prompt', text: 'PMLA-2', snapshot: null, tracker: normalizeTracker({ prefixes: ['PMLA'], sources: ['branch'] }) }), null);
  assert.equal(planAutoBind({ source: 'prompt', text: 'see OLD-1', snapshot: { ticket_id: T1, ticket_key: 'PMLA-1', ticket_aliases: ['OLD-1'] }, tracker: normalizeTracker({ prefixes: ['PMLA', 'OLD'] }) }), null);
});

test('prompt scanning with auto-binding stays within the hook budget', () => {
  const fx = setup();
  const durations = [];
  const prompt = `PMLA-42 ${'context '.repeat(500)}`;
  for (let i = 0; i < 100; i += 1) {
    const started = process.hrtime.bigint();
    runHook('UserPromptSubmit', { session_id: `perf-${i}`, cwd: fx.repo, hook_event_name: 'UserPromptSubmit', prompt }, { env: fx.env, now: NOW });
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  durations.sort((a, b) => a - b);
  assert.ok(durations[94] < 200, `p95 ${durations[94].toFixed(1)} ms`);
});
