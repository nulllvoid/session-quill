import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, newTicket } from '../../src/core/state.js';
import { applyEvent } from '../../src/core/reducer.js';
import { makeEvent } from '../../src/core/events.js';
import { runReconciliation } from '../../src/reconcile/run.js';

const NOW = '2026-10-30T08:00:00Z';
const OLD = '2026-08-01T08:00:00Z';
const url = (n) => `https://github.com/acme/demo/pull/${n}`;
function fixture() {
  let now = NOW;
  const state = createState({ store_id: '33333333-3333-4333-8333-333333333333', machine_id: '22222222-2222-4222-8222-222222222222', repos: { demo: { provider: 'github', default_branch: 'main', canonical_path: '/unused', deployment_environments: [] } } });
  const events = [];
  const worker = { state, config: {}, now: () => now, ingestOnce() {}, markGenerationDirty() {}, publishGeneration() {}, environmentsResolution: () => ({ list: [] }), environmentsFor: () => [], emit(kind, payload) {
    const ev = makeEvent({ kind, payload, store_id: state.meta.store_id, machine_id: state.meta.machine_id, producer: 'worker', occurred_at: now });
    ev.sequence = events.length + 1;
    events.push(ev);
    applyEvent(worker.state, ev);
  } };
  const ticket = (n, { branch = null, at = NOW, pr = true } = {}) => {
    const t = newTicket(state, { id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, key: `LOCAL-${n}`, title: `Work ${n}`, repo_id: 'demo', project_id: 'demo', created_at: at, status: 'active', status_source: 'evidence' });
    if (pr) t.prs.push({ id: `pr-${n}`, url: url(n), state: 'open', provider: 'github', opened_at: at, observed_at: at });
    if (branch) t.branches = [{ name: branch, first_seen: at, last_seen: at }];
    state.tickets.set(t.id, t);
    return t;
  };
  return { state, worker, ticket, events, setNow: (v) => { now = v; } };
}
const providers = (ops = {}) => ({ for: () => ({ name: 'github', fetchPr: async () => ({ state: 'open' }), ...ops }) });

test('201 open PRs all receive a check across two bounded passes, including after journal replay', async () => {
  const f = fixture();
  for (let i = 1; i <= 201; i++) f.ticket(i);
  const initial = structuredClone(f.state);
  const first = await runReconciliation(f.worker, { providers: providers() });
  assert.equal(first.pr_updates.length, 200);
  for (const ev of f.events) applyEvent(initial, ev);
  f.worker.state = initial;
  f.setNow('2026-10-30T10:00:00Z');
  const second = await runReconciliation(f.worker, { providers: providers() });
  assert.ok(second.pr_updates.some((p) => p.url === url(201)), 'the previously capped PR is checked first');
  assert.equal(second.pr_updates[0].url, url(201));
  assert.equal(first.coverage.remaining_eligible, 1);
  assert.equal(first.coverage.oldest_unchecked_at, NOW);
  assert.equal(first.checks.length, 200);
  assert.equal(initial.reconcileChecks.size, 201);
});

test('a provider error survives later success and retries back off while Refresh bypasses eligibility', async () => {
  const f = fixture();
  f.ticket(1); f.ticket(2);
  const p = providers({ fetchPr: async (u) => { if (u === url(1)) throw new Error('unavailable'); return { state: 'open' }; } });
  const first = await runReconciliation(f.worker, { providers: p });
  assert.match(first.provider_health[0].error, /unavailable/);
  assert.equal(first.coverage.failed, 1);
  const second = await runReconciliation(f.worker, { providers: p });
  assert.equal(second.coverage.checked, 0);
  assert.equal(second.coverage.deferred, 2);
  const refresh = await runReconciliation(f.worker, { reason: 'refresh', providers: p });
  assert.equal(refresh.coverage.checked, 2);
  const failed = refresh.checks.find((c) => c.error);
  assert.equal(failed.failure_count, 2);
  assert.ok(failed.next_check_at > first.checks.find((c) => c.error).next_check_at);
});

