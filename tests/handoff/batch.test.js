import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { batchCancelTargets } from '../../src/cli/commands/handoff.js';
import { bootWorker, T1, T2 } from './helpers.js';

const RID = (n) => `44444444-0000-4000-8000-${String(n).padStart(12, '0')}`;
const analyse = { mode: 'analyse', note: '', permissions: {} };
const BATCH = '0b6a8f8e-5d1c-4c1e-9a55-3b1f2c7d9e10';

test('a handoff request may carry a batch id of up to 64 safe characters', () => {
  assert.equal(validateHandoffRequest({ ...analyse, batch_id: BATCH }, {}).batch_id, BATCH);
  assert.equal('batch_id' in validateHandoffRequest(analyse, {}), false, 'no batch id, no field');
  for (const bad of ['', 'x'.repeat(65), 'has space', 42, 'semi;colon']) {
    assert.throws(() => validateHandoffRequest({ ...analyse, batch_id: bad }, {}), (e) => e.code === 'batch-invalid', String(bad));
  }
});

test('the batch id is stored on each run and reaches the projection', async () => {
  const b = await bootWorker({ runtimeAvailable: false });
  try {
    b.hext.pause();
    const t1 = b.ticket(T1, 'LOCAL-a-00000001');
    const t2 = b.ticket(T2, 'LOCAL-b-00000002');
    b.request(RID(1), { target_id: T1, expected_revision: t1.revision, payload: { ...analyse, batch_id: BATCH } });
    b.request(RID(2), { target_id: T2, expected_revision: t2.revision, payload: analyse });
    b.w.tick();
    const runs = [...b.w.state.handoffs.values()];
    assert.equal(runs.find((h) => h.ticket_id === T1).batch_id, BATCH);
    assert.equal(runs.find((h) => h.ticket_id === T2).batch_id, null);
    assert.equal(b.w.liveSnapshot().handoffs.find((h) => h.ticket_id === T1).batch_id, BATCH);
  } finally { await b.w.stop(); }
});

test('cancelling a batch targets its queued runs only', () => {
  const snap = { handoffs: [
    { id: 'h1', ticket_id: 't1', batch_id: BATCH, state: 'queued' },
    { id: 'h2', ticket_id: 't2', batch_id: BATCH, state: 'running' },
    { id: 'h3', ticket_id: 't3', batch_id: BATCH, state: 'done' },
    { id: 'h4', ticket_id: 't4', batch_id: 'other', state: 'queued' },
    { id: 'h5', ticket_id: 't5', batch_id: BATCH, state: 'queued', cancel_requested: true },
  ] };
  assert.deepEqual(batchCancelTargets(snap, BATCH).map((h) => h.id), ['h1']);
  assert.deepEqual(batchCancelTargets(snap, BATCH.slice(0, 8)).map((h) => h.id), ['h1'], 'a unique prefix names the batch');
  assert.deepEqual(batchCancelTargets(snap, 'nope'), []);
});

test('quill handoff cancel needs a batch id after --batch, or a run id', async () => {
  const { makeHome, cli } = await import('../cli/helpers.js');
  const fx = makeHome();
  for (const argv of [['handoff', 'cancel', '--batch'], ['handoff', 'cancel', '--batch', ''], ['handoff', 'cancel']]) {
    const r = await cli(argv, fx.env);
    assert.notEqual(r.code, 0, argv.join(' '));
    assert.match(r.err, /usage: .*handoff cancel/i, argv.join(' '));
  }
});
