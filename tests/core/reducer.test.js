import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey } from '../../src/core/state.js';
import { newState, createTicket, bind, ev, resetSeq } from './helpers.js';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => resetSeq());

function writeCycle(state, session_id, tool_call_id, file, { at = '2026-10-02T08:05:00Z', agent_id = null, event_id } = {}) {
  ev(state, 'pre-tool', { tool_name: 'Edit', write_target: file }, { session_id, agent_id, tool_call_id, occurred_at: at });
  return ev(state, 'post-tool', { tool_name: 'Edit', write_paths: [file], repo_id: 'demo', success: true }, { session_id, agent_id, tool_call_id, occurred_at: at, source_identity: `post-tool:${session_id}:${tool_call_id}`, ...(event_id ? { event_id } : {}) });
}

test('ticket-create registers key index and defaults; duplicate key is rejected as a validation issue', () => {
  const state = newState();
  const t = createTicket(state);
  assert.equal(state.keyIndex.get(t.key), t.id);
  assert.equal(t.status, 'todo');
  assert.equal(t.revision, 1);
  assert.deepEqual(t.tags, ['quill/status/todo', 'quill/cat/feature']);
  const r = ev(state, 'ticket-create', { ticket: { id: T2, key: t.key, title: 'dup', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } });
  assert.equal(r.rejected, 'key-collision');
  assert.equal(state.tickets.has(T2), false);
});

test('bind closes the previous interval, increments revision and records ticket session membership', () => {
  const state = newState();
  createTicket(state);
  createTicket(state, { id: T2, key: 'LOCAL-two-00000002' });
  const s = bind(state, 'host-1', T1);
  assert.equal(s.current_binding_revision, 1);
  assert.equal(s.current_ticket_id, T1);
  ev(state, 'bind', { ticket_id: T2, project_id: 'demo' }, { session_id: 'host-1', occurred_at: '2026-10-02T08:10:00Z' });
  assert.equal(s.current_binding_revision, 2);
  assert.equal(s.bindings[0].unbound_at, '2026-10-02T08:10:00Z');
  assert.equal(s.bindings[1].ticket_id, T2);
  assert.deepEqual(s.ticket_ids, [T1, T2]);
  assert.ok(state.tickets.get(T1).session_ids.includes(s.id));
  assert.ok(state.tickets.get(T2).session_ids.includes(s.id));
});

test('duplicate event_id and duplicate source_identity have exactly one effect', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'host-1', T1);
  const first = writeCycle(state, 'host-1', 'toolu_1', 'src/a.js');
  assert.equal(first.changed.has(T1), true);
  const s = state.sessions.get(sessionKey({ session_id: 'host-1' }));
  assert.equal(s.successful_write_count, 1);
  ev(state, 'post-tool', { tool_name: 'Edit', write_paths: ['src/a.js'], repo_id: 'demo', success: true }, { session_id: 'host-1', tool_call_id: 'toolu_1', source_identity: 'post-tool:host-1:toolu_1' });
  assert.equal(s.successful_write_count, 1);
  assert.equal(state.tickets.get(T1).timeline.filter((e) => e.kind === 'write').length, 1);
  assert.equal(state.tickets.get(T1).files_touched_count, 1);
});

test('post-tool without a pre-tool record is deferred, never attributed to the current binding, and becomes unresolved after one reconciliation', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'host-1', T1);
  const r = ev(state, 'post-tool', { tool_name: 'Edit', write_paths: ['src/x.js'], success: true }, { session_id: 'host-1', tool_call_id: 'toolu_missing' });
  assert.equal(r.deferred, true);
  assert.equal(state.unresolved.length, 0);
  assert.equal(state.tickets.get(T1).timeline.some((e) => e.kind === 'write' || e.kind === 'tool'), false, 'no write or tool entry attributed');
  assert.equal(state.tickets.get(T1).files_touched_count, 0);
  ev(state, 'reconcile', { last_sync: '2026-10-02T10:00:00Z', provider_health: [] }, { occurred_at: '2026-10-02T10:00:00Z' });
  assert.equal(state.unresolved.length, 1);
  assert.equal(state.unresolved[0].reason, 'missing-pre-tool');
  assert.equal(state.tickets.get(T1).files_touched_count, 0);
});

