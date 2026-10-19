import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newState, createTicket, ev, STORE, MACHINE } from './helpers.js';
import { EVENT_KINDS, makeEvent, validateEvent } from '../../src/core/events.js';
import { applyEvent } from '../../src/core/reducer.js';
import { deterministicId } from '../../src/lib/ids.js';
import { buildCriticalProposal } from '../../src/handoff/critical-changes.js';
import { pinOfChange } from '../../src/handoff/action-pin.js';
import { descriptionProblems } from '../../src/core/description.js';
import { proposalState } from '../../src/publish/run-proposals.js';

const T0 = '2026-10-02T08:00:00Z';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FP = 'f'.repeat(64);

const CHANGES = [
  { title: 'Sync payments to staging', scope: 'argo.sync', target: 'pay-stg', action: 'argocd app sync pay-stg --prune', why: 'the fix is merged', evidence: 'PR 12 merged', verify: 'argocd app get pay-stg shows Synced', rollback: 'argocd app rollback pay-stg 3', risk: 'medium' },
  { title: 'Close PMO-1 <script>x</script>', scope: 'jira.write', target: 'PMO-1', action: 'mcp__atlassian__transitionJiraIssue {"issueIdOrKey":"PMO-1","transition":"Done"}', why: 'done', evidence: 'e', verify: 'v', rollback: 'r', risk: 'low' },
];

