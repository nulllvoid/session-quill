// In-memory generated state, reduced from the journal. Field names follow DATA-CONTRACT.md.
import { uuid, deterministicId } from '../lib/ids.js';

export const TICKET_STATUSES = ['todo', 'active', 'blocked', 'review', 'deploy-pending', 'done'];
export const CATEGORIES = ['feature', 'bugfix', 'vuln', 'infra', 'research', 'analysis'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const SESSION_STATES = ['live', 'idle', 'ended', 'extinct'];
export const REQUEST_STATES = ['pending', 'applying', 'applied', 'conflict', 'failed', 'cancelled'];
export const HANDOFF_STATES = ['queued', 'running', 'done', 'failed', 'cancelled', 'timed-out'];
export const HANDOFF_MODES = ['analyse', 'analyse-followups', 'attempt-fix'];
export const PR_STATES = ['unknown', 'draft', 'open', 'merged', 'closed'];
export const DEPLOYMENT_STATES = ['pending', 'deployed', 'waived'];
export const TIMELINE_KINDS = ['bind', 'write', 'tool', 'commit', 'pr', 'plan', 'conclusion', 'handoff', 'status', 'deployment', 'capture-error'];

export function createState(meta) {
  return {
    meta: {
      schema_version: 1,
      store_id: meta.store_id,
      machine_id: meta.machine_id,
      machine_name: meta.machine_name ?? 'local',
      store_name: meta.store_name ?? 'Quill',
      timezone: meta.timezone ?? 'UTC',
      key_prefix: meta.key_prefix ?? 'LOCAL',
      stale_days: meta.stale_days ?? 5,
      sync_interval_hours: meta.sync_interval_hours ?? 2,
      approval_phrases_enabled: meta.approval_phrases_enabled === true,
      projects: meta.projects ?? {},
      repos: meta.repos ?? {},
      tracker_version: meta.tracker_version ?? '0.1.0',
    },
    tickets: new Map(),
    sessions: new Map(),
    checkpoints: new Map(),
    handoffs: new Map(),
    requests: new Map(),
    pendingToolCalls: new Map(),
    unresolved: [],
    notified: new Set(),
    approvals: new Set(),
    counters: { childByParent: new Map() },
    keyIndex: new Map(),
    childrenIndex: new Map(),
    sessionsById: new Map(),
    checkpointsBySession: new Map(),
    appliedEvents: new Set(),
    appliedSources: new Set(),
    lastSequence: 0,
    lastSync: null,
    providerHealth: [],
    lastCaptureAt: null,
    healthErrors: [],
  };
}

export function sessionKey({ session_id, agent_id = null }) {
  return agent_id ? `${session_id}:${agent_id}` : `${session_id}`;
}

export function projectName(state, projectId) {
  const p = state.meta.projects[projectId];
  return p && p.name ? p.name : projectId ?? '';
}

export function repoFor(state, repoId) {
  if (!repoId) return null;
  const r = state.meta.repos[repoId];
  return r ? { id: repoId, ...r } : null;
}

export function newTicket(state, {
  id = uuid(), key, title, project_id, project_name, category = 'research', priority = 'P2', parent_id = null,
  repo_id = null, due = null, jira = null, created_at, status = 'todo', status_source = 'manual',
}) {
  return {
    schema_version: 1,
    store_id: state.meta.store_id,
    id,
    revision: 1,
    created_at,
    updated_at: created_at,
    key,
    title,
    project_id,
    project_name: project_name ?? projectName(state, project_id),
    status,
    category,
    priority,
    parent_id,
    due,
    blocker: null,
    repo_id,
    jira,
    next_action: '',
    summary: '',
    user_notes: '',
    last_activity: created_at,
    stale: false,
    status_source,
    status_evidence_id: null,
    manual_status_evidence_floor: 0,
    aliases: [],
    children_ids: [],
    session_ids: [],
    tags: [],
    files_touched: [],
    plans: [],
    conclusions: [],
    timeline: [],
    prs: [],
    deployments: [],
    handoff_ids: [],
    validation_issues: [],
    files_touched_count: 0,
    plans_count: 0,
    children_done_count: 0,
  };
}

export function newSession(state, { id, host_session_id, agent_id = null, parent_session_id = null, started_at, cwd = null, machine_name = null }) {
  const sessionId = id ?? deterministicId(`session:${state.meta.store_id}:${state.meta.machine_id}:${host_session_id}:${agent_id ?? ''}`);
  return {
    schema_version: 1,
    store_id: state.meta.store_id,
    id: sessionId,
    revision: 1,
    created_at: started_at,
    updated_at: started_at,
    machine_id: state.meta.machine_id,
    machine_name: machine_name ?? state.meta.machine_name,
    host_session_id,
    agent_id,
    parent_session_id,
    project_ids: [],
    ticket_ids: [],
    current_ticket_id: null,
    current_binding_revision: 0,
    bindings: [],
    cwd,
    title: '',
    started_at,
    ended_at: null,
    last_event_at: started_at,
    state: 'live',
    successful_write_count: 0,
    change_coverage: 'complete',
    last_checkpoint_id: null,
    last_checkpoint_preview: '',
    unpromoted: false,
    gate_enabled: true,
    capture_health: { status: 'ok', reason: null, observed_at: started_at },
    events_since_checkpoint: 0,
  };
}

export function refreshTags(ticket) {
  const explicit = ticket.tags.filter((t) => !t.startsWith('quill/status/') && !t.startsWith('quill/cat/') && t !== 'quill/stale');
  ticket.tags = [`quill/status/${ticket.status}`, `quill/cat/${ticket.category}`, ...(ticket.stale ? ['quill/stale'] : []), ...explicit];
}

// Parent -> children index keeps derived child fields O(children) instead of O(all tickets).
export function indexChild(state, ticket, previousParentId = undefined) {
  if (previousParentId !== undefined && previousParentId !== null && previousParentId !== ticket.parent_id) {
    const prev = state.childrenIndex.get(previousParentId);
    if (prev) prev.delete(ticket.id);
  }
  if (ticket.parent_id) {
    if (!state.childrenIndex.has(ticket.parent_id)) state.childrenIndex.set(ticket.parent_id, new Set());
    state.childrenIndex.get(ticket.parent_id).add(ticket.id);
  }
}

export function refreshDerived(state, ticket) {
  ticket.files_touched_count = ticket.files_touched.length;
  ticket.plans_count = ticket.plans.length;
  const ids = state.childrenIndex.get(ticket.id);
  const children = ids ? [...ids].filter((id) => state.tickets.has(id)).sort() : [];
  let done = 0;
  for (const id of children) if (state.tickets.get(id).status === 'done') done += 1;
  ticket.children_ids = children;
  ticket.children_done_count = done;
  refreshTags(ticket);
}

export function registerSession(state, session) {
  state.sessionsById.set(session.id, session);
}

export function registerCheckpoint(state, cp) {
  state.checkpoints.set(cp.id, cp);
  if (!state.checkpointsBySession.has(cp.session_id)) state.checkpointsBySession.set(cp.session_id, new Set());
  state.checkpointsBySession.get(cp.session_id).add(cp.id);
}

export function bumpRevision(ticket, at) {
  ticket.revision += 1;
  ticket.updated_at = at;
}

export function ticketByKey(state, keyOrAlias) {
  const id = state.keyIndex.get(keyOrAlias);
  return id ? state.tickets.get(id) ?? null : null;
}