test('a result that arrives before its pre-tool record is applied once the attribution record lands', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'host-1', T1);
  ev(state, 'post-tool', { tool_name: 'Edit', write_paths: ['src/early.js'], repo_id: 'demo', success: true }, { session_id: 'host-1', tool_call_id: 'toolu_early', occurred_at: '2026-10-02T08:05:00Z' });
  assert.equal(state.tickets.get(T1).files_touched_count, 0);
  ev(state, 'pre-tool', { tool_name: 'Edit', write_target: 'src/early.js' }, { session_id: 'host-1', tool_call_id: 'toolu_early', occurred_at: '2026-10-02T08:05:00Z' });
  assert.equal(state.tickets.get(T1).files_touched_count, 1);
  assert.equal(state.sessions.get(sessionKey({ session_id: 'host-1' })).successful_write_count, 1);
  ev(state, 'reconcile', { last_sync: '2026-10-02T10:00:00Z', provider_health: [] }, { occurred_at: '2026-10-02T10:00:00Z' });
  assert.equal(state.unresolved.length, 0);
});

test('rebind while a tool is in flight keeps the result on the original ticket', () => {
  const state = newState();
  createTicket(state);
  createTicket(state, { id: T2, key: 'LOCAL-two-00000002' });
  bind(state, 'host-1', T1);
  ev(state, 'pre-tool', { tool_name: 'Write', write_target: 'src/b.js' }, { session_id: 'host-1', tool_call_id: 'toolu_2', occurred_at: '2026-10-02T08:05:00Z' });
  ev(state, 'bind', { ticket_id: T2, project_id: 'demo' }, { session_id: 'host-1', occurred_at: '2026-10-02T08:05:30Z' });
  ev(state, 'post-tool', { tool_name: 'Write', write_paths: ['src/b.js'], repo_id: 'demo', success: true }, { session_id: 'host-1', tool_call_id: 'toolu_2', occurred_at: '2026-10-02T08:06:00Z' });
  assert.equal(state.tickets.get(T1).files_touched_count, 1);
  assert.equal(state.tickets.get(T2).files_touched_count, 0);
  const write = state.tickets.get(T1).timeline.find((e) => e.kind === 'write');
  assert.ok(write);
});

test('first successful write promotes todo -> active and updates last_activity', () => {
  const state = newState();
  const t = createTicket(state);
  bind(state, 'host-1', T1);
  writeCycle(state, 'host-1', 'toolu_3', 'src/c.js', { at: '2026-10-02T09:00:00Z' });
  assert.equal(t.status, 'active');
  assert.equal(t.last_activity, '2026-10-02T09:00:00Z');
  assert.equal(t.revision > 1, true);
});

test('a subagent inherits the parent binding at launch and a later parent rebind is not retroactive', () => {
  const state = newState();
  createTicket(state);
  createTicket(state, { id: T2, key: 'LOCAL-two-00000002' });
  bind(state, 'host-1', T1);
  ev(state, 'subagent-start', { agent_id: 'agent-9', agent_type: 'Explore', parent_session_id: 'host-1' }, { session_id: 'host-1', agent_id: 'agent-9' });
  const sub = state.sessions.get(sessionKey({ session_id: 'host-1', agent_id: 'agent-9' }));
  assert.equal(sub.current_ticket_id, T1);
  assert.equal(sub.parent_session_id, state.sessions.get(sessionKey({ session_id: 'host-1' })).id);
  ev(state, 'bind', { ticket_id: T2, project_id: 'demo' }, { session_id: 'host-1' });
  assert.equal(sub.current_ticket_id, T1);
  writeCycle(state, 'host-1', 'toolu_sub', 'src/sub.js', { agent_id: 'agent-9' });
  assert.equal(state.tickets.get(T1).files_touched_count, 1);
  assert.equal(state.tickets.get(T2).files_touched_count, 0);
});

