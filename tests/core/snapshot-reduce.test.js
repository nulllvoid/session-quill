// Run snapshots (ADR 0035): the `snapshot-tx` reducer and the `snapshot-restore` request mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, STORE, MACHINE } from './helpers.js';
import { EVENT_KINDS, WORKER_ONLY_KINDS, makeEvent, validateEvent } from '../../src/core/events.js';
import { applyEvent } from '../../src/core/reducer.js';
import { SNAPSHOT_CAP, STEP_LABELS } from '../../src/core/reduce/snapshots.js';

const T0 = '2026-10-02T08:00:00Z';
const HID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHA = (c) => c.repeat(40);

const mk = (kind, payload, extra = {}) => {
  const e = makeEvent({ kind, payload, store_id: STORE, machine_id: MACHINE, producer: 'worker', occurred_at: extra.occurred_at ?? T0, ...extra });
  e.ingested_at = e.occurred_at;
  return e;
};

function withRun() {
  const state = newState();
  const t = createTicket(state);
  const rid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  applyEvent(state, mk('request', { id: rid, kind: 'handoff', target_id: t.id, payload: {} }));
  applyEvent(state, mk('request-tx', { request_id: rid, outcome: 'applied', mutation: { type: 'handoff-create', handoff: { id: HID, ticket_id: t.id, mode: 'attempt-fix', permissions: { read_source: true, edit_source: true }, state: 'done', revision: 1 } } }));
  return { state, t };
}

const created = (n, step = 'agent', extra = {}) => ({ op: 'created', id: `snap-${n}`, handoff_id: HID, ticket_id: 'x', step, label: STEP_LABELS[step], tree: SHA('a'), commit: SHA(String(n % 10)), ref: `refs/quill/snapshots/${HID}/${String(n).padStart(2, '0')}-${step}`, files_changed: n, ...extra });

test('snapshot-tx is a registered, worker-only kind', () => {
  assert.ok(EVENT_KINDS.includes('snapshot-tx'));
  assert.ok(WORKER_ONLY_KINDS.has('snapshot-tx'));
  assert.doesNotThrow(() => validateEvent(mk('snapshot-tx', created(0))));
});

test('created appends a snapshot to the run with its step, label, tree, commit, ref and count', () => {
  const { state } = withRun();
  const r = applyEvent(state, mk('snapshot-tx', created(0, 'start')));
  assert.equal(r.rejected, undefined);
  assert.ok(r.handoffsChanged.has(HID));
  const [s] = state.handoffs.get(HID).snapshots;
  assert.deepEqual({ ...s }, { id: 'snap-0', n: 0, step: 'start', label: 'Checkout created', tree: SHA('a'), commit: SHA('0'), ref: `refs/quill/snapshots/${HID}/00-start`, files_changed: 0, at: T0, restored_at: null, archived_at: null });
});

test('malformed snapshots are rejected and change nothing', () => {
  const { state } = withRun();
  const bad = [
    { ...created(0), step: 'whenever' },
    { ...created(0), tree: 'HEAD' },
    { ...created(0), commit: SHA('g') },
    { ...created(0), ref: 'refs/heads/main' },
    { ...created(0), ref: `refs/quill/snapshots/${HID}/../../heads/main` },
    { ...created(0), ref: `refs/quill/snapshots/other-run/00-agent` },
    { ...created(0), id: '' },
    { ...created(0), op: 'deleted' },
    { ...created(0), handoff_id: 'nope' },
  ];
  for (const p of bad) assert.ok(applyEvent(state, mk('snapshot-tx', p)).rejected, JSON.stringify(p));
  assert.equal(state.handoffs.get(HID).snapshots, undefined);
});

test('a run keeps at most SNAPSHOT_CAP snapshots', () => {
  const { state } = withRun();
  for (let n = 0; n < SNAPSHOT_CAP; n += 1) assert.equal(applyEvent(state, mk('snapshot-tx', created(n))).rejected, undefined);
  assert.equal(applyEvent(state, mk('snapshot-tx', created(SNAPSHOT_CAP))).rejected, 'snapshot-limit');
  assert.equal(state.handoffs.get(HID).snapshots.length, SNAPSHOT_CAP);
});