test('old unresolved run and branch targets remain checkable on a slower sweep', async () => {
  const f = fixture();
  const t = f.ticket(1, { branch: 'fix/old', at: OLD, pr: false });
  f.state.handoffs.set('old-run', { id: 'old-run', ticket_id: t.id, repo_id: 'demo', state: 'done', branch: 'fix/old', pr_url: url(1), finished_at: OLD });
  const p = providers({ findPrs: async () => [] });
  const first = await runReconciliation(f.worker, { providers: p });
  assert.ok(first.pr_updates.some((p) => p.handoff_id === 'old-run'));
  assert.equal(first.coverage.by_kind.branch.checked, 1);
  assert.ok(first.checks.every((c) => c.next_check_at >= '2026-10-31T08:00:00Z'));
  f.setNow('2026-10-30T10:00:00Z');
  assert.equal((await runReconciliation(f.worker, { providers: p })).coverage.checked, 0);
  f.setNow('2026-10-31T08:00:00Z');
  assert.equal((await runReconciliation(f.worker, { providers: p })).coverage.checked, 2);
});

test('reused branches discover a newer PR without attributing a merge predating captured work', async () => {
  const f = fixture();
  const t = f.ticket(1, { branch: 'fix/reused', pr: false });
  t.prs.push({ id: 'previous', url: url(1), state: 'closed', head_branch: 'fix/reused', observed_at: OLD });
  const oldMerge = { url: url(2), state: 'merged', head_branch: 'fix/reused', opened_at: OLD, merged_at: '2026-10-29T08:00:00Z' };
  const newer = { url: url(3), state: 'open', head_branch: 'fix/reused', opened_at: NOW };
  const result = await runReconciliation(f.worker, { providers: providers({ findPrs: async () => [oldMerge, newer] }) });
  assert.deepEqual(result.pr_updates.filter((p) => p.link).map((p) => p.url), [url(3)]);
});

test('run PRs emit explicit origin links and invalid deployment configuration blocks all merge paths', async () => {
  const f = fixture();
  const t = f.ticket(1, { branch: 'fix/work', at: OLD, pr: false });
  f.state.handoffs.set('run', { id: 'run', ticket_id: t.id, repo_id: 'demo', state: 'done', branch: 'fix/work', pr_url: url(1), finished_at: NOW });
  const merged = { url: url(1), state: 'merged', head_branch: 'fix/work', opened_at: OLD, merged_at: NOW, base_branch: 'main' };
  const p = providers({ fetchPr: async () => merged, findPrs: async () => [{ ...merged, url: url(2) }] });
  f.worker.environmentsResolution = () => ({ error: 'invalid-environments' });
  const bad = await runReconciliation(f.worker, { providers: p });
  assert.equal(bad.pr_updates.filter((p) => p.state === 'merged' && !p.error).length, 0);
  assert.equal(bad.coverage.failed, 2);
  f.worker.environmentsResolution = () => ({ list: [] });
  const good = await runReconciliation(f.worker, { reason: 'refresh', providers: p });
  const link = good.pr_updates.find((p) => p.origin_handoff_id === 'run');
  assert.equal(link.ticket_id, t.id);
  assert.equal(link.link, true);
  assert.equal(link.handoff_id, undefined, 'a link must pass through the ordinary ticket reducer');
  assert.ok(good.pr_updates.some((p) => p.handoff_id === 'run'));
});

for (const kind of ['branch', 'run-pr']) {
  test(`${kind} checks rotate across the 50-target cap, including manual refresh`, async () => {
    const f = fixture();
    for (let n = 1; n <= 51; n++) {
      const branch = `fix/${String(n).padStart(3, '0')}`;
      const t = f.ticket(n, { branch: kind === 'branch' ? branch : null, pr: false });
      if (kind === 'run-pr') f.state.handoffs.set(`run-${n}`, { id: `run-${n}`, ticket_id: t.id, repo_id: 'demo', state: 'done', pr_url: url(n), finished_at: NOW });
    }
    const p = providers({ findPrs: async () => [] });
    const first = await runReconciliation(f.worker, { providers: p });
    const second = await runReconciliation(f.worker, { providers: p, reason: 'refresh' });
    assert.equal(first.coverage.checked, 50);
    assert.equal(first.coverage.remaining_eligible, 1);
    assert.equal(second.coverage.checked, 50, 'manual refresh still respects the cap');
    assert.equal(new Set([...first.checks, ...second.checks].map((c) => c.key)).size, 51);
  });
}

