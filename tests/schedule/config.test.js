import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedules, defaultSchedules } from '../../src/schedule/config.js';

const NOW = Date.parse('2026-10-02T08:00:00Z');

test('with no [[schedule]] the reconcile job runs every sync_interval_hours, as before', () => {
  assert.deepEqual(normalizeSchedules({ sync_interval_hours: 3 }).schedules.map((s) => [s.name, s.job, s.every, s.interval_ms, s.enabled]), [['reconcile', 'reconcile', '3h', 3 * 3_600_000, true]]);
  assert.equal(defaultSchedules({}).at(0).every, '2h');
});

test('schedules are validated; planned jobs and broken entries are reported and skipped', () => {
  const { schedules, warnings } = normalizeSchedules({ schedule: [
    { name: 'reconcile', job: 'reconcile', every: '2h' },
    { name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5' },
    { name: 'paused', job: 'reconcile', every: '1d', enabled: false },
    { name: 'nightly-sweep', job: 'stale-sweep', cron: '30 19 * * 1-5' },
    { name: 'bad-cron', job: 'reconcile', cron: '61 * * * *' },
    { name: 'both', job: 'reconcile', cron: '* * * * *', every: '1h' },
    { name: 'evening', job: 'reconcile', every: '1h' },
    { name: 'Bad Name', job: 'reconcile', every: '1h' },
    { name: 'mystery', job: 'mine-bitcoin', every: '1h' },
    { name: 'never', job: 'reconcile', cron: '0 0 30 2 *' },
  ] }, { timeZone: 'UTC', now: NOW });
  assert.deepEqual(schedules.map((s) => [s.name, s.enabled]), [['reconcile', true], ['evening', true], ['paused', false]]);
  assert.equal(schedules[1].cron, '30 19 * * 1-5');
  const text = warnings.join('\n');
  for (const expected of [/nightly-sweep.*later release/, /bad-cron.*minute/, /both.*exactly one/, /evening.*duplicate/, /lowercase/, /mystery.*unknown job/, /never.*never fires/]) assert.match(text, expected);
});
