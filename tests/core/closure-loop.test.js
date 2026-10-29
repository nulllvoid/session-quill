import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, ev, bind } from './helpers.js';
import { validateRequestBody } from '../../src/server/requests.js';
import { buildSnapshot } from '../../src/worker/projections.js';
import { sanitizeSnapshot } from '../../src/export/sanitize.js';

const at = '2026-10-30T12:00:00Z';
const id = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function merge(state, ticket, extra = {}) {
  return ev(state, 'reconcile', { pr_updates: [{ ticket_id: ticket.id, link: true, url: 'https://github.com/acme/demo/pull/1', state: 'merged', merged_at: at, observed_at: at, environments: ['production'], deploy_on: 'merge', ...extra }] }, { producer: 'worker', occurred_at: at });
}

test('a run PR closes its exact originating ticket; repeated checks cannot override a manual reopen', () => {
  const state = newState(), ticket = createTicket(state);
  const h = { id: 'run', ticket_id: ticket.id, repo_id: ticket.repo_id, state: 'done', branch: 'fix/one', pr_url: 'https://github.com/acme/demo/pull/1' };
  state.handoffs.set(h.id, h);
  merge(state, ticket, { origin_handoff_id: h.id, head_branch: 'fix/one' });
  assert.equal(ticket.status, 'done');
  const count = ticket.timeline.length;
  merge(state, ticket, { origin_handoff_id: h.id, head_branch: 'fix/one' });
  assert.equal(ticket.timeline.length, count);
  ev(state, 'ticket-update', { ticket_id: ticket.id, fields: { status: 'active' } }, { occurred_at: at });
  merge(state, ticket, { origin_handoff_id: h.id, head_branch: 'fix/one' });
  assert.equal(ticket.status, 'active');
});

test('origin-run identity mismatch cannot manufacture a ticket PR link', () => {
  const state = newState(), ticket = createTicket(state);
  state.handoffs.set('other', { id: 'other', ticket_id: 'another-ticket', repo_id: ticket.repo_id, pr_url: 'https://github.com/acme/demo/pull/1', branch: 'fix/one' });
  merge(state, ticket, { origin_handoff_id: 'other', head_branch: 'fix/one' });
  assert.equal(ticket.prs.length, 0);
  assert.notEqual(ticket.status, 'done');
});

test('all PR updates are assessed together, and run completion releases a pending closure', () => {
  const state = newState(), ticket = createTicket(state);
  state.handoffs.set('run', { id: 'run', ticket_id: ticket.id, state: 'running' });
  merge(state, ticket);
  assert.notEqual(ticket.status, 'done');
  ev(state, 'handoff-tx', { handoff_id: 'run', update: { state: 'done', finished_at: at } }, { producer: 'worker', occurred_at: at });
  assert.equal(ticket.status, 'done');
});

test('automatic cleanup rechecks child state even when parent revision did not change', () => {
  const state = newState(), parent = createTicket(state);
  const child = createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: 'DEV-2', parent_id: parent.id });
  Object.assign(parent, { completion_mode: 'children' });
  Object.assign(child, { blocks_parent: true, status: 'active' });
  const result = ev(state, 'ticket-update', { ticket_id: parent.id, expected_revision: parent.revision, reconcile_close: true, fields: { status: 'done' } });
  assert.equal(result.rejected, 'closure-not-ready');
  assert.notEqual(parent.status, 'done');
});

test('completion settings and non-delivery resolutions are validated and journaled', () => {
  const state = newState(), t = createTicket(state), other = createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: 'DEV-2' });
  const make = (kind, payload) => validateRequestBody({ id, kind, target_id: t.id, expected_revision: t.revision, payload }, state, at);
  assert.equal(make('set-completion', { completion_mode: 'children' }).payload.completion_mode, 'children');
  assert.throws(() => make('set-completion', { blocks_parent: 'yes' }), /boolean/);
  assert.throws(() => make('set-status', { status: 'done', resolution: { kind: 'duplicate', reason: 'same work' } }), /related/);
  const r = make('set-status', { status: 'done', resolution: { kind: 'duplicate', reason: 'same work', related_ticket_id: other.id } });
  ev(state, 'ticket-update', { ticket_id: t.id, fields: r.payload }, { occurred_at: at });
  assert.equal(t.resolution.kind, 'duplicate');
  assert.equal(t.resolution.related_ticket_id, other.id);
});

test('closure queue is owner-only; unchanged sweeps do not add work', () => {
  const state = newState(), t = createTicket(state);
  Object.assign(t, { status: 'blocked', blocker: 'Needs owner', last_activity: '2026-10-01T00:00:00Z' });
  const snapshot = buildSnapshot(state, { generation_id: 'g', generated_at: at });
  assert.equal(snapshot.reconciliation.items[0].ticket_id, t.id);
  assert.equal(sanitizeSnapshot(snapshot).reconciliation, undefined);
  ev(state, 'reconcile', {}, { occurred_at: at, producer: 'worker' });
  ev(state, 'reconcile', {}, { occurred_at: at, producer: 'worker' });
  assert.equal(state.tickets.size, 1);
});

test('one reconcile batch cannot close on its first PR before seeing the second', () => {
  const state = newState(), t = createTicket(state);
  ev(state, 'reconcile', { pr_updates: [
    { ticket_id: t.id, link: true, url: 'https://github.com/acme/demo/pull/1', state: 'merged', merged_at: at, observed_at: at, environments: ['production'], deploy_on: 'merge' },
    { ticket_id: t.id, link: true, url: 'https://github.com/acme/demo/pull/2', state: 'open', observed_at: at },
  ] }, { producer: 'worker', occurred_at: at });
  assert.notEqual(t.status, 'done');
  assert.equal(t.resolution, null);
});

