import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newState, createTicket, ev, STORE, MACHINE } from './helpers.js';
import { EVENT_KINDS, makeEvent, validateEvent } from '../../src/core/events.js';
import { applyEvent } from '../../src/core/reducer.js';
import { attachBlobReader } from '../../src/core/state.js';
import { deterministicId } from '../../src/lib/ids.js';
import { buildCriticalProposal } from '../../src/core/reduce/critical.js';
import { pinOfChange } from '../../src/handoff/action-pin.js';
import { descriptionProblems } from '../../src/core/description.js';
import { proposalState } from '../../src/publish/run-proposals.js';

const T0 = '2026-10-02T08:00:00Z';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FP = 'f'.repeat(64);

const CHANGES = [
  { title: 'Sync payments to staging', scope: 'argo.sync', target: 'pay-stg', action: 'argocd app sync pay-stg --prune', why: 'the fix is merged', evidence: 'PR 12 merged', verify: 'argocd app get pay-stg shows Synced', rollback: 'argocd app rollback pay-stg 3', risk: 'medium' },
  { title: 'Close PMO-1\u0007 <script>x</script>', scope: 'jira.write', target: 'PMO-1', action: 'mcp__atlassian__transitionJiraIssue {"issueIdOrKey":"PMO-1","transition":"Done"}', why: 'done', evidence: 'e', verify: 'v', rollback: 'r', risk: 'low' },
];

function setup({ state: runState = 'done', changes = CHANGES } = {}) {
  const state = newState();
  const parent = createTicket(state, { id: PARENT, key: 'PMO-7', title: 'Payments fix' });
  const text = JSON.stringify({ summary: 's', critical_changes: changes });
  const hash = createHash('sha256').update(text).digest('hex');
  const blobs = new Map([[hash, text]]);
  attachBlobReader(state, (h) => blobs.get(h) ?? null);
  state.handoffs.set(HID, { id: HID, ticket_id: PARENT, state: runState, result_ref: hash, revision: 1 });
  return { state, parent };
}

function payload(state, index, over = {}) {
  const change = CHANGES[index];
  const scopes = index === 0 ? [{ name: 'argo.sync', target: 'pay-stg', fingerprint: FP }] : [{ name: 'jira.write', target: null, fingerprint: FP }];
  return { ...buildCriticalProposal({ run: state.handoffs.get(HID), parent: state.tickets.get(PARENT), index, change, pin: pinOfChange(change), scopes, key: `PMO-7.${index + 1}` }), ...over };
}

const worker = (state, p, extra = {}) => ev(state, 'critical-proposal', p, { producer: 'worker', occurred_at: T0, ...extra });

test('critical-proposal is a registered, valid event kind', () => {
  assert.ok(EVENT_KINDS.includes('critical-proposal'));
  assert.doesNotThrow(() => validateEvent(makeEvent({ kind: 'critical-proposal', payload: { id: 'x' }, store_id: STORE, machine_id: MACHINE, producer: 'worker', occurred_at: T0 })));
});

test('a valid event creates a local-only critical child ticket and an autonomous run proposal', () => {
  const { state } = setup();
  const p = payload(state, 0);
  assert.equal(p.id, deterministicId(`${HID}:critical:0`));
  const r = worker(state, p);
  assert.equal(r.rejected, undefined);
  const child = [...state.tickets.values()].find((t) => t.key === 'PMO-7.1');
  assert.ok(child);
  assert.equal(child.local_only, true);
  assert.deepEqual(child.tags, ['critical']);
  assert.equal(child.status, 'todo');
  assert.equal(child.parent_id, PARENT);
  assert.equal(child.title, 'Sync payments to staging');
  assert.deepEqual(descriptionProblems(child.summary), [], child.summary);
  assert.equal(child.critical_spec.action_pin.guard, 'argocd app sync pay-stg --prune');
  assert.equal(child.critical_spec.action_pin.normalized, pinOfChange(CHANGES[0]).normalized);
  assert.deepEqual([child.critical_spec.target, child.critical_spec.verify, child.critical_spec.rollback, child.critical_spec.risk], ['pay-stg', 'argocd app get pay-stg shows Synced', 'argocd app rollback pay-stg 3', 'medium']);
  assert.deepEqual(child.critical_spec.scopes, [{ name: 'argo.sync', target: 'pay-stg', fingerprint: FP }]);
  const prop = state.runProposals.get(p.id);
  assert.equal(prop.ticket_id, child.id);
  assert.equal(prop.origin, 'run');
  assert.equal(prop.from_handoff_id, HID);
  assert.deepEqual(prop.recipe, { name: 'critical-change', source: 'builtin', hash: null });
  assert.equal(prop.access, 'autonomous');
  assert.deepEqual(prop.scopes, [{ name: 'argo.sync', target: 'pay-stg', fingerprint: FP }]);
  assert.deepEqual(prop.action_pin, pinOfChange(CHANGES[0]));
  assert.equal(prop.state, 'proposed');
  assert.equal(proposalState(prop, child, T0), 'proposed');
  assert.equal(proposalState(prop, child, '2026-10-09T08:00:01Z'), 'expired', '7-day TTL like other proposals');
  assert.equal(state.criticalProblems.length, 0);
});

test('agent text is cleaned: control characters stripped, lengths capped', () => {
  const { state } = setup();
  const r = worker(state, payload(state, 1));
  assert.equal(r.rejected, undefined);
  const child = [...state.tickets.values()].find((t) => t.key === 'PMO-7.2');
  assert.equal(child.title, 'Close PMO-1 <script>x</script>', 'stored as text; the UI escapes it');
  assert.equal(/[\u0000-\u001f]/.test(child.title), false);
  assert.equal(child.critical_spec.action_pin.kind, 'mcp');
  assert.deepEqual(child.critical_spec.action_pin.ids, { issueIdOrKey: 'PMO-1' });
  assert.equal(child.critical_spec.target, null, 'jira.write takes no target');
});

