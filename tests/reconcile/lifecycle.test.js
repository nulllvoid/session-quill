import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionState, isStale, applyLifecycle } from '../../src/reconcile/lifecycle.js';
import { newState, createTicket, bind, ev } from '../core/helpers.js';
import { sessionKey } from '../../src/core/state.js';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = { last_event_at: '2026-10-02T08:00:00Z', ended_at: null };

test('session state boundaries: live <= 30 min, idle before 48 h, extinct at >= 48 h, ended wins', () => {
  assert.equal(sessionState(base, '2026-10-02T08:10:00Z'), 'live');
  assert.equal(sessionState(base, '2026-10-02T08:30:00Z'), 'live');
  assert.equal(sessionState(base, '2026-10-02T08:31:00Z'), 'idle');
  assert.equal(sessionState(base, '2026-10-04T07:59:00Z'), 'idle');
  assert.equal(sessionState(base, '2026-10-04T08:00:00Z'), 'extinct');
  assert.equal(sessionState({ ...base, ended_at: '2026-10-02T08:05:00Z' }, '2026-10-02T08:06:00Z'), 'ended');
});

test('stale is derived only for active tickets at >= 5 days without substantive activity', () => {
  const active = { status: 'active', last_activity: '2026-10-02T08:00:00Z' };
  assert.equal(isStale(active, '2026-10-07T07:59:00Z', 5), false);
  assert.equal(isStale(active, '2026-10-07T08:00:00Z', 5), true);
  assert.equal(isStale({ ...active, status: 'blocked' }, '2026-10-20T08:00:00Z', 5), false);
  assert.equal(isStale({ ...active, status: 'done' }, '2026-10-20T08:00:00Z', 5), false);
  assert.equal(isStale({ ...active, status: 'todo' }, '2026-10-20T08:00:00Z', 5), false);
});

test('applyLifecycle updates derived fields without changing status, and new work clears stale', () => {
  const state = newState();
  const t = createTicket(state, { status: 'active' });
  const s = bind(state, 'host-1', T1);
  const changed = applyLifecycle(state, '2026-10-09T08:00:00Z');
  assert.equal(t.stale, true);
  assert.equal(t.status, 'active');
  assert.ok(t.tags.includes('tracker/stale'));
  assert.equal(s.state, 'extinct');
  assert.ok(changed.tickets.has(T1));
  // New substantive work: a stop checkpoint on the ticket
  ev(state, 'stop', { content_ref: 'a'.repeat(64), preview: 'p', length: 1, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-09T09:00:00Z' });
  applyLifecycle(state, '2026-10-09T09:05:00Z');
  assert.equal(t.stale, false);
  assert.equal(t.status, 'active');
  assert.equal(state.sessions.get(sessionKey({ session_id: 'host-1' })).state, 'live');
});

test('a reconcile event does not count as activity, and compaction does not end a session', () => {
  const state = newState();
  const t = createTicket(state, { status: 'active' });
  const s = bind(state, 'host-1', T1);
  ev(state, 'reconcile', { last_sync: '2026-10-09T08:00:00Z', provider_health: [] }, { occurred_at: '2026-10-09T08:00:00Z' });
  applyLifecycle(state, '2026-10-09T08:00:00Z');
  assert.equal(t.stale, true);
  ev(state, 'pre-compact', { trigger: 'auto' }, { session_id: 'host-1', occurred_at: '2026-10-09T08:01:00Z' });
  applyLifecycle(state, '2026-10-09T08:02:00Z');
  assert.notEqual(s.state, 'ended');
  assert.equal(s.ended_at, null);
});

test('extinct sessions with unpromoted checkpoints are listed once for notification', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'host-1', T1);
  ev(state, 'stop', { content_ref: 'b'.repeat(64), preview: 'p', length: 1, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:30:00Z' });
  const first = applyLifecycle(state, '2026-10-05T09:00:00Z');
  assert.equal(first.notify.length, 1);
  state.notified.add(first.notify[0]);
  const second = applyLifecycle(state, '2026-10-05T11:00:00Z');
  assert.equal(second.notify.length, 0);
});