test('completion settings at application strip unrelated fields from ingress', async () => {
  const { evaluateRequest } = await import('../../src/server/requests.js');
  const state = newState(), t = createTicket(state);
  const out = evaluateRequest({ state, now: () => at }, { id, kind: 'set-completion', target_id: t.id, expected_revision: t.revision, payload: { completion_mode: 'children', status: 'done', parent_id: 'malicious' } });
  assert.equal(out.outcome, 'applied');
  assert.deepEqual(out.mutation.fields, { completion_mode: 'children' });
});

test('closure acknowledgement stays quiet on refresh and returns on material changes', async () => {
  const { reconciliationItems } = await import('../../src/core/closure.js');
  const { evaluateRequest } = await import('../../src/server/requests.js');
  const state = newState(), t = createTicket(state);
  Object.assign(t, { status: 'blocked', blocker: 'Waiting on team' });
  const item = reconciliationItems(state, at)[0];
  const req = validateRequestBody({ id, kind: 'acknowledge-closure', target_id: t.id, expected_revision: t.revision, payload: { evidence_version: item.evidence_version } }, state, at);
  const out = evaluateRequest({ state, now: () => at }, req);
  assert.equal(out.outcome, 'applied');
  ev(state, 'ticket-update', { ticket_id: t.id, fields: out.mutation.fields }, { occurred_at: at });
  assert.equal(reconciliationItems(state, at).length, 0);
  ev(state, 'reconcile', {}, { occurred_at: at });
  assert.equal(reconciliationItems(state, at).length, 0);
  t.blocker = 'Different blocker';
  assert.equal(reconciliationItems(state, at).length, 1);
  assert.equal(evaluateRequest({ state, now: () => at }, { ...req, expected_revision: t.revision }).outcome, 'failed');
});

test('new source edits in a completed run cannot reuse an older merge', () => {
  const state = newState(), t = createTicket(state);
  state.handoffs.set('run', { id: 'run', ticket_id: t.id, state: 'running' });
  merge(state, t);
  ev(state, 'handoff-tx', { handoff_id: 'run', update: { state: 'done', finished_at: '2026-10-30T13:00:00Z', changed_files: ['src/new.js'] } }, { producer: 'worker', occurred_at: '2026-10-30T13:00:00Z' });
  assert.notEqual(t.status, 'done');
});

test('a rejected multi-field change cannot leave a new completion policy behind', () => {
  const state = newState(), t = createTicket(state);
  for (const fields of [
    { completion_mode: 'children', status: 'blocked' },
    { completion_mode: 'children', deployments: [{ pr_id: 'unknown', state: 'waived', waiver_reason: 'none' }] },
  ]) {
    const out = ev(state, 'ticket-update', { ticket_id: t.id, fields });
    assert.ok(out.rejected);
    assert.equal(t.completion_mode, 'evidence');
    assert.equal(t.completion_policy_seq, undefined);
  }
});

test('provider failure reopens an acknowledged branch review without poll noise', async () => {
  const { reconciliationItems } = await import('../../src/core/closure.js');
  const { checkKey } = await import('../../src/reconcile/checks.js');
  const state = newState(), t = createTicket(state);
  t.branches = [{ name: 'work', last_seen: at }];
  const key = checkKey('branch', t.repo_id, 'work');
  state.reconcileChecks = new Map([[key, { key, kind: 'branch', repo_id: t.repo_id, target_id: 'work', error: null, next_check_at: at }]]);
  t.closure_review = { evidence_version: reconciliationItems(state, at)[0].evidence_version };
  state.reconcileChecks.get(key).next_check_at = '2026-10-31T00:00:00Z';
  assert.equal(reconciliationItems(state, at).length, 0);
  state.reconcileChecks.get(key).error = 'Provider unavailable';
  assert.equal(reconciliationItems(state, at).length, 1);
});

test('outcome counters distinguish delivered work from other resolutions', async () => {
  const { reconciliationSummary } = await import('../../src/core/closure.js');
  const state = newState(), t = createTicket(state);
  merge(state, t);
  const other = createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: 'DEV-2' });
  ev(state, 'ticket-update', { ticket_id: other.id, fields: { status: 'done', resolution: { kind: 'abandoned', reason: 'No longer needed' } } }, { occurred_at: at });
  const result = reconciliationSummary(state, at);
  assert.equal(result.tasks_created, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.otherwise_resolved, 1);
  assert.equal(result.open, 0);
  assert.equal(result.merge_to_closure.measured, 1);
});


test('a captured commit after a merge prevents completion even without file hooks', () => {
  const state = newState(), t = createTicket(state);
  state.handoffs.set('run', { id: 'run', ticket_id: t.id, state: 'running' });
  merge(state, t);
  bind(state, 'session', t.id, { at });
  const later = '2026-10-30T13:00:00Z';
  ev(state, 'pre-tool', { tool_name: 'Bash' }, { session_id: 'session', tool_call_id: 'commit', occurred_at: later });
  ev(state, 'post-tool', { tool_name: 'Bash', success: true, commit: { sha: 'a'.repeat(40) } }, { session_id: 'session', tool_call_id: 'commit', occurred_at: later });
  ev(state, 'handoff-tx', { handoff_id: 'run', update: { state: 'done', finished_at: later } }, { producer: 'worker', occurred_at: later });
  assert.notEqual(t.status, 'done');
});