test('stop stores a checkpoint with a 1500-char preview and marks the session unpromoted; failures are partial coverage', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'host-1', T1);
  const longPreview = 'x'.repeat(1500);
  ev(state, 'stop', { content_ref: 'c'.repeat(64), preview: longPreview, length: 5000, complete: true, conclusions: ['Conclusion: works'] }, { session_id: 'host-1', occurred_at: '2026-10-02T08:30:00Z' });
  const s = state.sessions.get(sessionKey({ session_id: 'host-1' }));
  const cp = state.checkpoints.get(s.last_checkpoint_id);
  assert.equal(cp.preview.length, 1500);
  assert.equal(cp.content_ref, 'c'.repeat(64));
  assert.equal(cp.ticket_id, T1);
  assert.equal(s.unpromoted, true);
  assert.equal(state.tickets.get(T1).conclusions.length, 1);
  ev(state, 'pre-tool', { tool_name: 'Bash', write_target: 'npm test' }, { session_id: 'host-1', tool_call_id: 'toolu_f' });
  ev(state, 'tool-failure', { tool_name: 'Bash', error: 'exit 1' }, { session_id: 'host-1', tool_call_id: 'toolu_f' });
  assert.equal(s.change_coverage, 'partial');
  assert.equal(state.tickets.get(T1).timeline.at(-1).coverage, 'partial');
  assert.equal(s.successful_write_count, 0);
});

test('explicit approval promotes a checkpoint once; duplicate approval is idempotent', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'host-1', T1);
  ev(state, 'stop', { content_ref: 'd'.repeat(64), preview: 'plan', length: 4, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:30:00Z' });
  const s = state.sessions.get(sessionKey({ session_id: 'host-1' }));
  const cp = s.last_checkpoint_id;
  ev(state, 'approve', { checkpoint_id: cp, ticket_id: T1, provenance: 'explicit' }, { session_id: 'host-1' });
  ev(state, 'approve', { checkpoint_id: cp, ticket_id: T1, provenance: 'explicit' }, { session_id: 'host-1' });
  const t = state.tickets.get(T1);
  assert.equal(t.plans.length, 1);
  assert.equal(t.plans_count, 1);
  assert.equal(t.plans[0].provenance, 'explicit');
  assert.equal(state.checkpoints.get(cp).approved_at !== null, true);
  assert.equal(s.unpromoted, false);
});