// No result blob exists anywhere: the reducer must not need one (R44).
function setup({ state: runState = 'done' } = {}) {
  const state = newState();
  const parent = createTicket(state, { id: PARENT, key: 'PMO-7', title: 'Payments fix' });
  state.handoffs.set(HID, { id: HID, ticket_id: PARENT, state: runState, result_ref: 'e'.repeat(64), revision: 1 });
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

test('a valid event creates a local-only critical child ticket and an autonomous run proposal, from the event alone', () => {
  const { state } = setup();
  const p = payload(state, 0);
  assert.equal(p.id, deterministicId(`${HID}:critical:0`));
  const r = worker(state, p);
  assert.equal(r.rejected, undefined);
  const child = [...state.tickets.values()].find((t) => t.key === 'PMO-7.1');
  assert.ok(child);
  assert.deepEqual([child.local_only, child.tags, child.status, child.parent_id, child.title], [true, ['critical'], 'todo', PARENT, 'Sync payments to staging']);
  assert.deepEqual(descriptionProblems(child.summary), [], child.summary);
  for (const secret of ['argocd app sync', 'PR 12 merged', 'rollback pay-stg', 'the fix is merged', 'shows Synced']) assert.equal(child.summary.includes(secret), false, `description leaves out ${secret} (R46)`);
  assert.deepEqual(child.critical_spec, p.child.critical_spec);
  assert.equal(child.critical_spec.action_pin.guard, 'argocd app sync pay-stg --prune');
  assert.deepEqual([child.critical_spec.target, child.critical_spec.verify, child.critical_spec.rollback, child.critical_spec.risk], ['pay-stg', 'argocd app get pay-stg shows Synced', 'argocd app rollback pay-stg 3', 'medium']);
  const prop = state.runProposals.get(p.id);
  assert.deepEqual([prop.ticket_id, prop.origin, prop.from_handoff_id, prop.access, prop.state], [child.id, 'run', HID, 'autonomous', 'proposed']);
  assert.deepEqual(prop.recipe, { name: 'critical-change', source: 'builtin', hash: null });
  assert.deepEqual(prop.scopes, [{ name: 'argo.sync', target: 'pay-stg', fingerprint: FP }]);
  assert.deepEqual(prop.action_pin, p.pin);
  assert.notEqual(prop.action_pin, p.pin, 'stored as a copy, never aliasing the payload');
  assert.equal(proposalState(prop, child, '2026-10-09T08:00:01Z'), 'expired', '7-day TTL like other proposals');
  assert.equal(state.criticalProblems.length, 0);
});

test('an MCP critical change keeps its pin and a scope without a target', () => {
  const { state } = setup();
  assert.equal(worker(state, payload(state, 1)).rejected, undefined);
  const child = [...state.tickets.values()].find((t) => t.key === 'PMO-7.2');
  assert.equal(child.title, 'Close PMO-1 <script>x</script>', 'stored as text; the UI escapes it');
  assert.deepEqual(child.critical_spec.action_pin.ids, { issueIdOrKey: 'PMO-1' });
  assert.equal(child.critical_spec.target, null);
});

test('replay keeps an accepted event whatever the pin code would say today (R44)', () => {
  const { state } = setup();
  // A pin the current parser would normalise differently (or not pin at all): replay still applies it.
  const p = payload(state, 0, { pin: { kind: 'bash', binary: 'argocd', normalized: '{"older":"form"}', guard: 'argocd app sync pay-stg --prune' } });
  assert.notEqual(p.pin.normalized, pinOfChange(CHANGES[0]).normalized);
  assert.equal(worker(state, p).rejected, undefined);
  assert.equal(state.runProposals.get(p.id).action_pin.normalized, '{"older":"form"}');
});

test('the event is accepted once: redelivery and replay are idempotent', () => {
  const { state } = setup();
  const p = payload(state, 0);
  const e = makeEvent({ kind: 'critical-proposal', payload: p, store_id: STORE, machine_id: MACHINE, producer: 'worker', occurred_at: T0, source_identity: `critical-proposal:${p.id}` });
  e.sequence = 50;
  assert.equal(applyEvent(state, e).rejected, undefined);
  const count = state.tickets.size;
  assert.equal(applyEvent(state, e).duplicate, true);
  assert.equal(worker(state, payload(state, 0)).duplicate, true, 'a second event for the same entry');
  assert.equal(state.tickets.size, count);
  assert.equal([...state.runProposals.values()].filter((x) => x.origin === 'run').length, 1);
  const { state: fresh } = setup();
  applyEvent(fresh, e);
  const child = [...state.tickets.values()].find((t) => t.key === 'PMO-7.1');
  assert.deepEqual([fresh.tickets.get(child.id).summary, fresh.tickets.get(child.id).critical_spec], [child.summary, child.critical_spec]);
  assert.deepEqual(fresh.runProposals.get(p.id), state.runProposals.get(p.id));
});

function rejects(name, make, code) {
  test(`rejected, nothing changes, problem recorded: ${name}`, () => {
    const s = make();
    const before = { tickets: s.state.tickets.size, proposals: s.state.runProposals.size, revision: s.state.tickets.get(PARENT).revision };
    const r = s.apply();
    assert.equal(r.rejected, code);
    assert.deepEqual({ tickets: s.state.tickets.size, proposals: s.state.runProposals.size, revision: s.state.tickets.get(PARENT).revision }, before);
    assert.equal(s.state.criticalProblems.at(-1).code, code);
  });
}

const make = (over, opts) => () => { const { state } = setup(opts); const p = typeof over === 'function' ? over(state) : payload(state, 0, over); return { state, apply: () => worker(state, p) }; };

rejects('wrong id', make({ id: deterministicId(`${HID}:critical:9`) }), 'critical-id-mismatch');
rejects('wrong index (id of index 0)', make({ index: 1 }), 'critical-id-mismatch');
for (const runState of ['running', 'failed', 'cancelled', 'timed-out', 'queued']) rejects(`run not done (${runState})`, make({}, { state: runState }), 'critical-run-not-done');
rejects('unknown run', make({ from_handoff_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', id: deterministicId('dddddddd-dddd-4ddd-8ddd-dddddddddddd:critical:0') }), 'critical-run-unknown');
rejects('a pin with no guard form', make((state) => { const p = payload(state, 0); return { ...p, pin: { ...p.pin, guard: '' } }; }), 'critical-pin-invalid');
rejects('a pin of an unknown kind', make((state) => { const p = payload(state, 0); return { ...p, pin: { ...p.pin, kind: 'python' } }; }), 'critical-pin-invalid');
rejects('an oversized pin', make((state) => { const p = payload(state, 0); return { ...p, pin: { ...p.pin, values: ['x'.repeat(20000)] } }; }), 'critical-pin-invalid');
rejects('a scope without a fingerprint', make({ scopes: [{ name: 'argo.sync', target: 'pay-stg' }] }), 'critical-scope-invalid');
rejects('a git pseudo-scope', make({ scopes: [{ name: 'git.push', target: null, fingerprint: FP }] }), 'critical-scope-invalid');
rejects('no scopes', make({ scopes: [] }), 'critical-scope-invalid');
rejects('a child title over 200 characters', make((state) => { const p = payload(state, 0); return { ...p, child: { ...p.child, title: 't'.repeat(201) } }; }), 'critical-child-invalid');
rejects('a child description over 4000 characters', make((state) => { const p = payload(state, 0); return { ...p, child: { ...p.child, description: 'd'.repeat(4001) } }; }), 'critical-child-invalid');
rejects('a child with no critical_spec', make((state) => { const p = payload(state, 0); return { ...p, child: { ...p.child, critical_spec: null } }; }), 'critical-child-invalid');
rejects('an index out of range', make({ index: 100, id: deterministicId(`${HID}:critical:100`) }), 'critical-proposal-invalid');
for (const producer of ['cli', 'hook', 'page', 'publisher']) {
  rejects(`delivered through ingress (producer ${producer})`, () => { const { state } = setup(); const p = payload(state, 0); return { state, apply: () => ev(state, 'critical-proposal', p, { producer, occurred_at: T0 }) }; }, 'critical-proposal-source');
}
rejects('a key another ticket holds', () => {
  const { state } = setup();
  createTicket(state, { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', key: 'PMO-7.1', title: 'Other', parent_id: PARENT });
  const p = payload(state, 0);
  return { state, apply: () => worker(state, p) };
}, 'key-collision');

// R44: the reducer's verdict must not depend on the guard's parser, pin code or blobs.
test('import boundary: the critical reducer reaches nothing in src/gate, action-pin.js or blobs.js', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.resolve('src/core/reduce/critical.js'));
  const rel = [...seen].map((f) => path.relative(path.resolve('src'), f).split(path.sep).join('/'));
  const bad = rel.filter((f) => f.startsWith('gate/') || f === 'handoff/action-pin.js' || f === 'core/blobs.js' || f === 'handoff/grant.js');
  assert.deepEqual(bad, [], `reached: ${bad.join(', ')}`);
  assert.ok(rel.includes('core/reduce/critical.js'));
});
