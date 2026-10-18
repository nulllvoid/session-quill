// Batch budget (spec §5.2, Task 19): a bulk batch stops starting new members once its RECORDED spend
// reaches `[handoff] max_batch_budget_usd` (default 30). Members already running carry on; the rest
// stay queued, and the Runs page says why with the recorded fact "Batch budget reached".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchBudgetUsd, batchSpend, batchBudgetReached } from '../../src/handoff/resume.js';
import { runFacts, batchBudgetState } from '../../ui/lib/runs.js';
import { renderRuns } from '../../ui/views/runs.js';
import { normalizeSnapshot } from '../../ui/components.js';
import { snapshot as uiSnapshot, TID } from '../ui/fixtures.js';
import { bootWorker, until } from './helpers.js';

const RID = (n) => `29292929-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TICKET = (n) => `${String(n).padStart(8, 'c')}-cccc-4ccc-8ccc-cccccccccccc`;
const BATCH = 'b-0b6a8f8e-5d1c';
const analyse = { mode: 'analyse', note: '', permissions: {}, batch_id: BATCH };

test('a batch of 5 whose recorded spend reaches $30 after 3 keeps the remaining 2 queued with the fact line "Batch budget reached"', async () => {
  // Each run records $10 (the fake runtime's total_cost_usd); one run at a time.
  const b = await bootWorker({ runtimeAvailable: true, maxConcurrent: 1, fakeEnv: { FAKE_CLAUDE_COST: '10', FAKE_CLAUDE_SLEEP_MS: '30' }, handoff: { max_batch_budget_usd: 30 } });
  try {
    const ids = [];
    for (let i = 1; i <= 5; i += 1) {
      const t = b.ticket(TICKET(i), `LOCAL-${'abcde'[i - 1]}-0000000${i}`);
      b.request(RID(i), { target_id: t.id, expected_revision: t.revision, payload: analyse });
      ids.push(b.w.state.requests.get(RID(i)).result.handoff_id);
    }
    await until(() => { b.w.tick(); return ids.slice(0, 3).every((id) => b.w.state.handoffs.get(id).state === 'done'); }, { timeoutMs: 20000 });
    // Well past the point where a free slot would have started the next member.
    for (let i = 0; i < 20; i += 1) { b.w.tick(); await new Promise((r) => setTimeout(r, 25)); }
    const runs = ids.map((id) => b.w.state.handoffs.get(id));
    assert.deepEqual(runs.map((h) => h.state), ['done', 'done', 'done', 'queued', 'queued']);
    assert.deepEqual(runs.slice(0, 3).map((h) => h.cost_usd), [10, 10, 10]);
    assert.equal(batchSpend(runs, BATCH), 30);
    const snap = b.w.liveSnapshot();
    assert.equal(snap.meta.handoff_limits.batch_budget_usd, 30, 'the dashboard knows the budget');
    const queued = snap.handoffs.find((h) => h.id === ids[3]);
    assert.deepEqual(runFacts(snap, queued, b.iso()), ['Queued', 'Batch budget reached']);
    const html = renderRuns(snap, {}, { now: b.iso(), tab: 'live' });
    assert.match(html, /class="run-batch-head"[\s\S]*Batch budget reached[\s\S]*Cancel queued \(2\)/, 'the batch header says so, beside Cancel queued');
  } finally { await b.w.stop(); }
});

test('only recorded spend counts: running and queued members record nothing yet; estimates count', () => {
  const runs = [
    { id: 'a', batch_id: BATCH, state: 'done', cost_usd: 12.5, cost_estimated: true },
    { id: 'b', batch_id: BATCH, state: 'failed', cost_usd: 7.5 },
    { id: 'c', batch_id: BATCH, state: 'running', cost_usd: 99 },
    { id: 'd', batch_id: BATCH, state: 'queued' },
    { id: 'e', batch_id: BATCH, state: 'timed-out', cost_usd: null },
    { id: 'f', batch_id: 'other', state: 'done', cost_usd: 50 },
    { id: 'g', batch_id: BATCH, state: 'cancelled', cost_usd: -3 },
  ];
  assert.equal(batchSpend(runs, BATCH), 20);
  assert.equal(batchBudgetReached(runs, BATCH, 20), true);
  assert.equal(batchBudgetReached(runs, BATCH, 20.01), false);
  assert.equal(batchBudgetReached(runs, null, 0.01), false, 'a run outside a batch has no batch budget');
});

test('max_batch_budget_usd: a positive number, else the default 30', () => {
  assert.equal(batchBudgetUsd({}), 30);
  assert.equal(batchBudgetUsd({ handoff: { max_batch_budget_usd: 12.5 } }), 12.5);
  for (const bad of [0, -1, '40', null, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(batchBudgetUsd({ handoff: { max_batch_budget_usd: bad } }), 30, String(bad));
});

test('the fact line states the recorded fact only: under budget, outside a batch or without a known budget it says nothing more', () => {
  const run = (id, extra) => ({ id, ticket_id: TID(1), request_id: `r-${id}`, mode: 'analyse', recipe: { name: 'analyse', source: 'builtin' }, permissions: {}, access: 'standard', requested_at: '2026-10-02T09:00:00Z', batch_id: BATCH, ...extra });
  const members = [run('a', { state: 'done', cost_usd: 18 }), run('b', { state: 'done', cost_usd: 11 }), run('c', { state: 'queued' })];
  const snap = (handoffs, limits) => normalizeSnapshot({ ...uiSnapshot(), handoffs, meta: { ...uiSnapshot().meta, handoff_limits: limits } });
  const now = '2026-10-02T12:00:00Z';
  assert.deepEqual(runFacts(snap(members, { readonly: 2, fix: 1, batch_budget_usd: 30 }), members[2], now), ['Queued'], '$29 of $30');
  assert.deepEqual(runFacts(snap(members, { readonly: 2, fix: 1, batch_budget_usd: 29 }), members[2], now), ['Queued', 'Batch budget reached']);
  assert.deepEqual(runFacts(snap(members, { readonly: 2, fix: 1 }), members[2], now), ['Queued'], 'an export or an older worker sends no budget');
  const lone = run('d', { state: 'queued', batch_id: null });
  assert.deepEqual(runFacts(snap([...members, lone], { readonly: 2, fix: 1, batch_budget_usd: 1 }), lone, now), ['Queued']);
  // A running member is never described as held by the budget.
  const running = run('e', { state: 'running', started_at: '2026-10-02T11:59:30Z' });
  assert.deepEqual(runFacts(snap([...members, running], { readonly: 2, fix: 1, batch_budget_usd: 1 }), running, now), ['Running for under a minute']);
  assert.deepEqual(batchBudgetState(snap(members, { readonly: 2, fix: 1, batch_budget_usd: 29 }), BATCH), { spent: 29, budget: 29, reached: true });
  assert.equal(batchBudgetState(snap(members, { readonly: 2, fix: 1 }), BATCH), null);
});

test('an export keeps the slot caps but never the batch budget, and its rows never say the budget was reached', async () => {
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const run = { id: 'a', ticket_id: TID(1), request_id: 'r-a', mode: 'analyse', recipe: { name: 'analyse', source: 'builtin' }, permissions: {}, access: 'standard', requested_at: '2026-10-02T09:00:00Z', batch_id: BATCH, state: 'done', cost_usd: 40 };
  const queued = { ...run, id: 'b', request_id: 'r-b', state: 'queued', cost_usd: null };
  const owner = { ...uiSnapshot(), handoffs: [run, queued], meta: { ...uiSnapshot().meta, handoff_limits: { readonly: 2, fix: 1, batch_budget_usd: 30 } } };
  const exported = sanitizeSnapshot(owner, { exportedAt: '2026-10-02T12:00:00Z' });
  assert.deepEqual(exported.meta.handoff_limits, { readonly: 2, fix: 1 });
  assert.doesNotMatch(JSON.stringify(exported), /batch_budget_usd|cost_usd/);
  assert.deepEqual(runFacts(normalizeSnapshot(exported), exported.handoffs.find((h) => h.id === 'b'), '2026-10-02T12:00:00Z'), ['Queued']);
});
