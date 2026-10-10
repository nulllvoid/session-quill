import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIso, parseIso, addMs, ageMs, isoDateInZone, dateDiffDays, isIsoZ, isDate } from '../../src/lib/time.js';

test('toIso normalizes to UTC with Z and no fractional seconds', () => {
  assert.equal(toIso(Date.UTC(2026, 9, 2, 8, 5, 0, 123)), '2026-10-02T08:05:00Z');
  assert.equal(toIso('2026-10-02T10:05:00+02:00'), '2026-10-02T08:05:00Z');
});

test('parseIso/addMs/ageMs', () => {
  assert.equal(parseIso('2026-10-02T08:05:00Z'), Date.UTC(2026, 9, 2, 8, 5, 0));
  assert.equal(addMs('2026-10-02T08:05:00Z', 60_000), '2026-10-02T08:06:00Z');
  assert.equal(ageMs('2026-10-02T08:05:00Z', '2026-10-02T08:06:00Z'), 60_000);
});

test('isoDateInZone uses the IANA zone', () => {
  assert.equal(isoDateInZone('2026-10-02T23:30:00Z', 'Asia/Kolkata'), '2026-10-03');
  assert.equal(isoDateInZone('2026-10-02T23:30:00Z', 'UTC'), '2026-10-02');
});

test('dateDiffDays and validators', () => {
  assert.equal(dateDiffDays('2026-10-05', '2026-10-02'), 3);
  assert.equal(isIsoZ('2026-10-02T08:05:00Z'), true);
  assert.equal(isIsoZ('2026-10-02T08:05:00+00:00'), false);
  assert.equal(isDate('2026-10-02'), true);
  assert.equal(isDate('2026-13-02'), false);
});

test('formatDuration and the handoff list timings line (ADR 0022)', async () => {
  const { formatDuration } = await import('../../src/lib/time.js');
  const { timingsText } = await import('../../src/cli/commands/handoff.js');
  assert.deepEqual([450, 1234, 12_400, 95_000].map(formatDuration), ['450 ms', '1.2 s', '12 s', '1 min 35 s']);
  assert.equal(timingsText({ queue_wait_ms: 2000, worktree_ms: 850, agent_ms: 95_000 }), 'wait 2.0 s, setup 850 ms, agent 1 min 35 s');
  assert.equal(timingsText({ queue_wait_ms: 0, agent_ms: 30_000 }), 'wait 0 ms, agent 30 s');
  assert.equal(timingsText(undefined), '');
  assert.equal(timingsText({ queue_wait_ms: 0, worktree_ms: 900, agent_ms: 30_000, test_ms: 12_400 }), 'wait 0 ms, setup 900 ms, agent 30 s, tests 12 s', 'test time once the gate ran (ADR 0023)');
});