test('a newer merge on a reused branch cannot cover work already bounded by an older terminal PR', async () => {
  const f = fixture();
  const t = f.ticket(1, { branch: 'fix/reused', pr: false, at: OLD });
  t.prs.push({ id: 'closed', url: url(1), state: 'closed', head_branch: 'fix/reused', observed_at: '2026-09-01T08:00:00Z' });
  const newer = { url: url(2), state: 'merged', head_branch: 'fix/reused', opened_at: '2026-10-29T08:00:00Z', merged_at: NOW };
  const result = await runReconciliation(f.worker, { providers: providers({ findPrs: async () => [newer] }) });
  assert.equal(result.pr_updates.filter((p) => p.link).length, 0);
});

test('settled legacy run observations without ticket links are rechecked for trustworthy backfill', async () => {
  const f = fixture();
  const t = f.ticket(1, { pr: false, at: OLD });
  f.state.handoffs.set('run', { id: 'run', ticket_id: t.id, repo_id: 'demo', state: 'done', branch: 'fix/work', pr_url: url(1), finished_at: OLD,
    pr_observed: { state: 'merged', merged_at: OLD, revert_checked_at: '2026-08-04T08:00:00Z' } });
  const r = await runReconciliation(f.worker, { providers: providers({ fetchPr: async () => ({ state: 'merged', head_branch: 'fix/work', merged_at: OLD }) }) });
  assert.equal(r.pr_updates.find((p) => p.origin_handoff_id === 'run')?.url, url(1));
});

test('run observations with mismatched branch or repo never emit guessed ticket links', async () => {
  for (const mismatch of ['branch', 'repo']) {
    const f = fixture();
    const t = f.ticket(1, { pr: false });
    f.state.handoffs.set('run', { id: 'run', ticket_id: t.id, repo_id: mismatch === 'repo' ? 'other' : 'demo', state: 'done', branch: 'fix/recorded', pr_url: url(1), finished_at: NOW });
    const r = await runReconciliation(f.worker, { providers: providers({ fetchPr: async () => ({ state: 'merged', head_branch: mismatch === 'branch' ? 'fix/other' : 'fix/recorded', merged_at: NOW }) }) });
    assert.equal(r.pr_updates.filter((p) => p.origin_handoff_id).length, 0);
    assert.equal(r.pr_updates.filter((p) => p.handoff_id).length, 1);
  }
});

test('a merged PR on unresolved work remains refreshable after deployment delays', async () => {
  const f = fixture();
  const t = f.ticket(1, { at: OLD });
  Object.assign(t.prs[0], { state: 'merged', merged_at: OLD });
  t.status = 'deploy-pending';
  const r = await runReconciliation(f.worker, { providers: providers({ fetchPr: async () => ({ state: 'merged', merged_at: OLD }) }) });
  assert.equal(r.coverage.checked, 1);
  assert.equal(t.prs[0].observed_at, NOW);
});

test('a merged PR discovered on a shared branch cannot link or close either ambiguous ticket', async () => {
  const f = fixture();
  f.state.meta.repos.demo.deploy_on = 'merge';
  const a = f.ticket(1, { branch: 'fix/shared', pr: false, at: OLD });
  const b = f.ticket(2, { branch: 'fix/shared', pr: false, at: OLD });
  const merged = { url: url(3), state: 'merged', head_branch: 'fix/shared', opened_at: OLD, merged_at: NOW };
  const r = await runReconciliation(f.worker, { providers: providers({ findPrs: async () => [merged] }) });
  assert.equal(r.pr_updates.filter((p) => p.link).length, 0, 'branch identity alone cannot choose the originating ticket');
  for (const t of [a, b]) {
    assert.equal(t.prs.length, 0);
    assert.equal(t.status, 'active');
  }
  assert.equal(r.coverage.by_kind.branch.checked, 1, 'discovery remains a single scheduled check');
});

test('completing one ticket does not make its shared branch evidence attributable to another', async () => {
  const f = fixture();
  const done = f.ticket(1, { branch: 'fix/shared', pr: false, at: OLD });
  done.status = 'done';
  const remaining = f.ticket(2, { branch: 'fix/shared', pr: false, at: OLD });
  const merged = { url: url(3), state: 'merged', head_branch: 'fix/shared', opened_at: OLD, merged_at: NOW };
  const r = await runReconciliation(f.worker, { providers: providers({ findPrs: async () => [merged] }) });
  assert.equal(r.pr_updates.filter((p) => p.link).length, 0);
  assert.equal(remaining.prs.length, 0);
});