test('the event is accepted once: redelivery and replay are idempotent', () => {
  const { state } = setup();
  const p = payload(state, 0);
  const e = makeEvent({ kind: 'critical-proposal', payload: p, store_id: STORE, machine_id: MACHINE, producer: 'worker', occurred_at: T0, source_identity: `critical-proposal:${p.id}` });
  e.sequence = 50;
  assert.equal(applyEvent(state, e).rejected, undefined);
  const count = state.tickets.size;
  assert.equal(applyEvent(state, e).duplicate, true);
  // A second event (another event id) for the same run entry changes nothing either.
  const again = worker(state, payload(state, 0));
  assert.equal(again.duplicate, true);
  assert.equal(state.tickets.size, count);
  assert.equal([...state.runProposals.values()].filter((x) => x.origin === 'run').length, 1);
  // Replaying the same journal into fresh state gives the same child and proposal.
  const { state: fresh } = setup();
  applyEvent(fresh, e);
  const child = [...state.tickets.values()].find((t) => t.key === 'PMO-7.1');
  const replayed = fresh.tickets.get(child.id);
  assert.deepEqual([replayed.title, replayed.summary, replayed.critical_spec], [child.title, child.summary, child.critical_spec]);
  assert.deepEqual(fresh.runProposals.get(p.id), state.runProposals.get(p.id));
});

function rejects(name, make, code) {
  test(`rejected, nothing changes: ${name}`, () => {
    const s = make();
    const before = { tickets: s.state.tickets.size, proposals: s.state.runProposals.size, revision: s.state.tickets.get(PARENT).revision };
    const r = s.apply();
    assert.equal(r.rejected, code);
    assert.deepEqual({ tickets: s.state.tickets.size, proposals: s.state.runProposals.size, revision: s.state.tickets.get(PARENT).revision }, before);
    assert.equal(s.state.criticalProblems.at(-1).code, code);
  });
}

rejects('wrong index (entry 1 with the pin of entry 0)', () => {
  const { state } = setup();
  const p = payload(state, 0, { index: 1, id: deterministicId(`${HID}:critical:1`) });
  return { state, apply: () => worker(state, p) };
}, 'critical-pin-mismatch');

rejects('index past the end of critical_changes', () => {
  const { state } = setup();
  const p = payload(state, 0, { index: 5, id: deterministicId(`${HID}:critical:5`) });
  return { state, apply: () => worker(state, p) };
}, 'critical-index-invalid');

rejects('wrong pin', () => {
  const { state } = setup();
  const p = payload(state, 0, { pin: pinOfChange({ action: 'argocd app sync pay-stg' }) });
  return { state, apply: () => worker(state, p) };
}, 'critical-pin-mismatch');

rejects('a pin whose guard form was changed', () => {
  const { state } = setup();
  const good = payload(state, 0);
  const p = { ...good, pin: { ...good.pin, guard: 'argocd app sync pay-prod --prune' } };
  return { state, apply: () => worker(state, p) };
}, 'critical-pin-mismatch');

rejects('wrong id', () => {
  const { state } = setup();
  const p = payload(state, 0, { id: deterministicId(`${HID}:critical:9`) });
  return { state, apply: () => worker(state, p) };
}, 'critical-id-mismatch');

for (const runState of ['running', 'failed', 'cancelled', 'timed-out', 'queued']) {
  rejects(`run not done (${runState})`, () => {
    const { state } = setup({ state: runState });
    const p = payload(state, 0);
    return { state, apply: () => worker(state, p) };
  }, 'critical-run-not-done');
}

rejects('unknown run', () => {
  const { state } = setup();
  const p = payload(state, 0, { from_handoff_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', id: deterministicId('dddddddd-dddd-4ddd-8ddd-dddddddddddd:critical:0') });
  return { state, apply: () => worker(state, p) };
}, 'critical-run-unknown');

rejects('the result blob is unavailable', () => {
  const { state } = setup();
  attachBlobReader(state, () => null);
  const p = payload(state, 0);
  return { state, apply: () => worker(state, p) };
}, 'critical-result-unavailable');

rejects('scopes that do not name the entry\'s scope', () => {
  const { state } = setup();
  const p = payload(state, 0, { scopes: [{ name: 'k8s.write', target: 'stg', fingerprint: FP }] });
  return { state, apply: () => worker(state, p) };
}, 'critical-scope-invalid');

rejects('a scope without a fingerprint', () => {
  const { state } = setup();
  const p = payload(state, 0, { scopes: [{ name: 'argo.sync', target: 'pay-stg' }] });
  return { state, apply: () => worker(state, p) };
}, 'critical-scope-invalid');

for (const producer of ['cli', 'hook', 'page', 'publisher']) {
  rejects(`delivered through ingress (producer ${producer})`, () => {
    const { state } = setup();
    const p = payload(state, 0);
    return { state, apply: () => ev(state, 'critical-proposal', p, { producer, occurred_at: T0 }) };
  }, 'critical-proposal-source');
}

rejects('a key another ticket holds', () => {
  const { state } = setup();
  createTicket(state, { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', key: 'PMO-7.1', title: 'Other', parent_id: PARENT });
  const p = payload(state, 0);
  return { state, apply: () => worker(state, p) };
}, 'key-collision');
