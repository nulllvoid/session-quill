import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, ev, resetSeq, bind, STORE } from './helpers.js';
import { hasUnboundWork } from '../../src/core/state.js';
import { externalTicketId } from '../../src/core/external-keys.js';

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

let reqN = 0;
function apply(state, mutation) {
  reqN += 1;
  const id = `00000000-0000-4000-8000-${String(reqN).padStart(12, '0')}`;
  ev(state, 'request', { id, kind: 'attach-unbound', target_id: null, payload: {} });
  return ev(state, 'request-tx', { request_id: id, outcome: 'applied', mutation });
}

function unboundSession(state, id = 'u1') {
  ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id: id });
  edit(state, id, `${id}-t1`, 'src/a.js');
  commit(state, id, `${id}-t2`, 'abc1234def');
  ev(state, 'stop', { complete: true, content_ref: 'c'.repeat(64), preview: 'Fixed the retry test', length: 20, conclusions: [] }, { session_id: id, occurred_at: '2026-10-02T08:08:00Z' });
  return state.sessions.get(id);
}

test('attaching moves files, commits and checkpoints to the ticket and links the still-unbound session', () => {
  const state = newState();
  const t = createTicket(state);
  const s = unboundSession(state);
  const before = s.unbound_work.revision;
  const r = apply(state, { type: 'unbound-attach', session_id: s.id, ticket_id: T1, create: null, bind: true });
  assert.deepEqual(t.files_touched.map((f) => f.relative_path), ['src/a.js']);
  assert.ok(t.timeline.some((e) => e.kind === 'commit' && /abc1234def.*attached/.test(e.text)));
  assert.ok(t.timeline.some((e) => /Attached unlinked work from session u1: 1 file, 1 commit/.test(e.text)));
  const cp = [...state.checkpoints.values()].find((c) => c.session_id === s.id);
  assert.equal(cp.ticket_id, T1);
  assert.equal(s.current_ticket_id, T1);
  assert.ok(t.session_ids.includes(s.id));
  assert.equal(hasUnboundWork(s), false);
  assert.equal(s.unbound_work.revision, before + 1);
  assert.ok(r.bindingChanged.has('u1'));
});

test('attaching never rebinds a session that is already linked to another ticket', () => {
  const state = newState();
  createTicket(state);
  createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: 'LOCAL-two-00000002' });
  const s = unboundSession(state);
  ev(state, 'bind', { ticket_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', project_id: 'demo' }, { session_id: 'u1' });
  apply(state, { type: 'unbound-attach', session_id: s.id, ticket_id: T1, create: null, bind: true });
  assert.equal(s.current_ticket_id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.deepEqual(state.tickets.get(T1).files_touched.map((f) => f.relative_path), ['src/a.js']);
});

test('create from key makes the ticket; create reuses a ticket that took the key first', () => {
  const state = newState();
  const s = unboundSession(state);
  const id = externalTicketId(STORE, 'PMLA-5');
  const spec = { id, key: 'PMLA-5', title: 'Retry fix', project_id: 'demo', category: 'research', priority: 'P2', repo_id: null, external: { system: 'jira', key: 'PMLA-5', url: 'https://example.atlassian.net/browse/PMLA-5', validation: 'pending', validated_at: null, error: null }, jira: null, created_via: 'inbox' };
  apply(state, { type: 'unbound-attach', session_id: s.id, ticket_id: id, create: spec, bind: false });
  const t = state.tickets.get(id);
  assert.equal(t.key, 'PMLA-5');
  assert.match(t.timeline[0].text, /Created \(inbox\)/);
  assert.equal(s.current_ticket_id, null, 'bind: false leaves the session unbound');
  const s2 = unboundSession(state, 'u2');
  createTicket(state, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', key: 'PMLA-6' });
  apply(state, { type: 'unbound-attach', session_id: s2.id, ticket_id: externalTicketId(STORE, 'PMLA-6'), create: { ...spec, id: externalTicketId(STORE, 'PMLA-6'), key: 'PMLA-6' }, bind: false });
  assert.equal([...state.tickets.values()].filter((x) => x.key === 'PMLA-6').length, 1);
  assert.deepEqual(state.tickets.get('cccccccc-cccc-4ccc-8ccc-cccccccccccc').files_touched.map((f) => f.relative_path), ['src/a.js']);
});

test('dismissing hides the batch; later unlinked work starts a new batch with a higher revision', () => {
  const state = newState();
  const s = unboundSession(state);
  const rev = s.unbound_work.revision;
  apply(state, { type: 'unbound-dismiss', session_id: s.id });
  assert.equal(hasUnboundWork(s), false);
  assert.ok(s.unbound_work.dismissed_at);
  edit(state, 'u1', 'u1-t9', 'src/c.js', '2026-10-02T09:00:00Z');
  assert.deepEqual(s.unbound_work.files.map((f) => f.relative_path), ['src/c.js']);
  assert.equal(s.unbound_work.dismissed_at, null);
  assert.ok(s.unbound_work.revision > rev + 1);
});

test('a relink mutation sets the key, keeps the old key as an alias and stores the external link', () => {
  const state = newState();
  const t = createTicket(state);
  apply(state, { type: 'relink', ticket_id: T1, new_key: 'PMLA-1', external: { system: 'jira', key: 'PMLA-1', url: 'https://example.atlassian.net/browse/PMLA-1', validation: 'pending', validated_at: null, error: 'pending' } });
  assert.equal(t.key, 'PMLA-1');
  assert.deepEqual(t.aliases, ['LOCAL-demo-ticket-00000001']);
  assert.equal(t.external.url, 'https://example.atlassian.net/browse/PMLA-1');
  assert.equal(state.keyIndex.get('PMLA-1'), T1);
});

test('review: attaching writes to a to-do ticket makes it active, as the same writes would have', () => {
  const state = newState();
  const t = createTicket(state);
  assert.equal(t.status, 'todo');
  const s = unboundSession(state);
  apply(state, { type: 'unbound-attach', session_id: s.id, ticket_id: T1, create: null, bind: false });
  assert.equal(t.status, 'active');
});
