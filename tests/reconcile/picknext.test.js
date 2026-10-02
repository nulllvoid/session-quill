import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankPickNext, scoreTicket, blockedList } from '../../src/reconcile/picknext.js';

const NOW = '2026-10-02T12:00:00Z';
const TZ = 'UTC';
let n = 0;
function t(overrides = {}) {
  n += 1;
  return {
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, key: `K-${n}`, status: 'todo', priority: 'P3', due: null, next_action: '', stale: false,
    parent_id: null, prs: [], deployments: [], last_activity: '2026-10-01T00:00:00Z', blocker: null, ...overrides,
  };
}

test('points: P0 + overdue + next_action = 80 with matching reasons', () => {
  const r = scoreTicket(t({ priority: 'P0', due: '2026-09-30', next_action: 'Do it' }), { nowIso: NOW, timezone: TZ, byId: new Map() });
  assert.equal(r.raw_score, 80);
  assert.equal(r.score, 80);
  assert.deepEqual(r.reasons.map((x) => x.split(':')[0]), ['Priority P0', 'Due overdue', 'Has next action']);
});

test('due within 3 days earns 30 only once (not 45); within 7 earns 15; beyond earns 0', () => {
  const by = { nowIso: NOW, timezone: TZ, byId: new Map() };
  assert.equal(scoreTicket(t({ due: '2026-10-05' }), by).raw_score, 30);
  assert.equal(scoreTicket(t({ due: '2026-10-06' }), by).raw_score, 15);
  assert.equal(scoreTicket(t({ due: '2026-10-09' }), by).raw_score, 15);
  assert.equal(scoreTicket(t({ due: '2026-10-10' }), by).raw_score, 0);
});

test('PR signals: pending merged obligation >= 2 days = 20, open PR >= 1 day in review = 15; unknown provider dates earn nothing and show the limitation', () => {
  const by = { nowIso: NOW, timezone: TZ, byId: new Map() };
  const merged = t({ status: 'deploy-pending', prs: [{ id: 'p1', state: 'merged', merged_at: '2026-09-29T00:00:00Z', opened_at: null }], deployments: [{ pr_id: 'p1', environment: 'production', state: 'pending', merged_at: '2026-09-29T00:00:00Z' }] });
  assert.equal(scoreTicket(merged, by).raw_score, 20);
  const review = t({ status: 'review', prs: [{ id: 'p2', state: 'open', opened_at: '2026-10-01T00:00:00Z', merged_at: null }] });
  assert.equal(scoreTicket(review, by).raw_score, 15);
  const notReview = t({ status: 'active', prs: [{ id: 'p2', state: 'open', opened_at: '2026-10-01T00:00:00Z', merged_at: null }] });
  assert.equal(scoreTicket(notReview, by).raw_score, 0);
  const unknown = scoreTicket(t({ status: 'review', prs: [{ id: 'p3', state: 'unknown', opened_at: null, merged_at: null }] }), by);
  assert.equal(unknown.raw_score, 0);
  assert.ok(unknown.limitations.some((l) => /unknown/i.test(l)));
});

test('parent-with-another-done-child and stale each add 10', () => {
  const parent = t({ id: 'pppppppp-0000-4000-8000-000000000000', children_done_count: 1 });
  const child = t({ parent_id: parent.id, stale: true, status: 'active' });
  const r = scoreTicket(child, { nowIso: NOW, timezone: TZ, byId: new Map([[parent.id, parent]]) });
  assert.equal(r.raw_score, 20);
});

test('ranking excludes blocked/done, caps display at 100 while raw orders, breaks ties deterministically and returns fewer than five when fewer exist', () => {
  const big = t({ priority: 'P0', due: '2026-09-01', status: 'deploy-pending', next_action: 'x', stale: false, prs: [{ id: 'p', state: 'merged', merged_at: '2026-09-20T00:00:00Z' }], deployments: [{ pr_id: 'p', environment: 'production', state: 'pending', merged_at: '2026-09-20T00:00:00Z' }] });
  const mid = t({ priority: 'P0', due: '2026-09-01', next_action: 'y', status: 'active' });
  const blocked = t({ priority: 'P0', status: 'blocked', blocker: 'waiting' });
  const done = t({ priority: 'P0', status: 'done' });
  const tieA = t({ priority: 'P2', due: '2026-10-20', id: 'bbbbbbbb-0000-4000-8000-000000000000' });
  const tieB = t({ priority: 'P2', due: '2026-10-20', id: 'aaaaaaaa-0000-4000-8000-000000000000' });
  const ranked = rankPickNext([tieA, blocked, mid, done, big, tieB], { nowIso: NOW, timezone: TZ });
  assert.equal(ranked.length, 4);
  assert.equal(ranked[0].ticket_id, big.id);
  assert.equal(ranked[0].raw_score, 100);
  assert.equal(ranked[0].score, 100);
  assert.equal(ranked[1].ticket_id, mid.id);
  assert.equal(ranked[1].raw_score, 80);
  assert.deepEqual(ranked.slice(2).map((r) => r.ticket_id), [tieB.id, tieA.id]);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(blockedList([tieA, blocked, done]), [{ ticket_id: blocked.id, blocker: 'waiting' }]);
});

test('ranking shows at most five', () => {
  const many = Array.from({ length: 8 }, (_, i) => t({ priority: i < 4 ? 'P1' : 'P3' }));
  const ranked = rankPickNext(many, { nowIso: NOW, timezone: TZ });
  assert.equal(ranked.length, 5);
  assert.equal(ranked[0].raw_score, 25);
});
