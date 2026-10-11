// Runs model (spec §2): tabs, grouping and the facts a row may state, from snapshot records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, EMPTY_FILTERS } from '../../ui/components.js';
import { runTabs, needsYou, groupRuns, runFacts, supersededBy, defaultRunTab, visibleRunTabs, liveRunCount, needsYouCount, ticketRuns, RUN_TABS } from '../../ui/lib/runs.js';
import { snapshot, TID } from './fixtures.js';

const NOW = '2026-10-10T12:00:00Z';
let seq = 0;
export const run = (extra = {}) => ({ id: `run-${++seq}`, ticket_id: TID(1), request_id: `req-${seq}`, mode: 'analyse', permissions: {}, repo_id: 'demo', state: 'done', requested_at: '2026-10-10T10:00:00Z', started_at: '2026-10-10T10:00:05Z', finished_at: '2026-10-10T10:05:00Z', error: null, suggestions: [], changed_files: [], uncertain_effects: [], ...extra });
const snap = (handoffs, extra = {}) => normalizeSnapshot({ ...snapshot(), handoffs, ...extra });
const ids = (items) => items.map((i) => i.id);

test('Live holds queued and running; Failed holds failed, timed-out and cancelled', () => {
  const q = run({ state: 'queued' }), r = run({ state: 'running' }), f = run({ state: 'failed' }), to = run({ state: 'timed-out' }), c = run({ state: 'cancelled' }), d = run();
  const tabs = runTabs(snap([q, r, f, to, c, d]), EMPTY_FILTERS, NOW);
  assert.deepEqual(new Set(ids(tabs.live)), new Set([q.id, r.id]));
  assert.deepEqual(new Set(ids(tabs.failed)), new Set([f.id, to.id, c.id]));
  assert.equal(tabs.all.length, 6);
});

test('Needs you: open suggestions, recent unsuperseded failures on open tickets, open proposals; never cancelled runs', () => {
  const withSuggestion = run({ suggestions: [{ id: 's1', type: 'next-action', text: 'x', state: 'proposed' }] });
  const resolved = run({ suggestions: [{ id: 's2', type: 'next-action', text: 'x', state: 'accepted' }] });
  const recentFail = run({ state: 'failed', ticket_id: TID(2), finished_at: '2026-10-09T12:00:00Z' });
  const oldFail = run({ state: 'failed', ticket_id: TID(3), finished_at: '2026-10-01T12:00:00Z' });
  const doneTicketFail = run({ state: 'failed', ticket_id: TID(4), finished_at: '2026-10-09T12:00:00Z' });
  const cancelled = run({ state: 'cancelled', ticket_id: TID(5), finished_at: '2026-10-09T12:00:00Z' });
  const supersededFail = run({ state: 'timed-out', ticket_id: TID(6), requested_at: '2026-10-09T10:00:00Z', finished_at: '2026-10-09T10:20:00Z' });
  const later = run({ state: 'done', ticket_id: TID(6), requested_at: '2026-10-09T11:00:00Z' });
  const proposal = { id: 'p1', ticket_id: TID(1), state: 'proposed', proposed_at: '2026-10-10T11:00:00Z', recipe: { name: 'analyse' } };
  const expired = { id: 'p2', ticket_id: TID(1), state: 'expired', proposed_at: '2026-09-01T11:00:00Z', recipe: { name: 'analyse' } };
  const s = snap([withSuggestion, resolved, recentFail, oldFail, doneTicketFail, cancelled, supersededFail, later], { run_proposals: [proposal, expired] });
  const needs = ids(runTabs(s, EMPTY_FILTERS, NOW).needs);
  assert.deepEqual(new Set(needs), new Set([withSuggestion.id, recentFail.id, 'p1']));
  assert.equal(needsYou(s, cancelled, NOW), false);
  assert.ok(ids(runTabs(s, EMPTY_FILTERS, NOW).all).includes('p2'), 'expired proposals stay visible in All');
  assert.equal(needsYouCount(s, NOW), 3);
});

test('a retry is told apart from a later unrelated run', () => {
  const failed = run({ state: 'failed', requested_at: '2026-10-09T10:00:00Z' });
  const retry = run({ requested_at: '2026-10-09T11:00:00Z', retry_of: failed.id });
  const link = supersededBy(snap([failed, retry]), failed);
  assert.equal(link.retried, true);
  assert.equal(link.run.id, retry.id);
  const other = run({ requested_at: '2026-10-09T11:00:00Z' });
  assert.equal(supersededBy(snap([failed, other]), failed).retried, false);
  assert.equal(supersededBy(snap([failed]), failed), null);
});

