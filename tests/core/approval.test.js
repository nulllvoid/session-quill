import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchApprovalPhrase, selectCheckpointForApproval } from '../../src/core/approval.js';
import { sessionKey } from '../../src/core/state.js';
import { newState, createTicket, bind, ev } from './helpers.js';

test('matchApprovalPhrase matches only the complete trimmed case-insensitive phrase', () => {
  assert.equal(matchApprovalPhrase('Approved'), true);
  assert.equal(matchApprovalPhrase('  lgtm \n'), true);
  assert.equal(matchApprovalPhrase('GO AHEAD'), true);
  assert.equal(matchApprovalPhrase('ship it.'), false);
  assert.equal(matchApprovalPhrase('"approved"'), false);
  assert.equal(matchApprovalPhrase('approved, but fix x'), false);
  assert.equal(matchApprovalPhrase('not approved'), false);
  assert.equal(matchApprovalPhrase(''), false);
});

test('selectCheckpointForApproval picks the latest complete checkpoint for the current binding or an explicit id of the same ticket', () => {
  const state = newState();
  const t = createTicket(state);
  const s = bind(state, 'host-1', t.id);
  assert.throws(() => selectCheckpointForApproval(state, s, null), (e) => e.code === 'no-checkpoint');
  ev(state, 'stop', { content_ref: 'a'.repeat(64), preview: 'first', length: 5, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:01:00Z' });
  const first = state.sessions.get(sessionKey({ session_id: 'host-1' })).last_checkpoint_id;
  ev(state, 'stop', { content_ref: 'b'.repeat(64), preview: 'second', length: 6, complete: true }, { session_id: 'host-1', occurred_at: '2026-10-02T08:02:00Z' });
  const latest = selectCheckpointForApproval(state, state.sessions.get(sessionKey({ session_id: 'host-1' })), null);
  assert.equal(latest.preview, 'second');
  assert.equal(selectCheckpointForApproval(state, s, first).id, first);
  const other = createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: 'LOCAL-other-00000002' });
  bind(state, 'host-2', other.id);
  assert.throws(() => selectCheckpointForApproval(state, state.sessions.get(sessionKey({ session_id: 'host-2' })), first), (e) => e.code === 'checkpoint-mismatch');
});

test('incomplete checkpoints cannot be selected for approval', () => {
  const state = newState();
  const t = createTicket(state);
  const s = bind(state, 'host-1', t.id);
  ev(state, 'stop', { content_ref: null, preview: '', length: 0, complete: false }, { session_id: 'host-1', occurred_at: '2026-10-02T08:01:00Z' });
  assert.throws(() => selectCheckpointForApproval(state, s, null), (e) => e.code === 'no-checkpoint');
});
