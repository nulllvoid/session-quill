import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDispatchable, reservationFor } from '../../src/handoff/reserve.js';
import { bootWorker, T1, T2 } from './helpers.js';

const RID = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;
const analyse = { mode: 'analyse', note: 'look', permissions: { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false }, branch: null };
const fix = { mode: 'attempt-fix', note: 'fix', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false }, branch: null };

test('one queued/running handoff per ticket: the second request fails with the existing run id', async () => {
  const b = await bootWorker({ runtimeAvailable: false });
  try {
    b.hext.pause();
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    const r1 = b.request(RID(1), { target_id: T1, expected_revision: t.revision, payload: analyse });
    b.w.tick();
    assert.equal(b.w.state.requests.get(RID(1)).state, 'applied');
    const h1 = b.w.state.requests.get(RID(1)).result.handoff_id;
    assert.equal(b.w.state.handoffs.get(h1).state, 'queued');
    assert.equal(reservationFor(b.w.state, T1).id, h1);
    b.request(RID(2), { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: analyse });
    b.w.tick();
    const r2 = b.w.state.requests.get(RID(2));
    assert.equal(r2.state, 'failed');
    assert.equal(r2.error.code, 'handoff-reserved');
    assert.equal(r2.result.existing_handoff_id, h1);
    assert.equal(r1.id, RID(1));
  } finally { await b.w.stop(); }
});

test('fix runs for one repo serialize while analyses dispatch alongside', async () => {
  const b = await bootWorker({ runtimeAvailable: false });
  try {
    b.hext.pause();
    const t1 = b.ticket(T1, 'LOCAL-a-00000001');
    const t2 = b.ticket(T2, 'LOCAL-b-00000002');
    const t3 = b.ticket('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'LOCAL-c-00000003');
    b.request(RID(3), { target_id: T1, expected_revision: t1.revision, payload: fix });
    b.request(RID(4), { target_id: T2, expected_revision: t2.revision, payload: fix });
    b.request(RID(5), { target_id: t3.id, expected_revision: t3.revision, payload: analyse });
    b.w.tick();
    const queued = [...b.w.state.handoffs.values()];
    assert.equal(queued.length, 3);
    const first = nextDispatchable(b.w.state, { running: new Set() });
    assert.deepEqual(first.map((h) => h.ticket_id), [T1, t3.id], 'second fix on the same repo waits; the analysis does not');
    const h1 = queued.find((h) => h.ticket_id === T1);
    h1.state = 'running';
    const second = nextDispatchable(b.w.state, { running: new Set([h1.id]) });
    assert.deepEqual(second.map((h) => h.ticket_id), [t3.id]);
    h1.state = 'done';
    const third = nextDispatchable(b.w.state, { running: new Set() });
    assert.deepEqual(third.map((h) => h.ticket_id), [T2, t3.id]);
  } finally { await b.w.stop(); }
});
