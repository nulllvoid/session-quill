import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, ev } from './helpers.js';
import { makeEvent } from '../../src/core/events.js';
import { applyEvent } from '../../src/core/reducer.js';

function work(state, session, title, id, extra = {}) {
  return ev(state, 'ticket-create', { reuse_task: true, ticket: {
    id, title, allocate_internal_key: true, project_id: 'demo', repo_id: 'demo', ...extra,
  } }, { session_id: session });
}

test('tasks span sessions and sessions switch tasks without creating session tickets', () => {
  const state = newState();
  ev(state, 'session-start', {}, { session_id: 'one' });
  ev(state, 'prompt', { title_candidate: 'hello' }, { session_id: 'one' });
  assert.equal(state.tickets.size, 0);
  assert.equal(work(state, 'one', 'Improve onboarding', 'a').ticket.key, 'DEV-1');
  assert.equal(work(state, 'two', ' improve   onboarding ', 'b').ticket.key, 'DEV-1');
  assert.equal(state.tickets.size, 1);
  assert.equal(state.tickets.get('a').session_ids.length, 2);
  assert.equal(work(state, 'one', 'Fix login', 'c', { category: 'bugfix' }).ticket.key, 'FIX-1');
  assert.equal(state.sessions.get('two').current_ticket_id, 'a');
  assert.deepEqual(state.sessions.get('one').ticket_ids, ['a', 'c']);
  work(state, 'one', 'Improve onboarding', 'd');
  const revision = state.sessions.get('one').current_binding_revision;
  work(state, 'one', 'Improve onboarding', 'e');
  assert.equal(state.sessions.get('one').current_binding_revision, revision);
  assert.equal(state.tickets.size, 2);
});

test('switching tasks never reattributes an in-flight tool call', () => {
  const state = newState();
  work(state, 'one', 'Task A', 'a');
  ev(state, 'pre-tool', { tool_name: 'Write' }, { session_id: 'one', tool_call_id: 'first' });
  work(state, 'one', 'Task B', 'b');
  ev(state, 'post-tool', { tool_name: 'Write', write_paths: ['a.js'] }, { session_id: 'one', tool_call_id: 'first' });
  ev(state, 'pre-tool', { tool_name: 'Write' }, { session_id: 'one', tool_call_id: 'second' });
  ev(state, 'post-tool', { tool_name: 'Write', write_paths: ['b.js'] }, { session_id: 'one', tool_call_id: 'second' });
  assert.deepEqual(state.tickets.get('a').files_touched.map((f) => f.relative_path), ['a.js']);
  assert.deepEqual(state.tickets.get('b').files_touched.map((f) => f.relative_path), ['b.js']);
});

test('task matching is scoped and ambiguous titles never silently choose a task', () => {
  const state = newState();
  work(state, 'one', 'Search', 'a');
  work(state, 'two', 'Search', 'b', { repo_id: 'other' });
  assert.equal(state.tickets.size, 2);
  ev(state, 'ticket-create', { ticket: { id: 'c', title: 'Search', allocate_internal_key: true, project_id: 'demo', repo_id: 'demo' } });
  assert.equal(work(state, 'three', 'Search', 'd').rejected, 'task-ambiguous');
  assert.equal(state.sessions.has('three'), false);
});

test('sequential allocation replays identically, preserves aliases, and separates categories', () => {
  const state = newState();
  const replay = newState();
  const events = [
    makeEvent({ store_id: state.meta.store_id, machine_id: state.meta.machine_id, kind: 'ticket-create', payload: { ticket: { id: 'old', key: 'PROJ-9', aliases: ['DEV-12'], title: 'Old task' } } }),
    ...['research', 'feature', 'bugfix'].map((category) => makeEvent({ store_id: state.meta.store_id, machine_id: state.meta.machine_id, kind: 'ticket-create', payload: { ticket: { id: category, allocate_internal_key: true, category, title: category } } })),
  ];
  for (const event of events) { applyEvent(state, event); applyEvent(replay, event); applyEvent(replay, event); }
  assert.deepEqual([...state.tickets.values()], [...replay.tickets.values()]);
  assert.deepEqual([...state.tickets.values()].map((t) => t.key), ['PROJ-9', 'DEV-13', 'FEAT-1', 'FIX-1']);
});
