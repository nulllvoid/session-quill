import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, ev, resetSeq, bind } from './helpers.js';
import { hasUnboundWork } from '../../src/core/state.js';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => resetSeq());

export function edit(state, session_id, id, file, at = '2026-10-02T08:05:00Z') {
  ev(state, 'pre-tool', { tool_name: 'Edit', write_target: file }, { session_id, tool_call_id: id, occurred_at: at });
  return ev(state, 'post-tool', { tool_name: 'Edit', write_paths: [file], repo_id: null, success: true }, { session_id, tool_call_id: id, source_identity: `post-tool:${session_id}:${id}`, occurred_at: at });
}

export function commit(state, session_id, id, sha, at = '2026-10-02T08:06:00Z') {
  ev(state, 'pre-tool', { tool_name: 'Bash', write_target: 'git commit' }, { session_id, tool_call_id: id, occurred_at: at });
  return ev(state, 'post-tool', { tool_name: 'Bash', write_paths: [], commit: { sha, message: 'feat: retry' }, repo_id: null, success: true }, { session_id, tool_call_id: id, source_identity: `post-tool:${session_id}:${id}`, occurred_at: at });
}

test('writes and commits from an unbound session are kept on the session as unlinked work', () => {
  const state = newState();
  ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id: 'u1' });
  edit(state, 'u1', 't1', 'src/a.js');
  edit(state, 'u1', 't2', 'src/a.js', '2026-10-02T08:07:00Z');
  edit(state, 'u1', 't3', 'src/b.js');
  commit(state, 'u1', 't4', 'abc1234def');
  const s = state.sessions.get('u1');
  assert.deepEqual(s.unbound_work.files.map((f) => f.relative_path), ['src/a.js', 'src/b.js']);
  assert.equal(s.unbound_work.files[0].last_seen, '2026-10-02T08:07:00Z');
  assert.deepEqual(s.unbound_work.commits, [{ sha: 'abc1234def', message: 'feat: retry', at: '2026-10-02T08:06:00Z' }]);
  assert.equal(s.unbound_work.revision, 4);
  assert.equal(s.unbound_work.first_at, '2026-10-02T08:05:00Z');
  assert.equal(s.successful_write_count, 4);
  assert.equal(hasUnboundWork(s), true);
});

test('bound sessions and non-write tools record no unlinked work', () => {
  const state = newState();
  createTicket(state);
  bind(state, 'b1', T1);
  edit(state, 'b1', 't1', 'src/a.js');
  assert.equal(state.sessions.get('b1').unbound_work, null);
  ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id: 'u2' });
  ev(state, 'pre-tool', { tool_name: 'Read' }, { session_id: 'u2', tool_call_id: 'r1' });
  ev(state, 'post-tool', { tool_name: 'Read', write_paths: [], repo_id: null, success: true }, { session_id: 'u2', tool_call_id: 'r1', source_identity: 'post-tool:u2:r1' });
  assert.equal(state.sessions.get('u2').unbound_work, null);
  assert.equal(hasUnboundWork(state.sessions.get('u2')), false);
});
