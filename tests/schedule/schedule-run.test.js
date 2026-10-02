import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newState, ev, resetSeq } from '../core/helpers.js';

beforeEach(() => resetSeq());
const run = (state, phase, run_id, extra = {}, at = '2026-10-02T08:00:00Z') => ev(state, 'schedule-run', { schedule: 'reconcile', job: 'reconcile', run_id, phase, ...extra }, { producer: 'worker', occurred_at: at });

test('started and finished runs are folded into the schedule record, newest first', () => {
  const state = newState();
  run(state, 'started', 'r1', { trigger: 'schedule' });
  const rec = state.schedules.get('reconcile');
  assert.equal(rec.running_run_id, 'r1');
  assert.equal(rec.runs[0].outcome, 'running');
  run(state, 'finished', 'r1', { outcome: 'ok', summary: '3 PR checks' }, '2026-10-02T08:00:05Z');
  assert.deepEqual([rec.running_run_id, rec.last_outcome, rec.last_summary, rec.last_started_at, rec.last_finished_at], [null, 'ok', '3 PR checks', '2026-10-02T08:00:00Z', '2026-10-02T08:00:05Z']);
  run(state, 'started', 'r2', { trigger: 'manual' }, '2026-10-02T09:00:00Z');
  run(state, 'finished', 'r2', { outcome: 'failed', error: 'gh: offline' }, '2026-10-02T09:00:01Z');
  assert.deepEqual(rec.runs.map((r) => [r.run_id, r.trigger, r.outcome, r.error]), [['r2', 'manual', 'failed', 'gh: offline'], ['r1', 'schedule', 'ok', null]]);
});

test('history is capped at 20 runs; malformed payloads are rejected', () => {
  const state = newState();
  for (let i = 0; i < 25; i += 1) { run(state, 'started', `r${i}`); run(state, 'finished', `r${i}`, { outcome: 'ok' }); }
  assert.equal(state.schedules.get('reconcile').runs.length, 20);
  assert.equal(state.schedules.get('reconcile').runs[0].run_id, 'r24');
  assert.equal(ev(state, 'schedule-run', { phase: 'started' }, { producer: 'worker' }).rejected, 'schedule-invalid');
  assert.equal(run(state, 'paused', 'x').rejected, 'schedule-invalid');
});