test('restored and archived update the named snapshot; archived only to the archive refs', () => {
  const { state } = withRun();
  applyEvent(state, mk('snapshot-tx', created(0)));
  applyEvent(state, mk('snapshot-tx', { op: 'restored', id: 'snap-0', handoff_id: HID, request_id: 'req-1', pre_restore_id: 'snap-1', restored: 2, removed: 1, skipped: 0 }, { occurred_at: '2026-10-02T09:00:00Z' }));
  const s = state.handoffs.get(HID).snapshots[0];
  assert.equal(s.restored_at, '2026-10-02T09:00:00Z');
  assert.deepEqual(s.restore, { request_id: 'req-1', pre_restore_id: 'snap-1', restored: 2, removed: 1, skipped: 0 });
  assert.equal(applyEvent(state, mk('snapshot-tx', { op: 'archived', id: 'snap-0', handoff_id: HID, ref: `refs/heads/${HID}` })).rejected, 'snapshot-invalid');
  assert.equal(applyEvent(state, mk('snapshot-tx', { op: 'restored', id: 'snap-9', handoff_id: HID })).rejected, 'snapshot-unknown');
  applyEvent(state, mk('snapshot-tx', { op: 'archived', id: 'snap-0', handoff_id: HID, ref: `refs/quill/archive/${HID}/00-agent` }, { occurred_at: '2026-10-09T09:00:00Z' }));
  assert.equal(s.archived_at, '2026-10-09T09:00:00Z');
  assert.equal(s.ref, `refs/quill/archive/${HID}/00-agent`);
  assert.equal(applyEvent(state, mk('snapshot-tx', { op: 'archived', id: 'snap-0', handoff_id: HID, ref: `refs/quill/archive/${HID}/00-agent` })).duplicate, true);
});

test('the snapshot-restore mutation leaves an honest timeline entry on the ticket', () => {
  const { state, t } = withRun();
  applyEvent(state, mk('snapshot-tx', created(0, 'before-tests')));
  const rid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  applyEvent(state, mk('request', { id: rid, kind: 'restore-snapshot', target_id: t.id, payload: { handoff_id: HID, snapshot_id: 'snap-0' } }));
  const before = state.tickets.get(t.id).revision;
  applyEvent(state, mk('request-tx', { request_id: rid, outcome: 'applied', mutation: { type: 'snapshot-restore', handoff_id: HID, snapshot_id: 'snap-0', pre_restore_id: 'snap-1' } }));
  const ticket = state.tickets.get(t.id);
  assert.ok(ticket.revision > before);
  assert.ok(ticket.timeline.some((e) => /Checkout of run cccccccc restored to snapshot 01 \(Before the test gate\); the commit, branch and pull request are unchanged/.test(e.text)), JSON.stringify(ticket.timeline.map((e) => e.text)));
});

test('replay is idempotent: redelivered events have one effect and a fresh replay yields the same snapshots', () => {
  const events = [
    mk('snapshot-tx', created(0, 'start'), { source_identity: `snapshot-tx:${HID}:0` }),
    mk('snapshot-tx', created(1, 'agent'), { source_identity: `snapshot-tx:${HID}:1` }),
    mk('snapshot-tx', { op: 'restored', id: 'snap-0', handoff_id: HID, restored: 1, removed: 0, skipped: 0 }, { source_identity: 'snapshot-tx:restored:r1' }),
    mk('snapshot-tx', { op: 'archived', id: 'snap-1', handoff_id: HID, ref: `refs/quill/archive/${HID}/01-agent` }, { source_identity: 'snapshot-tx:snap-1:archived' }),
  ];
  const a = withRun().state;
  for (const e of events) applyEvent(a, e);
  for (const e of events) assert.equal(applyEvent(a, e).duplicate, true);
  // The same snapshot redelivered under a new event id but the same source identity, and the same id under a new source.
  assert.equal(applyEvent(a, mk('snapshot-tx', created(0, 'start'), { source_identity: `snapshot-tx:${HID}:0` })).duplicate, true);
  assert.equal(applyEvent(a, mk('snapshot-tx', created(0, 'start'))).duplicate, true);
  const b = withRun().state;
  for (const e of events) applyEvent(b, e);
  assert.deepEqual(a.handoffs.get(HID).snapshots, b.handoffs.get(HID).snapshots);
  assert.equal(a.handoffs.get(HID).snapshots.length, 2);
});
