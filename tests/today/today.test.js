import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildToday, TODAY_DAYS } from '../../src/today/feed.js';
import { renderDigest, writeDigest } from '../../src/today/digest.js';
import { normalizeSchedules } from '../../src/schedule/config.js';

const tl = (at, kind, text) => ({ id: `${at}-${kind}`, at, kind, text, event_id: 'e', content_ref: null, coverage: 'complete' });
function state() {
  const tickets = new Map([
    ['t1', { id: 't1', key: 'PROJ-1', title: 'Retry flake', status: 'review', timeline: [
      tl('2026-10-03T03:00:00Z', 'commit', 'Commit abc fix retry'),
      tl('2026-10-03T03:05:00Z', 'tool', 'Bash git status'),
      tl('2026-10-03T03:10:00Z', 'pr', 'PR https://github.com/a/b/pull/1 observed open'),
      tl('2026-10-03T03:11:00Z', 'status', 'Status active → review'),
      tl('2026-10-02T19:00:00Z', 'write', 'Edit src/retry.js'),
    ], deployments: [] }],
    ['t2', { id: 't2', key: 'PROJ-2', title: 'Deploy <prod>', status: 'deploy-pending', timeline: [
      tl('2026-10-03T05:00:00Z', 'deployment', 'Deployment evidence recorded for 1 obligation(s)'),
      tl('2026-09-20T05:00:00Z', 'commit', 'Ancient commit'),
    ], deployments: [{ environment: 'prod', state: 'pending' }] }],
  ]);
  const sessions = new Map([['s1', { id: 's1', host_session_id: 'abc12345', started_at: '2026-10-03T02:59:00Z', ticket_ids: ['t1'], state: 'live' }]]);
  return { tickets, sessions, meta: { timezone: 'Asia/Kolkata' } };
}

test('Today groups the last seven days by store-local date, newest first, then by ticket with counts; tool noise is left out', () => {
  const today = buildToday(state(), { nowIso: '2026-10-03T12:00:00Z' });
  assert.equal(TODAY_DAYS, 7);
  assert.deepEqual(today.days.map((d) => d.date), ['2026-10-03']);
  const [day] = today.days;
  assert.deepEqual(day.tickets.map((t) => t.key), ['PROJ-2', 'PROJ-1'], 'most recent activity first');
  const p1 = day.tickets.find((t) => t.key === 'PROJ-1');
  assert.deepEqual(p1.counts, { commit: 1, pr: 1, status: 1, write: 1 });
  assert.equal(p1.items.length, 4);
  assert.ok(!p1.items.some((i) => i.kind === 'tool'));
  assert.equal(day.sessions, 1);
  assert.equal(today.timezone, 'Asia/Kolkata');
  const wider = buildToday(state(), { nowIso: '2026-10-03T12:00:00Z', days: 30 });
  assert.deepEqual(wider.days.map((d) => d.date), ['2026-10-03', '2026-09-20']);
});

test('the digest is the Today summary for one day in markdown, with pending deployments; ticket text is plain', () => {
  const day = buildToday(state(), { nowIso: '2026-10-03T12:00:00Z' }).days[0];
  const md = renderDigest(day, { pendingDeployments: [{ ticket_key: 'PROJ-2', environment: 'prod' }] });
  assert.match(md, /^## Session Quill — 2026-10-03$/m);
  assert.match(md, /^- \*\*PROJ-1\*\* Retry flake — 1 commit, 1 PR, 1 status change, 1 file write$/m);
  assert.match(md, /^- \*\*PROJ-2\*\* Deploy <prod> — 1 deployment$/m);
  assert.match(md, /^Awaiting deployment: PROJ-2 \(prod\)$/m);
  assert.match(renderDigest({ date: '2026-10-04', tickets: [], sessions: 0 }), /No tracked activity\./);
});

test('the daily note keeps everything outside its digest section, refreshes the section, and refuses to overwrite an edited section', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dig-'));
  const index = path.join(store, '.index.json');
  const first = writeDigest({ dir: path.join(store, 'daily'), date: '2026-10-03', markdown: '## Session Quill — 2026-10-03\n- one\n', indexPath: index });
  assert.equal(first.path, path.join(store, 'daily', '2026-10-03.md'));
  const file = first.path;
  fs.writeFileSync(file, `# My day\n\nmorning notes\n\n${fs.readFileSync(file, 'utf8')}\nevening notes\n`);
  writeDigest({ dir: path.join(store, 'daily'), date: '2026-10-03', markdown: '## Session Quill — 2026-10-03\n- two\n', indexPath: index });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# My day\n\nmorning notes\n/);
  assert.match(text, /- two/);
  assert.doesNotMatch(text, /- one/);
  assert.match(text, /evening notes/);
  fs.writeFileSync(file, text.replace('- two', '- two, edited by me'));
  assert.throws(() => writeDigest({ dir: path.join(store, 'daily'), date: '2026-10-03', markdown: '## x\n- three\n', indexPath: index }), (e) => e.code === 'digest-conflict');
  assert.match(fs.readFileSync(file, 'utf8'), /edited by me/);
});

test('digest schedules name targets; unknown targets and a file target without a path are reported', () => {
  const { schedules, warnings } = normalizeSchedules({ schedule: [
    { name: 'daily-digest', job: 'digest', cron: '30 19 * * 1-5', to: ['vault-daily'] },
    { name: 'to-file', job: 'digest', every: '1d', to: ['file'], path: 'C:/notes/quill-digest.md', day: 'yesterday' },
    { name: 'slack', job: 'digest', every: '1d', to: ['slack'] },
    { name: 'no-path', job: 'digest', every: '1d', to: ['file'] },
    { name: 'bad-day', job: 'digest', every: '1d', day: 'tomorrow' },
  ] }, { timeZone: 'UTC', now: Date.parse('2026-10-03T08:00:00Z') });
  assert.deepEqual(schedules.map((s) => [s.name, s.to, s.day]), [['daily-digest', ['vault-daily'], 'today'], ['to-file', ['file'], 'yesterday']]);
  const text = warnings.join('\n');
  for (const re of [/slack.*to may contain vault-daily, file/, /no-path.*needs path/, /bad-day.*day must be today or yesterday/]) assert.match(text, re);
});
