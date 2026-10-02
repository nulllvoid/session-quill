import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextAfter, parseInterval } from '../../src/schedule/cron.js';

const at = (iso) => Date.parse(iso);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString().replace('.000Z', 'Z'));

test('parseCron accepts lists, ranges, steps and names, and rejects malformed fields', () => {
  assert.doesNotThrow(() => parseCron('0 */2 * * *'));
  assert.doesNotThrow(() => parseCron('5,35 9-17/2 1-15 JAN-MAR mon-fri'));
  for (const bad of ['* * *', '60 * * * *', '*/0 * * * *', '5-1 * * * *', 'x * * * *', '0 0 * 13 *', '0 0 * * 8']) {
    assert.throws(() => parseCron(bad), (e) => e.code === 'schedule-invalid', bad);
  }
});

test('nextAfter is strictly after the reference, in UTC and in an offset time zone', () => {
  const every2h = parseCron('0 */2 * * *');
  assert.equal(iso(nextAfter(every2h, at('2026-10-02T09:15:00Z'), 'UTC')), '2026-10-02T10:00:00Z');
  assert.equal(iso(nextAfter(every2h, at('2026-10-02T10:00:00Z'), 'UTC')), '2026-10-02T12:00:00Z');
  const weekdayEvening = parseCron('30 19 * * 1-5');
  // 2026-10-02 is a Friday; 19:30 in Kolkata (UTC+05:30) is 14:00 UTC.
  assert.equal(iso(nextAfter(weekdayEvening, at('2026-10-02T00:00:00Z'), 'Asia/Kolkata')), '2026-10-02T14:00:00Z');
  assert.equal(iso(nextAfter(weekdayEvening, at('2026-10-02T14:00:00Z'), 'Asia/Kolkata')), '2026-10-05T14:00:00Z', 'the weekend is skipped');
});

test('a wall time that does not exist on a DST change is skipped, and day-of-month OR day-of-week applies', () => {
  const twoThirty = parseCron('30 2 * * *');
  // New York springs forward on Sunday 2026-03-08: 02:30 does not exist that day.
  assert.equal(iso(nextAfter(twoThirty, at('2026-03-07T12:00:00Z'), 'America/New_York')), '2026-03-09T06:30:00Z');
  const thirteenthOrFriday = parseCron('0 0 13 * 5');
  assert.equal(iso(nextAfter(thirteenthOrFriday, at('2026-10-02T00:30:00Z'), 'UTC')), '2026-10-09T00:00:00Z');
  assert.equal(nextAfter(parseCron('0 0 30 2 *'), at('2026-10-02T00:00:00Z'), 'UTC'), null, 'February 30th never comes');
});

test('nextAfter for every minute is quick; parseInterval takes minutes, hours or days', () => {
  const started = process.hrtime.bigint();
  assert.equal(iso(nextAfter(parseCron('* * * * *'), at('2026-10-02T09:15:30Z'), 'Asia/Kolkata')), '2026-10-02T09:16:00Z');
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 100);
  assert.equal(parseInterval('2h'), 7_200_000);
  assert.equal(parseInterval('30m'), 1_800_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  for (const bad of ['0m', '1s', 'often', '']) assert.throws(() => parseInterval(bad), (e) => e.code === 'schedule-invalid', bad);
});
