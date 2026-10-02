import { makeEvent } from '../../src/core/events.js';
import { createState, sessionKey } from '../../src/core/state.js';
import { applyEvent } from '../../src/core/reducer.js';

export const STORE = '11111111-1111-4111-8111-111111111111';
export const MACHINE = '22222222-2222-4222-8222-222222222222';

export function newState(overrides = {}) {
  return createState({
    store_id: STORE,
    machine_id: MACHINE,
    store_name: 'Quill',
    timezone: 'UTC',
    key_prefix: 'LOCAL',
    stale_days: 5,
    approval_phrases_enabled: false,
    projects: { demo: { name: 'Demo', repo_id: 'demo' } },
    repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] } },
    ...overrides,
  });
}

let seq = 0;
export function resetSeq() { seq = 0; }

export function ev(state, kind, payload = {}, extra = {}) {
  const e = makeEvent({ kind, payload, store_id: STORE, machine_id: MACHINE, producer: 'test', occurred_at: extra.occurred_at ?? '2026-10-02T08:00:00Z', ...extra });
  seq += 1;
  e.sequence = extra.sequence ?? seq;
  e.ingested_at = e.occurred_at;
  return applyEvent(state, e);
}

export function createTicket(state, { id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', key = 'LOCAL-demo-ticket-00000001', title = 'Demo ticket', parent_id = null, status, at = '2026-10-02T08:00:00Z' } = {}) {
  ev(state, 'ticket-create', { ticket: { id, key, title, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id, repo_id: 'demo', due: null, jira: null } }, { occurred_at: at });
  if (status) ev(state, 'ticket-update', { ticket_id: id, fields: { status }, source: 'manual' }, { occurred_at: at });
  return state.tickets.get(id);
}

export function bind(state, session_id, ticket_id, { agent_id = null, at = '2026-10-02T08:00:00Z' } = {}) {
  ev(state, 'session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id, agent_id, occurred_at: at });
  ev(state, 'bind', { ticket_id, project_id: 'demo' }, { session_id, agent_id, occurred_at: at });
  return state.sessions.get(sessionKey({ session_id, agent_id }));
}
