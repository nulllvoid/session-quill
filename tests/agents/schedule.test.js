import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeSchedules } from '../../src/schedule/config.js';
import { createJobs } from '../../src/schedule/jobs.js';
import { submitRequest } from '../../src/server/requests.js';
import { bootWorker, makeRepo } from '../handoff/helpers.js';

const NOW = Date.parse('2026-10-03T08:00:00Z');
const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false, edit_files: false, delete_files: false };

test('agent schedules name a recipe, a ticket scope and a limit; bad ones are reported and skipped', () => {
  const { schedules, warnings } = normalizeSchedules({ schedule: [
    { name: 'deploy-followup', job: 'agent', cron: '0 11 * * 1-5', recipe: 'deploy-check', scope: 'deploy-pending' },
    { name: 'standups', job: 'agent', every: '1d', recipe: 'standup', scope: 'active', limit: 3 },
    { name: 'no-recipe', job: 'agent', every: '1d', scope: 'active' },
    { name: 'odd-scope', job: 'agent', every: '1d', recipe: 'standup', scope: 'everything' },
    { name: 'huge', job: 'agent', every: '1d', recipe: 'standup', scope: 'open', limit: 500 },
  ] }, { timeZone: 'UTC', now: NOW });
  assert.deepEqual(schedules.map((s) => [s.name, s.recipe, s.scope, s.limit]), [['deploy-followup', 'deploy-check', 'deploy-pending', 10], ['standups', 'standup', 'active', 3]]);
  const text = warnings.join('\n');
  for (const re of [/no-recipe.*needs recipe/, /odd-scope.*scope must be one of deploy-pending, active, review, blocked, open/, /huge.*limit must be a whole number from 1 to 25/]) assert.match(text, re);
});

test('the agent job queues one run per ticket in scope, oldest first, skips tickets already running and respects the limit', async () => {
  const b = await bootWorker({ repo: makeRepo(), runtimeAvailable: true });
  b.hext.pause();
  try {
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000004'];
    ids.forEach((id, i) => { b.ticket(id, `PROJ-${i + 1}`); b.advance(1000); });
    for (const id of ids.slice(0, 3)) b.w.emit('ticket-update', { ticket_id: id, fields: { status: 'deploy-pending' }, source: 'manual' });
    const busy = b.w.state.tickets.get(ids[0]);
    submitRequest(b.w, { id: randomUUID(), kind: 'handoff', target_id: busy.id, expected_revision: busy.revision, payload: { recipe: 'standup', note: '', permissions: NONE } });
    b.w.tick();
    const jobs = createJobs({ providers: null });
    const r = await jobs.agent(b.w, { run_id: 'run-1', reason: 'scheduled', schedule: 'deploy-followup', settings: { recipe: 'deploy-check', scope: 'deploy-pending', limit: 1 } });
    assert.equal(r.summary, 'queued 1 deploy-check run (1 already running, 1 over the limit)');
    b.w.tick();
    const queued = [...b.w.state.handoffs.values()].filter((h) => h.recipe.name === 'deploy-check');
    assert.deepEqual(queued.map((h) => b.w.state.tickets.get(h.ticket_id).key), ['PROJ-2']);
    assert.deepEqual(queued[0].permissions, { ...NONE, read_source: true }, 'scheduled runs get read access at most, never side effects');
    const req = b.w.state.requests.get(queued[0].request_id);
    assert.equal(req.actor_id, 'schedule:deploy-followup');
    await assert.rejects(jobs.agent(b.w, { run_id: 'run-2', reason: 'scheduled', schedule: 'fixes', settings: { recipe: 'attempt-fix', scope: 'open', limit: 5 } }), /attempt-fix edits source and cannot run on a schedule/);
    await assert.rejects(jobs.agent(b.w, { run_id: 'run-3', reason: 'scheduled', schedule: 'gone', settings: { recipe: 'nope', scope: 'open', limit: 5 } }), /no recipe named nope/);
  } finally { await b.w.stop(); }
});
