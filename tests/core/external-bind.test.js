import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, ev, resetSeq, STORE } from './helpers.js';
import { externalTicketId } from '../../src/core/external-keys.js';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ext = (key, extra = {}) => ({ external: { system: 'jira', key, url: `https://example.atlassian.net/browse/${key}` }, source: 'prompt', title_hint: null, project_id: 'demo', repo_id: 'demo', ensure_only: false, ...extra });
const start = (state, session_id = 'h1') => ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id });

beforeEach(() => resetSeq());

test('bind by external key creates the ticket under that key and binds the session', () => {
  const state = newState();
  start(state);
  const r = ev(state, 'bind', ext('PMLA-1234', { title_hint: 'PMLA-1234 fix the retry flake' }), { session_id: 'h1' });
  assert.equal(r.rejected, undefined);
  const id = externalTicketId(STORE, 'PMLA-1234');
  const t = state.tickets.get(id);
  assert.equal(t.key, 'PMLA-1234');
  assert.equal(t.title, 'PMLA-1234 fix the retry flake');
  assert.equal(t.project_id, 'demo');
  assert.deepEqual(t.external, { system: 'jira', key: 'PMLA-1234', url: 'https://example.atlassian.net/browse/PMLA-1234', validation: 'pending', validated_at: null, error: null });
  assert.equal(t.jira.key, 'PMLA-1234');
  assert.match(t.timeline[0].text, /Created \(auto from prompt\)/);
  const s = state.sessions.get('h1');
  assert.equal(s.current_ticket_id, id);
  assert.equal(s.current_binding_revision, 1);
  assert.ok(r.bindingChanged.has('h1'));
});

test('a key that already names a ticket, or an alias, binds to it; repeating the bind is a no-op', () => {
  const state = newState();
  createTicket(state);
  ev(state, 'relink', { ticket_id: T1, new_key: 'PMLA-7' });
  start(state);
  ev(state, 'bind', ext('PMLA-7'), { session_id: 'h1' });
  const s = state.sessions.get('h1');
  assert.equal(s.current_ticket_id, T1);
  ev(state, 'bind', ext('LOCAL-demo-ticket-00000001'), { session_id: 'h1' });
  ev(state, 'bind', ext('PMLA-7'), { session_id: 'h1' });
  assert.equal(s.current_binding_revision, 1);
  assert.equal(state.tickets.size, 1);
});

test('switching keys closes the previous interval; ensure_only records a mention without rebinding', () => {
  const state = newState();
  start(state);
  ev(state, 'bind', ext('PMLA-1'), { session_id: 'h1' });
  ev(state, 'bind', ext('PMLA-2'), { session_id: 'h1', occurred_at: '2026-10-02T08:10:00Z' });
  const s = state.sessions.get('h1');
  assert.equal(s.current_binding_revision, 2);
  assert.equal(s.bindings[0].unbound_at, '2026-10-02T08:10:00Z');
  ev(state, 'bind', ext('PMLA-3', { ensure_only: true }), { session_id: 'h1' });
  assert.equal(s.current_binding_revision, 2);
  assert.equal(s.current_ticket_id, externalTicketId(STORE, 'PMLA-2'));
  const t3 = state.tickets.get(externalTicketId(STORE, 'PMLA-3'));
  assert.match(t3.timeline.at(-1).text, /Mentioned in session h1/);
});

test('invalid keys are rejected and the session snapshot is still republished', () => {
  const state = newState();
  start(state);
  const r = ev(state, 'bind', ext('../etc'), { session_id: 'h1' });
  assert.equal(r.rejected, 'key-invalid');
  assert.ok(r.bindingChanged.has('h1'));
  assert.equal(state.tickets.size, 0);
});

test('a missing title hint names the ticket after its key; a missing project falls back to the first configured project', () => {
  const state = newState();
  start(state);
  ev(state, 'bind', ext('PMLA-5', { title_hint: '', project_id: null }), { session_id: 'h1' });
  const t = state.tickets.get(externalTicketId(STORE, 'PMLA-5'));
  assert.equal(t.title, 'PMLA-5');
  assert.equal(t.project_id, 'demo');
});

test('a pre-tool record naming an unknown ticket id is attributed to the session\'s current binding', () => {
  const state = newState();
  start(state);
  ev(state, 'bind', ext('PMLA-9'), { session_id: 'h1' });
  ev(state, 'pre-tool', { tool_name: 'Edit', write_target: 'src/a.js' }, { session_id: 'h1', tool_call_id: 't1', ticket_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', binding_revision: 1, occurred_at: '2026-10-02T08:05:00Z' });
  ev(state, 'post-tool', { tool_name: 'Edit', write_paths: ['src/a.js'], repo_id: 'demo', success: true }, { session_id: 'h1', tool_call_id: 't1', source_identity: 'post-tool:h1:t1', occurred_at: '2026-10-02T08:05:00Z' });
  const t = state.tickets.get(externalTicketId(STORE, 'PMLA-9'));
  assert.ok(t.files_touched.some((f) => f.relative_path === 'src/a.js'));
});

test('the first prompt from an unseen session republishes its binding snapshot', () => {
  const state = newState();
  const first = ev(state, 'prompt', { title_candidate: 'x', approval_candidate: false, length: 1 }, { session_id: 'late' });
  assert.ok(first.bindingChanged.has('late'));
  const second = ev(state, 'prompt', { title_candidate: null, approval_candidate: false, length: 1 }, { session_id: 'late' });
  assert.equal(second.bindingChanged.has('late'), false);
});

test('relink with an external record stores it beside the legacy jira field', () => {
  const state = newState();
  const t = createTicket(state);
  ev(state, 'relink', { ticket_id: T1, new_key: 'ENG-9', external: { system: 'linear', key: 'ENG-9', url: 'https://linear.app/acme/issue/ENG-9', validation: 'pending', validated_at: null, error: 'pending' } });
  assert.equal(t.key, 'ENG-9');
  assert.equal(t.external.system, 'linear');
  assert.equal(t.jira, null);
  assert.match(t.timeline.at(-1).text, /linear ENG-9/);
});