test('heuristic approval never fires when disabled, and only on the same binding within 10 minutes when enabled', () => {
  const off = newState();
  createTicket(off);
  bind(off, 'host-1', T1);
  ev(off, 'stop', { content_ref: 'e'.repeat(64), preview: 'p', length: 1, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:30:00Z' });
  ev(off, 'prompt', { title_candidate: null, approval_candidate: false }, { session_id: 'host-1', occurred_at: '2026-10-02T08:31:00Z' });
  assert.equal(off.tickets.get(T1).plans.length, 0);

  const on = newState({ approval_phrases_enabled: true });
  createTicket(on);
  createTicket(on, { id: T2, key: 'LOCAL-two-00000002' });
  bind(on, 'host-1', T1);
  ev(on, 'stop', { content_ref: 'e'.repeat(64), preview: 'p', length: 1, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:30:00Z' });
  ev(on, 'prompt', { title_candidate: null, approval_candidate: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:41:00Z' });
  assert.equal(on.tickets.get(T1).plans.length, 0, 'late prompt does not approve');
  ev(on, 'stop', { content_ref: 'f'.repeat(64), preview: 'q', length: 1, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:50:00Z' });
  ev(on, 'bind', { ticket_id: T2, project_id: 'demo' }, { session_id: 'host-1', occurred_at: '2026-10-02T08:51:00Z' });
  ev(on, 'prompt', { title_candidate: null, approval_candidate: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:52:00Z' });
  assert.equal(on.tickets.get(T1).plans.length, 0, 'different binding does not approve');
  ev(on, 'stop', { content_ref: 'g'.repeat(64), preview: 'r', length: 1, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T09:00:00Z' });
  ev(on, 'prompt', { title_candidate: null, approval_candidate: true }, { session_id: 'host-1', occurred_at: '2026-10-02T09:05:00Z' });
  assert.equal(on.tickets.get(T2).plans.length, 1);
  assert.equal(on.tickets.get(T2).plans[0].provenance, 'heuristic');
});

test('gate-off/gate-on toggle the session flag and leave an audit timeline entry; session-end marks ended', () => {
  const state = newState();
  createTicket(state);
  const s = bind(state, 'host-1', T1);
  ev(state, 'gate-off', {}, { session_id: 'host-1' });
  assert.equal(s.gate_enabled, false);
  assert.ok(state.tickets.get(T1).timeline.some((e) => e.kind === 'status' && /gate off/.test(e.text)));
  ev(state, 'gate-on', {}, { session_id: 'host-1' });
  assert.equal(s.gate_enabled, true);
  ev(state, 'session-end', { reason: 'other' }, { session_id: 'host-1', occurred_at: '2026-10-02T10:00:00Z' });
  assert.equal(s.ended_at, '2026-10-02T10:00:00Z');
  assert.equal(s.state, 'ended');
});

test('relink changes the displayed key, keeps the id, adds an alias atomically and rejects collisions', () => {
  const state = newState();
  const t = createTicket(state);
  createTicket(state, { id: T2, key: 'PMLA-42' });
  const r = ev(state, 'relink', { ticket_id: T1, new_key: 'PMLA-42', jira: { key: 'PMLA-42', url: null, validation: 'pending', validated_at: null, error: 'offline' } });
  assert.equal(r.rejected, 'key-collision');
  assert.equal(t.key, 'LOCAL-demo-ticket-00000001');
  ev(state, 'relink', { ticket_id: T1, new_key: 'PMLA-43', jira: { key: 'PMLA-43', url: null, validation: 'pending', validated_at: null, error: 'offline' } });
  assert.equal(t.key, 'PMLA-43');
  assert.deepEqual(t.aliases, ['LOCAL-demo-ticket-00000001']);
  assert.equal(state.keyIndex.get('LOCAL-demo-ticket-00000001'), T1);
  assert.equal(state.keyIndex.get('PMLA-43'), T1);
  assert.equal(t.jira.validation, 'pending');
});

test('ticket-update applies supported fields with revision increments and manual status floors; reconcile does not touch last_activity', () => {
  const state = newState();
  const t = createTicket(state);
  const rev = t.revision;
  ev(state, 'ticket-update', { ticket_id: T1, fields: { next_action: 'Verify restart', status: 'blocked', blocker: 'infra' }, source: 'manual' }, { occurred_at: '2026-10-02T08:30:00Z' });
  assert.equal(t.next_action, 'Verify restart');
  assert.equal(t.status, 'blocked');
  assert.equal(t.revision, rev + 1);
  assert.equal(t.last_activity, '2026-10-02T08:30:00Z');
  ev(state, 'reconcile', { last_sync: '2026-10-03T08:30:00Z', provider_health: [] }, { occurred_at: '2026-10-03T08:30:00Z' });
  assert.equal(t.last_activity, '2026-10-02T08:30:00Z');
  assert.equal(state.lastSync, '2026-10-03T08:30:00Z');
});

test('ticket-update links a ticket to a registered repository, clears it with null and rejects unknown ids', () => {
  const state = newState({ repos: { demo: { project_id: 'demo' }, other: { project_id: 'demo' } } });
  const t = createTicket(state);
  ev(state, 'ticket-update', { ticket_id: T1, fields: { repo_id: 'other' }, source: 'manual' });
  assert.equal(t.repo_id, 'other');
  ev(state, 'ticket-update', { ticket_id: T1, fields: { repo_id: null }, source: 'manual' });
  assert.equal(t.repo_id, null);
  const r = ev(state, 'ticket-update', { ticket_id: T1, fields: { repo_id: 'missing', title: 'Renamed' }, source: 'manual' });
  assert.equal(r.rejected, 'repo-unknown');
  assert.equal(t.repo_id, null);
  assert.equal(t.title, 'Demo ticket');
});

test('children_ids is derived from parent links and children_done_count counts done children', () => {
  const state = newState();
  createTicket(state);
  createTicket(state, { id: T2, key: 'LOCAL-demo-ticket-00000001.1', parent_id: T1, status: 'done' });
  const parent = state.tickets.get(T1);
  assert.deepEqual(parent.children_ids, [T2]);
  assert.equal(parent.children_done_count, 1);
});

// ---- Ticket worktrees (ADR 0036)
import { makeEvent } from '../../src/core/events.js';
import { applyEvent } from '../../src/core/reducer.js';
import { worktreeIdentity, teardownPlan, ticketWorktreeDir } from '../../src/core/worktrees.js';
import { STORE, MACHINE } from './helpers.js';

const WT = 'C:/quill-home/worktrees/demo/LOCAL-demo-ticket-00000001';
const SHA = 'a'.repeat(40);
const M1 = '11111111-0000-4000-8000-000000000001';
const M2 = '11111111-0000-4000-8000-000000000002';
const M3 = '11111111-0000-4000-8000-000000000003';
const wtPayload = (op, extra = {}) => ({ op, mount_id: M1, ticket_id: T1, repo_id: 'demo', path: WT, branch: 'quill/LOCAL-demo-ticket-00000001', base_sha: SHA, ...extra });
const wtEvent = (payload, at = '2026-10-02T09:00:00Z', producer = 'cli') => {
  const e = makeEvent({ kind: 'worktree', payload, store_id: STORE, machine_id: MACHINE, producer, occurred_at: at, ticket_id: payload.ticket_id, source_identity: worktreeIdentity(payload) });
  e.sequence = 1; e.ingested_at = at;
  return e;
};

test('worktree events record mounted, kept and pruned on the ticket without bumping its revision; replay is idempotent', () => {
  const state = newState();
  const t = createTicket(state);
  const revision = t.revision;
  const mounted = wtEvent(wtPayload('mounted'));
  assert.equal(applyEvent(state, mounted).rejected, undefined);
  assert.deepEqual(t.worktrees.map((w) => [w.id, w.state, w.path, w.mounted_at]), [[M1, 'mounted', WT, '2026-10-02T09:00:00Z']]);
  assert.equal(t.revision, revision, 'machine state, not an owner edit');
  assert.equal(applyEvent(state, mounted).duplicate, true);
  assert.equal(applyEvent(state, wtEvent(wtPayload('mounted', { mount_id: M2 }))).rejected, undefined, 'the same folder mounted again is one record');
  assert.equal(t.worktrees.length, 1);
  const kept = wtEvent(wtPayload('kept', { reason: 'uncommitted-changes' }), '2026-10-10T09:00:00Z', 'worker');
  assert.ok(applyEvent(state, kept).changed.has(T1));
  assert.deepEqual([t.worktrees[0].state, t.worktrees[0].kept_reason], ['kept', 'uncommitted-changes']);
  assert.equal(applyEvent(state, { ...kept, event_id: '33333333-0000-4000-8000-000000000001' }).duplicate, true, 'kept is reported once (source identity)');
  applyEvent(state, wtEvent(wtPayload('pruned'), '2026-10-11T09:00:00Z', 'worker'));
  assert.deepEqual([t.worktrees[0].state, t.worktrees[0].pruned_at], ['pruned', '2026-10-11T09:00:00Z']);
  assert.equal(applyEvent(state, wtEvent(wtPayload('pruned', { mount_id: M2 }))).rejected, 'worktree-unknown');
  // A remount of the same folder after teardown is a new record with its own identities.
  applyEvent(state, wtEvent(wtPayload('mounted', { mount_id: M3 }), '2026-10-12T09:00:00Z'));
  assert.deepEqual(t.worktrees.map((w) => [w.id, w.state]), [[M1, 'pruned'], [M3, 'mounted']]);
  // Replaying the same journal into a fresh state gives the same records.
  const again = newState();
  createTicket(again);
  for (const e of [mounted, kept, wtEvent(wtPayload('pruned'), '2026-10-11T09:00:00Z', 'worker'), wtEvent(wtPayload('mounted', { mount_id: M3 }), '2026-10-12T09:00:00Z')]) applyEvent(again, e);
  assert.deepEqual(again.tickets.get(T1).worktrees, t.worktrees);
});

test('malformed worktree events are rejected and change nothing', () => {
  const state = newState();
  const t = createTicket(state);
  const bads = [{ path: 'relative/dir' }, { base_sha: 'HEAD' }, { repo_id: '../x' }, { op: 'removed' }, { op: 'kept', reason: 'because' }, { mount_id: 'x' }];
  bads.forEach((extra, i) => {
    const bad = wtPayload('mounted', { mount_id: `22222222-0000-4000-8000-00000000000${i}`, ...extra });
    assert.equal(applyEvent(state, wtEvent(bad)).rejected, 'worktree-invalid', JSON.stringify(bad));
  });
  assert.equal(applyEvent(state, wtEvent(wtPayload('mounted', { ticket_id: T2 }))).rejected, 'ticket-unknown');
  assert.equal(t.worktrees, undefined);
});

test('teardownPlan: a done ticket worktree is due after keep_days with no live session in it or bound to it', () => {
  const now = '2026-10-20T00:00:00Z';
  const rec = (extra = {}) => ({ id: M1, path: WT, repo_id: 'demo', branch: 'b', base_sha: SHA, state: 'mounted', mounted_at: '2026-10-01T00:00:00Z', ...extra });
  const done = (extra = {}) => ({ id: T1, key: 'K-1', status: 'done', updated_at: '2026-10-10T00:00:00Z', worktrees: [rec()], ...extra });
  const plan = (tickets, sessions = [], keepDays = 7) => teardownPlan(tickets, sessions, { nowIso: now, keepDays }).map((p) => [p.due, p.hold]);
  assert.deepEqual(plan([done()]), [[true, null]]);
  assert.deepEqual(plan([done({ updated_at: '2026-10-15T00:00:00Z' })]), [[false, 'recent']], 'measured from the last change of the ticket');
  assert.deepEqual(plan([done({ worktrees: [rec({ mounted_at: '2026-10-18T00:00:00Z' })] })]), [[false, 'recent']], 'or from the mount, whichever is later');
  assert.deepEqual(plan([done()], [], 14), [[false, 'recent']]);
  assert.deepEqual(plan([done({ status: 'review' })]), [[false, null]], 'only done tickets');
  assert.deepEqual(plan([done({ worktrees: [rec({ state: 'pruned' })] })]), [], 'pruned records are gone');
  assert.deepEqual(plan([done({ worktrees: [rec({ state: 'kept' })] })]), [[true, null]], 'a kept worktree is checked again');
  const session = (extra) => ({ id: 's', cwd: 'C:/elsewhere', current_ticket_id: null, ended_at: null, last_event_at: '2026-10-19T23:50:00Z', ...extra });
  assert.deepEqual(plan([done()], [session({ cwd: `${WT}/sub` })]), [[false, 'session']]);
  assert.deepEqual(plan([done()], [session({ current_ticket_id: T1 })]), [[false, 'session']]);
  assert.deepEqual(plan([done()], [session({ cwd: `${WT}/sub`, ended_at: '2026-10-19T23:55:00Z' })]), [[true, null]], 'an ended session holds nothing');
  assert.deepEqual(plan([done()], [session({ cwd: WT, last_event_at: '2026-10-15T00:00:00Z' })]), [[true, null]], 'nor an extinct one');
  assert.deepEqual(plan([done()], [session({ cwd: `${WT}-other` })]), [[true, null]], 'a sibling folder is not inside');
  assert.throws(() => ticketWorktreeDir('/h/worktrees', '..', 'K-1'));
  assert.throws(() => ticketWorktreeDir('/h/worktrees', 'demo', '../K'));
});