test('All covers 30 days, filters apply through the ticket, and a missing ticket is kept only without filters', () => {
  const old = run({ requested_at: '2026-09-01T10:00:00Z' });
  const orphan = run({ ticket_id: 'gone' });
  const s = snap([old, orphan]);
  assert.deepEqual(ids(runTabs(s, EMPTY_FILTERS, NOW).all), [orphan.id]);
  assert.deepEqual(runTabs(s, { ...EMPTY_FILTERS, category: 'bugfix' }, NOW).all, []);
});

test('groupRuns keeps batches together at the position of their newest member', () => {
  const a1 = { kind: 'run', id: 'a1', at: '3', run: { batch_id: 'B' } };
  const solo = { kind: 'run', id: 's', at: '2', run: {} };
  const a2 = { kind: 'run', id: 'a2', at: '1', run: { batch_id: 'B' } };
  const out = groupRuns([a1, solo, a2]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'batch');
  assert.deepEqual(out[0].items.map((i) => i.id), ['a1', 'a2']);
  assert.equal(out[1].id, 's');
});

test('queued facts state occupancy only; repository busy only for a queued fix', () => {
  const runningRead = run({ state: 'running', repo_id: 'demo' });
  const runningRead2 = run({ state: 'running', repo_id: 'demo' });
  const queuedRead = run({ state: 'queued' });
  const s = snap([runningRead, runningRead2, queuedRead], { meta: { ...snapshot().meta, handoff_limits: { readonly: 2, fix: 1 } } });
  assert.deepEqual(runFacts(s, queuedRead, NOW), ['Queued', 'read-only slots 2/2 in use']);
  const runningFix = run({ state: 'running', permissions: { edit_source: true }, repo_id: 'demo' });
  const queuedFix = run({ state: 'queued', permissions: { edit_source: true }, repo_id: 'demo' });
  const s2 = snap([runningFix, queuedFix], { meta: { ...snapshot().meta, handoff_limits: { readonly: 2, fix: 1 } } });
  assert.deepEqual(runFacts(s2, queuedFix, NOW), ['Queued', 'fix slots 1/1 in use', 'repository busy']);
  assert.deepEqual(runFacts(snap([queuedRead]), queuedRead, NOW), ['Queued'], 'no caps known, no claim');
  for (const f of [...runFacts(s, queuedRead, NOW), ...runFacts(s2, queuedFix, NOW)]) assert.doesNotMatch(f, /\b(eta|minutes? left|because)\b/i);
});

test('running facts never claim an agent or test phase', () => {
  const r = run({ state: 'running', started_at: '2026-10-10T11:58:00Z', timings: { queue_wait_ms: 1000, worktree_ms: 4000 } });
  const facts = runFacts(snap([r]), r, NOW);
  assert.match(facts[0], /^Running for /);
  assert.match(facts[1], /^setup /);
  assert.equal(facts.some((f) => /agent|tests?/i.test(f)), false);
});

test('done and failed facts', () => {
  const d = run({ suggestions: [{ id: 'a', state: 'proposed' }, { id: 'b', state: 'proposed' }], changed_files: ['a.js'], pr_url: 'https://x/pr/1' });
  assert.deepEqual(runFacts(snap([d]), d, NOW), ['2 suggestions to review', '1 file changed', 'draft PR opened']);
  const f = run({ state: 'failed', error: { message: 'tests failed after repair' }, requested_at: '2026-10-09T10:00:00Z' });
  const retry = run({ retry_of: f.id, requested_at: '2026-10-09T11:00:00Z' });
  assert.deepEqual(runFacts(snap([f, retry]), f, NOW), ['tests failed after repair', 'Retried as a new run']);
});

test('tabs, defaults and counts', () => {
  const s = snap([run({ state: 'queued' })]);
  assert.deepEqual(visibleRunTabs(s), RUN_TABS);
  const exported = snap([run({ state: 'queued' })], { meta: { ...snapshot().meta, exported_at: NOW }, capabilities: { read: true } });
  assert.deepEqual(visibleRunTabs(exported), ['live', 'failed', 'all']);
  assert.deepEqual(runTabs(exported, EMPTY_FILTERS, NOW).needs, []);
  const tabs = runTabs(s, EMPTY_FILTERS, NOW);
  assert.equal(defaultRunTab(tabs, RUN_TABS), 'live');
  assert.equal(defaultRunTab({ needs: [], live: [], failed: [], all: [] }, RUN_TABS), 'all');
  assert.equal(liveRunCount(s), 1);
  assert.equal(ticketRuns(snap([run({ requested_at: '1' }), run({ requested_at: '2' })]), TID(1))[0].requested_at, '2');
});
