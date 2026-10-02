// Pure reducer: journal events -> generated state. Replay never runs tools or remote requests;
// duplicate event IDs or source identities have exactly one effect (TRD §Durability).
import { deterministicId } from '../lib/ids.js';
import {
  sessionKey, newTicket, newSession, refreshDerived, bumpRevision, projectName, repoFor, TICKET_STATUSES, CATEGORIES, PRIORITIES, PR_STATES,
  indexChild, registerSession, registerCheckpoint,
} from './state.js';
import { isIsoZ } from '../lib/time.js';
import { validateKey, validateParent } from './keys.js';
import { externalTicketId } from './external-keys.js';
import { applyStatusChange, deriveStatusFromEvidence, recordDeployment } from './transitions.js';
import { heuristicApprovalEligible } from './approval.js';

// Owner edits applied through request transactions are substantive activity too (I7).
const SUBSTANTIVE = new Set(['bind', 'post-tool', 'stop', 'subagent-stop', 'approve', 'ticket-update', 'ticket-create', 'relink', 'import', 'migration', 'handoff-tx', 'request-tx']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function timelineEntry(ev, kind, text, { content_ref = null, coverage = 'complete', index = 0 } = {}) {
  return { id: deterministicId(`${ev.event_id}:timeline:${kind}:${index}:${text}`), at: ev.occurred_at, kind, text, event_id: ev.event_id, content_ref, coverage };
}

function touch(state, ticket, ev, result) {
  bumpRevision(ticket, ev.occurred_at);
  if (SUBSTANTIVE.has(ev.kind) && ev.occurred_at > (ticket.last_activity ?? '')) ticket.last_activity = ev.occurred_at;
  refreshDerived(state, ticket);
  if (ticket.parent_id) {
    const parent = state.tickets.get(ticket.parent_id);
    if (parent) { refreshDerived(state, parent); result.changed.add(parent.id); }
  }
  result.changed.add(ticket.id);
}

function getOrCreateSession(state, ev, { source = 'startup', cwd = null, parent_session_id = null } = {}) {
  const key = sessionKey(ev);
  let session = state.sessions.get(key);
  if (!session) {
    session = newSession(state, { host_session_id: ev.session_id, agent_id: ev.agent_id ?? null, parent_session_id, started_at: ev.occurred_at, cwd });
    state.sessions.set(key, session);
    registerSession(state, session);
  }
  if (ev.occurred_at > session.last_event_at) session.last_event_at = ev.occurred_at;
  if (source !== 'resume' && cwd) session.cwd = cwd;
  if (session.ended_at && ['session-start', 'bind', 'pre-tool', 'post-tool', 'stop', 'prompt'].includes(ev.kind)) {
    session.ended_at = null;
    session.state = 'live';
  }
  session.revision += 1;
  session.updated_at = ev.occurred_at;
  return session;
}

function bindSession(state, session, ev, { ticket_id, project_id }, result) {
  const previous = session.bindings[session.bindings.length - 1];
  if (previous && previous.unbound_at === null) previous.unbound_at = ev.occurred_at;
  session.current_binding_revision += 1;
  session.bindings.push({
    revision: session.current_binding_revision, ticket_id: ticket_id ?? null, project_id: project_id ?? null, bound_at: ev.occurred_at, unbound_at: null, source_event_id: ev.event_id,
  });
  session.current_ticket_id = ticket_id ?? null;
  if (project_id && !session.project_ids.includes(project_id)) session.project_ids.push(project_id);
  if (ticket_id) {
    if (!session.ticket_ids.includes(ticket_id)) session.ticket_ids.push(ticket_id);
    const ticket = state.tickets.get(ticket_id);
    if (ticket) {
      if (!ticket.session_ids.includes(session.id)) ticket.session_ids.push(session.id);
      ticket.timeline.push(timelineEntry(ev, 'bind', `Session ${session.host_session_id}${session.agent_id ? ` (agent ${session.agent_id})` : ''} bound (revision ${session.current_binding_revision})`));
      touch(state, ticket, ev, result);
    }
  }
  result.bindingChanged.add(sessionKey({ session_id: session.host_session_id, agent_id: session.agent_id }));
}

function recomputeUnpromoted(state, session) {
  const ids = state.checkpointsBySession.get(session.id);
  session.unpromoted = ids ? [...ids].some((id) => { const cp = state.checkpoints.get(id); return cp && cp.complete && !cp.approved_at && !cp.dismissed_at; }) : false;
}

function approveCheckpoint(state, ev, { checkpoint_id, ticket_id, provenance }, result) {
  const cp = state.checkpoints.get(checkpoint_id);
  if (!cp || !cp.complete) return { rejected: 'no-checkpoint' };
  const ticket = state.tickets.get(ticket_id ?? cp.ticket_id);
  if (!ticket || cp.ticket_id !== ticket.id) return { rejected: 'checkpoint-mismatch' };
  const approvalKey = `${cp.id}:${ticket.id}`;
  if (state.approvals.has(approvalKey)) return { duplicate: true };
  state.approvals.add(approvalKey);
  cp.approved_at = ev.occurred_at;
  cp.approval_provenance = provenance;
  ticket.plans.push({ id: deterministicId(`${ev.event_id}:plan:${cp.id}`), session_id: cp.session_id, checkpoint_id: cp.id, content_ref: cp.content_ref, preview: cp.preview, approved_at: ev.occurred_at, provenance });
  ticket.timeline.push(timelineEntry(ev, 'plan', `Checkpoint approved (${provenance})`, { content_ref: cp.content_ref }));
  const session = state.sessionsById.get(cp.session_id);
  if (session) recomputeUnpromoted(state, session);
  touch(state, ticket, ev, result);
  return {};
}

function applyTicketFields(state, ticket, fields, ev, source, result) {
  const seq = ev.sequence ?? 0;
  if (fields.status !== undefined) {
    applyStatusChange(ticket, { status: fields.status, source, seq, blocker: fields.blocker ?? ticket.blocker, evidence_id: fields.status_evidence_id ?? null });
    ticket.timeline.push(timelineEntry(ev, 'status', `Status set to ${fields.status} (${source})`));
  } else if (fields.blocker !== undefined && ticket.status === 'blocked') {
    ticket.blocker = fields.blocker;
  }
  if (fields.next_action !== undefined) ticket.next_action = String(fields.next_action ?? '');
  if (fields.title !== undefined && fields.title) ticket.title = String(fields.title);
  if (fields.priority !== undefined && PRIORITIES.includes(fields.priority)) ticket.priority = fields.priority;
  if (fields.category !== undefined && CATEGORIES.includes(fields.category)) ticket.category = fields.category;
  if (fields.due !== undefined) ticket.due = fields.due;
  if (fields.parent_id !== undefined) {
    validateParent(state, ticket.id, fields.parent_id);
    const oldParent = ticket.parent_id ? state.tickets.get(ticket.parent_id) : null;
    const previousParentId = ticket.parent_id;
    ticket.parent_id = fields.parent_id;
    indexChild(state, ticket, previousParentId);
    if (oldParent) { refreshDerived(state, oldParent); result.changed.add(oldParent.id); }
  }
  if (fields.summary !== undefined) ticket.summary = String(fields.summary);
  if (fields.user_notes !== undefined) ticket.user_notes = String(fields.user_notes);
  if (fields.tags !== undefined && Array.isArray(fields.tags)) {
    const explicit = fields.tags.filter((t) => typeof t === 'string' && !t.startsWith('quill/'));
    ticket.tags = [...ticket.tags.filter((t) => t.startsWith('quill/')), ...explicit];
  }
  if (fields.validation_issues !== undefined) ticket.validation_issues = fields.validation_issues;
  if (Array.isArray(fields.deployments)) {
    for (const item of fields.deployments) recordDeployment(ticket, item);
    deriveStatusFromEvidence(ticket, { type: 'obligations-cleared', seq, evidence_id: ev.event_id }, repoFor(state, ticket.repo_id));
    ticket.timeline.push(timelineEntry(ev, 'deployment', `Deployment evidence recorded for ${fields.deployments.length} obligation(s)`));
  }
  touch(state, ticket, ev, result);
}

function createTicket(state, ev, t, source, result) {
  if (!t || !t.id || !t.key || !t.title) return { rejected: 'ticket-invalid' };
  if (state.tickets.has(t.id)) return { rejected: 'ticket-exists' };
  try {
    validateKey(t.key);
  } catch { return { rejected: 'key-invalid' }; }
  if (state.keyIndex.has(t.key)) return { rejected: 'key-collision' };
  if (!CATEGORIES.includes(t.category ?? 'research')) return { rejected: 'category-invalid' };
  if (!PRIORITIES.includes(t.priority ?? 'P2')) return { rejected: 'priority-invalid' };
  try {
    validateParent(state, t.id, t.parent_id ?? null);
  } catch {
    return { rejected: 'parent-invalid' };
  }
  const ticket = newTicket(state, {
    id: t.id, key: t.key, title: t.title, project_id: t.project_id, project_name: t.project_name ?? projectName(state, t.project_id),
    category: t.category ?? 'research', priority: t.priority ?? 'P2', parent_id: t.parent_id ?? null, repo_id: t.repo_id ?? null,
    due: t.due ?? null, jira: t.jira ?? null, external: t.external ?? null, created_at: ev.occurred_at, status_source: source,
  });
  if (t.status && TICKET_STATUSES.includes(t.status) && t.status !== 'todo') {
    applyStatusChange(ticket, { status: t.status, source, seq: ev.sequence ?? 0, blocker: t.blocker });
  }
  if (t.next_action) ticket.next_action = String(t.next_action);
  if (t.summary) ticket.summary = String(t.summary);
  if (t.user_notes) ticket.user_notes = String(t.user_notes);
  if (Array.isArray(t.aliases)) {
    for (const alias of t.aliases) if (!state.keyIndex.has(alias)) { ticket.aliases.push(alias); state.keyIndex.set(alias, ticket.id); }
  }
  if (Array.isArray(t.validation_issues)) ticket.validation_issues = [...t.validation_issues];
  // Imported evidence (migration): PR records, deployment obligations and historical activity.
  if (Array.isArray(t.prs)) {
    ticket.prs = t.prs.filter((p) => p && typeof p.url === 'string').map((p) => ({
      id: p.id ?? deterministicId(`${ev.event_id}:pr:${p.url}`), provider: p.provider ?? 'unknown', url: p.url, state: PR_STATES.includes(p.state) ? p.state : 'unknown',
      opened_at: p.opened_at ?? null, merged_at: p.merged_at ?? null, base_branch: p.base_branch ?? null, head_branch: p.head_branch ?? null, observed_at: p.observed_at ?? null, error: p.error ?? null, evidence_id: p.evidence_id ?? null,
    }));
  }
  if (Array.isArray(t.deployments)) {
    ticket.deployments = t.deployments.filter((d) => d && d.pr_id && d.environment).map((d) => ({
      id: d.id ?? deterministicId(`${ev.event_id}:dep:${d.pr_id}:${d.environment}`), pr_id: d.pr_id, environment: d.environment, state: ['pending', 'deployed', 'waived'].includes(d.state) ? d.state : 'pending',
      merged_at: d.merged_at ?? ev.occurred_at, deployed_at: d.deployed_at ?? null, evidence: d.evidence ?? null, waiver_reason: d.waiver_reason ?? null, source_event_id: ev.event_id,
    }));
  }
  if (typeof t.last_activity === 'string' && isIsoZ(t.last_activity)) ticket.last_activity = t.last_activity;
  if (typeof t.created_at === 'string' && isIsoZ(t.created_at)) ticket.created_at = t.created_at;
  state.tickets.set(ticket.id, ticket);
  indexChild(state, ticket);
  state.keyIndex.set(ticket.key, ticket.id);
  if (ticket.parent_id) {
    const m = /\.(\d+)$/.exec(ticket.key);
    if (m) state.counters.childByParent.set(ticket.parent_id, Math.max(state.counters.childByParent.get(ticket.parent_id) ?? 0, Number(m[1])));
  }
  ticket.timeline.push(timelineEntry(ev, 'status', `Created (${t.created_via ?? source})`));
  ticket.revision = 0;
  const importedActivity = ticket.last_activity;
  touch(state, ticket, ev, result);
  // Imports carry historical activity; the import itself is not new work.
  if (source === 'migration' && importedActivity && importedActivity < ticket.last_activity) ticket.last_activity = importedActivity;
  return {};
}

// Zero-command binding (ADR 0005): a ticket key seen in a prompt or branch binds the session,
// creating the ticket under that key (with a deterministic id) when the store has none.
function bindExternal(state, session, ev, result) {
  const p = ev.payload;
  const ext = p.external;
  if (!ext || typeof ext.key !== 'string') return { rejected: 'external-invalid' };
  try { validateKey(ext.key); } catch { return { rejected: 'key-invalid' }; }
  let ticketId = state.keyIndex.get(ext.key) ?? null;
  if (!ticketId) {
    const project_id = p.project_id ?? Object.keys(state.meta.projects)[0] ?? null;
    if (!project_id) return { rejected: 'project-required' };
    const external = { system: ext.system ?? 'custom', key: ext.key, url: ext.url ?? null, validation: 'pending', validated_at: null, error: ext.error ?? null };
    const id = externalTicketId(state.meta.store_id, ext.key);
    const title = (typeof p.title_hint === 'string' && p.title_hint.trim()) ? p.title_hint.trim().slice(0, 200) : ext.key;
    const created = createTicket(state, ev, {
      id, key: ext.key, title, project_id, category: 'research', priority: 'P2', repo_id: p.repo_id ?? null, external,
      jira: external.system === 'jira' ? { key: ext.key, url: external.url, validation: 'pending', validated_at: null, error: external.error } : null,
      created_via: `auto from ${p.source ?? 'prompt'}`,
    }, 'evidence', result);
    if (created.rejected) return created;
    ticketId = id;
  }
  const ticket = state.tickets.get(ticketId);
  if (p.ensure_only === true) {
    ticket.timeline.push(timelineEntry(ev, 'status', `Mentioned in session ${session.host_session_id} (${p.source ?? 'prompt'})`));
    touch(state, ticket, ev, result);
    return {};
  }
  if (session.current_ticket_id === ticketId) return {};
  bindSession(state, session, ev, { ticket_id: ticketId, project_id: ticket.project_id }, result);
  return {};
}

// Shared by `ticket relink` and the dashboard's "Link to external" request.
function relinkTicket(state, ticket, ev, p, result) {
  const newKey = p.new_key;
  if (newKey && newKey !== ticket.key) {
    try { validateKey(newKey); } catch { return { rejected: 'key-invalid' }; }
    const owner = state.keyIndex.get(newKey);
    if (owner && owner !== ticket.id) return { rejected: 'key-collision' };
    if (!ticket.aliases.includes(ticket.key)) ticket.aliases.push(ticket.key);
    ticket.key = newKey;
    state.keyIndex.set(newKey, ticket.id);
  }
  if (p.jira !== undefined) ticket.jira = p.jira;
  if (p.external !== undefined) ticket.external = p.external;
  const link = ticket.external ? ` (${ticket.external.system} ${ticket.external.key}, validation ${ticket.external.validation})` : ticket.jira ? ` (Jira ${ticket.jira.key}, validation ${ticket.jira.validation})` : '';
  ticket.timeline.push(timelineEntry(ev, 'status', `Relinked to ${ticket.key}${link}`));
  touch(state, ticket, ev, result);
  return {};
}

// Owner-confirmed attachment of a session's unlinked work (ADR 0006). Unlike automatic binding
// this is retroactive by design: the owner picked the ticket for exactly the work shown.
function attachUnboundWork(state, ev, m, result) {
  const session = state.sessionsById.get(m.session_id);
  const w = session && session.unbound_work;
  if (!w || w.dismissed_at || (!w.files.length && !w.commits.length)) return { rejected: 'unbound-gone' };
  let ticketId = m.ticket_id ?? null;
  if (m.create) {
    ticketId = state.keyIndex.get(m.create.key) ?? null;
    if (!ticketId) {
      const created = createTicket(state, ev, m.create, 'manual', result);
      if (created.rejected) return created;
      ticketId = m.create.id;
    }
  }
  const ticket = ticketId ? state.tickets.get(ticketId) : null;
  if (!ticket) return { rejected: 'ticket-unknown' };
  for (const f of w.files) {
    const repo_id = f.repo_id ?? ticket.repo_id ?? null;
    const existing = ticket.files_touched.find((x) => x.repo_id === repo_id && x.relative_path === f.relative_path);
    if (existing) {
      if (f.first_seen < existing.first_seen) existing.first_seen = f.first_seen;
      if (f.last_seen > existing.last_seen) existing.last_seen = f.last_seen;
    } else {
      ticket.files_touched.push({ repo_id, relative_path: f.relative_path, first_seen: f.first_seen, last_seen: f.last_seen });
    }
  }
  w.commits.forEach((c, i) => {
    ticket.timeline.push(timelineEntry(ev, 'commit', `Commit ${c.sha.slice(0, 10)}${c.message ? `: ${c.message}` : ''} (attached)`, { index: i }));
  });
  const files = `${w.files.length} file${w.files.length === 1 ? '' : 's'}`;
  const commits = `${w.commits.length} commit${w.commits.length === 1 ? '' : 's'}`;
  ticket.timeline.push(timelineEntry(ev, 'write', `Attached unlinked work from session ${session.host_session_id}: ${files}, ${commits}`));
  for (const id of state.checkpointsBySession.get(session.id) ?? []) {
    const cp = state.checkpoints.get(id);
    if (cp && !cp.ticket_id) cp.ticket_id = ticket.id;
  }
  if (!ticket.session_ids.includes(session.id)) ticket.session_ids.push(session.id);
  if (!session.ticket_ids.includes(ticket.id)) session.ticket_ids.push(ticket.id);
  session.unbound_work = { revision: w.revision + 1, files: [], commits: [], first_at: null, last_at: null, dismissed_at: null };
  if (m.bind && !session.current_ticket_id) bindSession(state, session, ev, { ticket_id: ticket.id, project_id: ticket.project_id }, result);
  else touch(state, ticket, ev, result);
  recomputeUnpromoted(state, session);
  return {};
}

// Tool results wait for their matching pre-call attribution record; they are never assigned by
// ingestion order or current binding. Results still unmatched after a reconciliation run become
// visible unresolved events (TRD §Durability and concurrency).
function resolveAttribution(state, ev, result) {
  const key = sessionKey(ev);
  const attribution = ev.tool_call_id ? state.pendingToolCalls.get(`${key}:${ev.tool_call_id}`) : null;
  if (!attribution) {
    if (!ev.tool_call_id) {
      state.unresolved.push({ event_id: ev.event_id, session_key: key, tool_call_id: null, reason: 'missing-tool-call-id', at: ev.occurred_at });
      result.unresolved = true;
      return null;
    }
    if (!state.deferredResults) state.deferredResults = new Map();
    state.deferredResults.set(`${key}:${ev.tool_call_id}`, ev);
    result.deferred = true;
    return null;
  }
  return attribution;
}

function replayDeferred(state, key, toolCallId, result) {
  if (!state.deferredResults) return;
  const deferredKey = `${key}:${toolCallId}`;
  const pending = state.deferredResults.get(deferredKey);
  if (!pending) return;
  state.deferredResults.delete(deferredKey);
  const sub = applyEventInner(state, pending, { replayingDeferred: true });
  for (const id of sub.changed) result.changed.add(id);
}

function sweepDeferred(state, ev) {
  if (!state.deferredResults) return;
  for (const [deferredKey, pending] of state.deferredResults) {
    if (pending.occurred_at <= ev.occurred_at) {
      state.deferredResults.delete(deferredKey);
      state.unresolved.push({ event_id: pending.event_id, session_key: sessionKey(pending), tool_call_id: pending.tool_call_id, reason: 'missing-pre-tool', at: pending.occurred_at, swept_at: ev.occurred_at });
    }
  }
}

const UNBOUND_FILE_CAP = 500;
const UNBOUND_COMMIT_CAP = 200;

// Writes and commits captured while a session had no ticket stay on the session, unattributed,
// until the owner attaches or dismisses them from the inbox (ADR 0006). The revision only moves
// when this work changes, so inbox requests can be revision-checked against what the owner saw.
function recordUnboundWork(session, ev, { writePaths, commit, repo_id }) {
  let w = session.unbound_work;
  if (!w || w.dismissed_at || (!w.files.length && !w.commits.length)) {
    w = { revision: w ? w.revision : 0, files: [], commits: [], first_at: ev.occurred_at, last_at: ev.occurred_at, dismissed_at: null };
    session.unbound_work = w;
  }
  for (const rel of writePaths) {
    const existing = w.files.find((f) => f.repo_id === repo_id && f.relative_path === rel);
    if (existing) existing.last_seen = ev.occurred_at;
    else if (w.files.length < UNBOUND_FILE_CAP) w.files.push({ repo_id, relative_path: rel, first_seen: ev.occurred_at, last_seen: ev.occurred_at });
  }
  if (commit && !w.commits.some((c) => c.sha === commit.sha) && w.commits.length < UNBOUND_COMMIT_CAP) {
    w.commits.push({ sha: commit.sha, message: typeof commit.message === 'string' ? commit.message.slice(0, 200) : '', at: ev.occurred_at });
  }
  if (ev.occurred_at > w.last_at) w.last_at = ev.occurred_at;
  w.revision += 1;
}

function handlePostTool(state, ev, result) {
  const session = getOrCreateSession(state, ev);
  session.events_since_checkpoint += 1;
  const attribution = resolveAttribution(state, ev, result);
  if (!attribution) return;
  state.pendingToolCalls.delete(`${sessionKey(ev)}:${ev.tool_call_id}`);
  const p = ev.payload;
  const ticket = attribution.ticket_id ? state.tickets.get(attribution.ticket_id) : null;
  const repo = repoFor(state, p.repo_id ?? (ticket ? ticket.repo_id : null));

  if (p.plan_ref) {
    const cp = { id: deterministicId(`${ev.event_id}:plan-checkpoint`), session_id: session.id, ticket_id: attribution.ticket_id, binding_revision: attribution.binding_revision, recorded_at: ev.occurred_at, content_ref: p.plan_ref, preview: String(p.plan_preview ?? '').slice(0, 1500), complete: true, approved_at: null, approval_provenance: null, dismissed_at: null, sequence: ev.sequence ?? 0, kind: 'plan' };
    registerCheckpoint(state, cp);
    if (ticket) approveCheckpoint(state, ev, { checkpoint_id: cp.id, ticket_id: ticket.id, provenance: 'explicit' }, result);
    return;
  }

  if (!ticket) {
    const unboundPaths = WRITE_TOOLS.has(p.tool_name) && Array.isArray(p.write_paths) ? p.write_paths.filter((x) => typeof x === 'string' && x) : [];
    const unboundCommit = p.commit && typeof p.commit.sha === 'string' && p.commit.sha ? p.commit : null;
    if (unboundPaths.length || unboundCommit) {
      recordUnboundWork(session, ev, { writePaths: unboundPaths, commit: unboundCommit, repo_id: p.repo_id ?? null });
      session.successful_write_count += 1;
    }
    return;
  }
  const writePaths = Array.isArray(p.write_paths) ? p.write_paths.filter((x) => typeof x === 'string' && x) : [];
  if (WRITE_TOOLS.has(p.tool_name) && writePaths.length) {
    for (const rel of writePaths) {
      const existing = ticket.files_touched.find((f) => f.repo_id === (p.repo_id ?? ticket.repo_id) && f.relative_path === rel);
      if (existing) existing.last_seen = ev.occurred_at;
      else ticket.files_touched.push({ repo_id: p.repo_id ?? ticket.repo_id ?? null, relative_path: rel, first_seen: ev.occurred_at, last_seen: ev.occurred_at });
    }
    ticket.timeline.push(timelineEntry(ev, 'write', `${p.tool_name} ${writePaths.join(', ')}`, { coverage: 'complete' }));
    session.successful_write_count += 1;
    deriveStatusFromEvidence(ticket, { type: 'write', seq: ev.sequence ?? 0, evidence_id: ev.event_id }, repo);
  } else if (p.commit && typeof p.commit.sha === 'string' && p.commit.sha) {
    ticket.timeline.push(timelineEntry(ev, 'commit', `Commit ${p.commit.sha.slice(0, 10)}${typeof p.commit.message === 'string' && p.commit.message ? `: ${p.commit.message}` : ''}`, { coverage: 'complete' }));
    session.successful_write_count += 1;
  } else if (p.pr && p.pr.url) {
    const pr = { id: deterministicId(`${ev.event_id}:pr:${p.pr.url}`), provider: p.pr.provider ?? 'unknown', url: p.pr.url, state: p.pr.state ?? 'unknown', opened_at: ev.occurred_at, merged_at: null, base_branch: p.pr.base_branch ?? null, head_branch: p.pr.head_branch ?? null, observed_at: ev.occurred_at, error: null, evidence_id: ev.event_id };
    if (!ticket.prs.some((x) => x.url === pr.url)) ticket.prs.push(pr);
    ticket.timeline.push(timelineEntry(ev, 'pr', `PR ${pr.url} (${pr.state})`));
    if (pr.state === 'open' || pr.state === 'draft') deriveStatusFromEvidence(ticket, { type: pr.state === 'draft' ? 'pr-draft' : 'pr-open', seq: ev.sequence ?? 0, evidence_id: ev.event_id }, repo);
  } else {
    ticket.timeline.push(timelineEntry(ev, 'tool', `${p.tool_name ?? 'tool'} completed`, { coverage: 'unknown' }));
    if (session.change_coverage === 'complete' && !['Read', 'Glob', 'Grep'].includes(p.tool_name)) session.change_coverage = 'unknown';
  }
  touch(state, ticket, ev, result);
}

function handleStop(state, ev, result) {
  const session = getOrCreateSession(state, ev);
  const p = ev.payload;
  const complete = p.complete === true && typeof p.content_ref === 'string' && p.content_ref.length === 64;
  const cp = {
    id: ev.event_id, session_id: session.id, ticket_id: session.current_ticket_id, binding_revision: session.current_binding_revision,
    recorded_at: ev.occurred_at, content_ref: complete ? p.content_ref : null, preview: String(p.preview ?? '').slice(0, 1500), complete,
    approved_at: null, approval_provenance: null, dismissed_at: null, sequence: ev.sequence ?? 0, kind: ev.kind === 'subagent-stop' ? 'subagent' : 'stop',
  };
  registerCheckpoint(state, cp);
  session.last_checkpoint_id = cp.id;
  session.last_checkpoint_preview = cp.preview;
  session.events_since_checkpoint = 0;
  recomputeUnpromoted(state, session);
  const ticket = cp.ticket_id ? state.tickets.get(cp.ticket_id) : null;
  if (ticket) {
    if (complete) {
      for (const text of Array.isArray(p.conclusions) ? p.conclusions : []) {
        ticket.conclusions.push({ id: deterministicId(`${ev.event_id}:conclusion:${ticket.conclusions.length}`), session_id: session.id, checkpoint_id: cp.id, content_ref: cp.content_ref, preview: String(text).slice(0, 1500), recorded_at: ev.occurred_at, approved_at: null, provenance: null });
        ticket.timeline.push(timelineEntry(ev, 'conclusion', String(text).slice(0, 200), { content_ref: cp.content_ref }));
      }
      if (!Array.isArray(p.conclusions) || !p.conclusions.length) ticket.timeline.push(timelineEntry(ev, 'conclusion', `Checkpoint recorded (${p.length ?? cp.preview.length} chars)`, { content_ref: cp.content_ref }));
    } else {
      session.capture_health = { status: 'degraded', reason: 'checkpoint content unavailable', observed_at: ev.occurred_at };
      ticket.timeline.push(timelineEntry(ev, 'capture-error', 'Capture incomplete: checkpoint content unavailable', { coverage: 'partial' }));
    }
    touch(state, ticket, ev, result);
  }
}

function handleRequest(state, ev, result) {
  const r = ev.payload;
  if (!r || !r.id) return { rejected: 'request-invalid' };
  if (state.requests.has(r.id)) return { duplicate: true };
  state.requests.set(r.id, {
    schema_version: 1, store_id: state.meta.store_id, id: r.id, revision: 1, created_at: r.created_at ?? ev.occurred_at, updated_at: ev.occurred_at,
    actor_id: r.actor_id ?? 'owner', kind: r.kind, target_id: r.target_id ?? null, expected_revision: r.expected_revision ?? null, payload: r.payload ?? {},
    not_before: r.not_before ?? ev.occurred_at, state: 'pending', applied_revision: null, error: null, result: null, retry_of: r.retry_of ?? null, sequence: ev.sequence ?? 0,
    body_hash: r.body_hash ?? null,
  });
  result.requestsChanged.add(r.id);
  return {};
}

function handleRequestTx(state, ev, result) {
  const p = ev.payload;
  const req = state.requests.get(p.request_id);
  if (!req) return { rejected: 'request-unknown' };
  if (['applied', 'conflict', 'failed', 'cancelled'].includes(req.state)) return { duplicate: true };
  if (p.outcome === 'applying') {
    req.state = 'applying';
    req.updated_at = ev.occurred_at;
    req.revision += 1;
    result.requestsChanged.add(req.id);
    return {};
  }
  if (p.outcome === 'applied' && p.mutation) {
    const m = p.mutation;
    if (m.type === 'ticket-fields') {
      const ticket = state.tickets.get(m.ticket_id);
      if (ticket) {
        applyTicketFields(state, ticket, m.fields, ev, 'manual', result);
        req.applied_revision = ticket.revision;
      }
    } else if (m.type === 'handoff-create') {
      const handoff = { ...m.handoff };
      state.handoffs.set(handoff.id, handoff);
      const ticket = state.tickets.get(handoff.ticket_id);
      if (ticket) {
        if (!ticket.handoff_ids.includes(handoff.id)) ticket.handoff_ids.push(handoff.id);
        ticket.timeline.push(timelineEntry(ev, 'handoff', `Handoff queued (${handoff.mode})`));
        touch(state, ticket, ev, result);
        // The suggestion baseline is the ticket revision as recorded with the handoff itself.
        handoff.base_ticket_revision = ticket.revision;
      }
      result.handoffsChanged.add(m.handoff.id);
    } else if (m.type === 'handoff-cancel') {
      const h = state.handoffs.get(m.handoff_id);
      if (h && h.state === 'queued') {
        Object.assign(h, { state: 'cancelled', finished_at: ev.occurred_at, error: { code: 'cancelled', message: 'cancelled before dispatch' }, revision: (h.revision ?? 1) + 1, updated_at: ev.occurred_at });
        const ticket = state.tickets.get(h.ticket_id);
        if (ticket) { ticket.timeline.push(timelineEntry(ev, 'handoff', 'Handoff cancelled before dispatch')); touch(state, ticket, ev, result); }
        result.handoffsChanged.add(h.id);
      } else if (h && h.state === 'running') {
        h.cancel_requested = true;
        result.handoffsChanged.add(h.id);
      }
    } else if (m.type === 'unbound-attach') {
      const r = attachUnboundWork(state, ev, m, result);
      if (!r.rejected && m.ticket_id && state.tickets.has(m.ticket_id)) req.applied_revision = state.tickets.get(m.ticket_id).revision;
    } else if (m.type === 'unbound-dismiss') {
      const s = state.sessionsById.get(m.session_id);
      if (s && s.unbound_work && !s.unbound_work.dismissed_at) {
        s.unbound_work.dismissed_at = ev.occurred_at;
        s.unbound_work.revision += 1;
      }
    } else if (m.type === 'relink') {
      const ticket = state.tickets.get(m.ticket_id);
      if (ticket && !relinkTicket(state, ticket, ev, m, result).rejected) req.applied_revision = ticket.revision;
    } else if (m.type === 'refresh') {
      // no state mutation; the worker runs reconciliation as an effect
    }
  }
  req.state = p.outcome;
  req.error = p.error ?? null;
  req.result = p.result ?? null;
  if (p.applied_revision !== undefined && p.applied_revision !== null) req.applied_revision = p.applied_revision;
  req.updated_at = ev.occurred_at;
  req.revision += 1;
  result.requestsChanged.add(req.id);
  return {};
}

function handleHandoffTx(state, ev, result) {
  const p = ev.payload;
  const h = state.handoffs.get(p.handoff_id);
  if (!h) return { rejected: 'handoff-unknown' };
  const terminal = ['done', 'failed', 'cancelled', 'timed-out'];
  if (terminal.includes(h.state) && p.update && p.update.state && p.update.state !== h.state) return { duplicate: true };
  Object.assign(h, p.update ?? {});
  h.revision = (h.revision ?? 1) + 1;
  h.updated_at = ev.occurred_at;
  const ticket = state.tickets.get(h.ticket_id);
  if (Array.isArray(p.result_items) && ticket) {
    for (const [index, item] of p.result_items.entries()) {
      const identity = `${h.id}:${index}`;
      if (item.type === 'child') {
        if (state.handoffChildren?.has(identity)) continue;
        if (!state.handoffChildren) state.handoffChildren = new Set();
        const childId = item.id ?? deterministicId(`${h.id}:child:${index}`);
        if (state.tickets.has(childId)) continue;
        const r = createTicket(state, ev, { id: childId, key: item.key, title: item.title, project_id: ticket.project_id, project_name: ticket.project_name, category: item.category ?? ticket.category, priority: item.priority ?? ticket.priority, parent_id: ticket.id, repo_id: ticket.repo_id, next_action: item.next_action ?? '' }, 'manual', result);
        if (!r.rejected) {
          state.handoffChildren.add(identity);
          h.children_ids = [...(h.children_ids ?? []), childId];
          ticket.handoff_ids = ticket.handoff_ids.includes(h.id) ? ticket.handoff_ids : [...ticket.handoff_ids, h.id];
        }
      } else if (item.type === 'next-action') {
        if (ticket.revision !== h.base_ticket_revision) {
          h.uncertain_effects = [...(h.uncertain_effects ?? []), `next_action suggestion conflicted with revision ${ticket.revision}`];
        } else {
          applyTicketFields(state, ticket, { next_action: item.text }, ev, 'manual', result);
        }
      } else if (item.type === 'blocker') {
        h.result_summary = `${h.result_summary ?? ''}\nSuggested blocker: ${item.text}`.trim();
      }
    }
  }
  if (ticket && p.update && p.update.state && terminal.includes(p.update.state)) {
    ticket.timeline.push(timelineEntry(ev, 'handoff', `Handoff ${p.update.state}${h.error && h.error.code ? ` (${h.error.code})` : ''}`, { content_ref: h.result_ref ?? null }));
    touch(state, ticket, ev, result);
  }
  result.handoffsChanged.add(h.id);
  return {};
}

export function applyEvent(state, ev) {
  return applyEventInner(state, ev, {});
}

function applyEventInner(state, ev, { replayingDeferred = false }) {
  const result = { changed: new Set(), bindingChanged: new Set(), requestsChanged: new Set(), handoffsChanged: new Set(), effects: [] };
  if (!replayingDeferred) {
    if (state.appliedEvents.has(ev.event_id) || (ev.source_identity && state.appliedSources.has(ev.source_identity))) {
      result.duplicate = true;
      return result;
    }
    state.appliedEvents.add(ev.event_id);
    if (ev.source_identity) state.appliedSources.add(ev.source_identity);
  }
  if (Number.isInteger(ev.sequence) && ev.sequence > state.lastSequence) state.lastSequence = ev.sequence;
  if (!['reconcile', 'notify', 'request', 'request-tx'].includes(ev.kind) && ev.producer !== 'worker') {
    if (!state.lastCaptureAt || ev.occurred_at > state.lastCaptureAt) state.lastCaptureAt = ev.occurred_at;
  }

  switch (ev.kind) {
    case 'session-start': {
      const s = getOrCreateSession(state, ev, { source: ev.payload.source, cwd: ev.payload.cwd ?? null });
      if (ev.payload.machine_name) s.machine_name = ev.payload.machine_name;
      result.bindingChanged.add(sessionKey(ev));
      break;
    }
    case 'subagent-start': {
      const parentKey = sessionKey({ session_id: ev.payload.parent_session_id ?? ev.session_id });
      const parent = state.sessions.get(parentKey);
      const sub = getOrCreateSession(state, ev, { parent_session_id: parent ? parent.id : null });
      sub.agent_type = ev.payload.agent_type ?? null;
      if (parent && sub.bindings.length === 0) {
        sub.gate_enabled = parent.gate_enabled;
        bindSession(state, sub, ev, { ticket_id: parent.current_ticket_id, project_id: parent.project_ids[parent.project_ids.length - 1] ?? null }, result);
      }
      result.bindingChanged.add(sessionKey(ev));
      break;
    }
    case 'prompt': {
      const seen = state.sessions.has(sessionKey(ev));
      const s = getOrCreateSession(state, ev);
      // A session first seen through a prompt (started before `quill init`) gets a snapshot now.
      if (!seen) result.bindingChanged.add(sessionKey(ev));
      if (!s.title && ev.payload.title_candidate) s.title = String(ev.payload.title_candidate).slice(0, 80);
      if (ev.payload.approval_candidate === true) {
        const cp = heuristicApprovalEligible(state, s, ev.occurred_at);
        if (cp) approveCheckpoint(state, ev, { checkpoint_id: cp.id, ticket_id: cp.ticket_id, provenance: 'heuristic' }, result);
      }
      s.events_since_checkpoint += 1;
      break;
    }
    case 'pre-tool': {
      const s = getOrCreateSession(state, ev);
      s.events_since_checkpoint += 1;
      if (ev.tool_call_id) {
        // A provisional hook binding can name a ticket id the worker resolved differently (the key
        // belonged to an existing ticket); the session's own confirmed binding is authoritative then.
        const unknownTicket = !!ev.ticket_id && !state.tickets.has(ev.ticket_id);
        const ticket_id = unknownTicket ? s.current_ticket_id : (ev.ticket_id ?? s.current_ticket_id);
        const binding_revision = unknownTicket ? s.current_binding_revision : (ev.binding_revision ?? s.current_binding_revision);
        state.pendingToolCalls.set(`${sessionKey(ev)}:${ev.tool_call_id}`, { session_key: sessionKey(ev), ticket_id, binding_revision, tool_name: ev.payload.tool_name, sequence: ev.sequence, at: ev.occurred_at, denied: ev.payload.denied === true });
        replayDeferred(state, sessionKey(ev), ev.tool_call_id, result);
      }
      break;
    }
    case 'post-tool':
      handlePostTool(state, ev, result);
      break;
    case 'tool-failure': {
      const s = getOrCreateSession(state, ev);
      s.events_since_checkpoint += 1;
      const attribution = resolveAttribution(state, ev, result);
      if (attribution) {
        state.pendingToolCalls.delete(`${sessionKey(ev)}:${ev.tool_call_id}`);
        s.change_coverage = 'partial';
        const ticket = attribution.ticket_id ? state.tickets.get(attribution.ticket_id) : null;
        if (ticket) {
          ticket.timeline.push(timelineEntry(ev, 'tool', `failed: ${ev.payload.tool_name ?? 'tool'}${ev.payload.error ? ` — ${String(ev.payload.error).slice(0, 120)}` : ''}`, { coverage: 'partial' }));
          touch(state, ticket, ev, result);
        }
      }
      break;
    }
    case 'stop':
    case 'subagent-stop':
      handleStop(state, ev, result);
      break;
    case 'pre-compact': {
      const s = getOrCreateSession(state, ev);
      const ticket = s.current_ticket_id ? state.tickets.get(s.current_ticket_id) : null;
      if (ticket) {
        ticket.timeline.push(timelineEntry(ev, 'conclusion', `Pre-compaction recovery summary saved (${ev.payload.trigger ?? 'auto'})`, { content_ref: ev.payload.summary_ref ?? null }));
        touch(state, ticket, ev, result);
      }
      result.effects.push({ type: 'recovery-summary', session_key: sessionKey(ev) });
      break;
    }
    case 'session-end': {
      const s = getOrCreateSession(state, ev);
      s.ended_at = ev.occurred_at;
      s.state = 'ended';
      result.bindingChanged.add(sessionKey(ev));
      result.effects.push({ type: 'flush' });
      break;
    }
    case 'bind': {
      const s = getOrCreateSession(state, ev);
      // Always republish: a rejected bind must replace any provisional snapshot the hook wrote.
      result.bindingChanged.add(sessionKey(ev));
      if (ev.payload.external) { Object.assign(result, bindExternal(state, s, ev, result)); break; }
      const ticket = ev.payload.ticket_id ? state.tickets.get(ev.payload.ticket_id) : null;
      if (ev.payload.ticket_id && !ticket) { result.rejected = 'ticket-unknown'; break; }
      bindSession(state, s, ev, { ticket_id: ev.payload.ticket_id ?? null, project_id: ev.payload.project_id ?? (ticket ? ticket.project_id : null) }, result);
      break;
    }
    case 'gate-off':
    case 'gate-on': {
      const s = getOrCreateSession(state, ev);
      s.gate_enabled = ev.kind === 'gate-on';
      const ticket = s.current_ticket_id ? state.tickets.get(s.current_ticket_id) : null;
      if (ticket) {
        ticket.timeline.push(timelineEntry(ev, 'status', `Ticket gate ${ev.kind === 'gate-on' ? 'on' : 'off'} for session ${s.host_session_id}`));
        touch(state, ticket, ev, result);
      }
      result.bindingChanged.add(sessionKey(ev));
      break;
    }
    case 'ticket-create':
    case 'migration':
    case 'import': {
      const source = ev.kind === 'ticket-create' ? 'manual' : ev.kind;
      if (ev.payload.ticket) {
        Object.assign(result, createTicket(state, ev, ev.payload.ticket, source, result));
      } else if (ev.payload.ticket_id && ev.payload.fields) {
        const ticket = state.tickets.get(ev.payload.ticket_id);
        if (!ticket) result.rejected = 'ticket-unknown';
        else applyTicketFields(state, ticket, ev.payload.fields, ev, source, result);
      }
      break;
    }
    case 'ticket-update': {
      const ticket = state.tickets.get(ev.payload.ticket_id);
      if (!ticket) { result.rejected = 'ticket-unknown'; break; }
      try {
        applyTicketFields(state, ticket, ev.payload.fields ?? {}, ev, ev.payload.source ?? 'manual', result);
      } catch (err) {
        result.rejected = err.code ?? 'update-invalid';
      }
      break;
    }
    case 'relink': {
      const ticket = state.tickets.get(ev.payload.ticket_id);
      if (!ticket) { result.rejected = 'ticket-unknown'; break; }
      const r = relinkTicket(state, ticket, ev, ev.payload, result);
      if (r.rejected) result.rejected = r.rejected;
      break;
    }
    case 'approve':
      Object.assign(result, approveCheckpoint(state, ev, ev.payload, result));
      break;
    case 'dismiss': {
      const cp = state.checkpoints.get(ev.payload.checkpoint_id);
      if (!cp) { result.rejected = 'no-checkpoint'; break; }
      cp.dismissed_at = ev.occurred_at;
      const session = state.sessionsById.get(cp.session_id);
      if (session) recomputeUnpromoted(state, session);
      break;
    }
    case 'request':
      Object.assign(result, handleRequest(state, ev, result));
      break;
    case 'request-tx':
      Object.assign(result, handleRequestTx(state, ev, result));
      break;
    case 'handoff-tx':
      Object.assign(result, handleHandoffTx(state, ev, result));
      break;
    case 'notify':
      state.notified.add(ev.payload.checkpoint_id);
      break;
    case 'reconcile': {
      const p = ev.payload;
      sweepDeferred(state, ev);
      if (p.last_sync) state.lastSync = p.last_sync;
      if (Array.isArray(p.provider_health)) state.providerHealth = p.provider_health;
      for (const upd of Array.isArray(p.pr_updates) ? p.pr_updates : []) {
        const ticket = state.tickets.get(upd.ticket_id);
        if (!ticket) continue;
        const pr = ticket.prs.find((x) => x.id === upd.pr_id || x.url === upd.url);
        if (!pr) continue;
        if (upd.error) {
          // Failed poll: keep last known evidence and its age; only record the provider error.
          if (pr.error !== upd.error) { pr.error = upd.error; bumpRevision(ticket, ev.occurred_at); result.changed.add(ticket.id); }
          continue;
        }
        const before = `${pr.state}:${pr.merged_at}`;
        Object.assign(pr, { state: upd.state ?? pr.state, merged_at: upd.merged_at ?? pr.merged_at, opened_at: upd.opened_at ?? pr.opened_at, base_branch: upd.base_branch ?? pr.base_branch, head_branch: upd.head_branch ?? pr.head_branch, observed_at: upd.observed_at ?? ev.occurred_at, error: upd.error ?? null });
        const evidenceId = upd.evidence_id ?? `${pr.url}:${pr.state}:${pr.merged_at ?? ''}`;
        const changedEvidence = pr.evidence_id !== evidenceId;
        pr.evidence_id = evidenceId;
        const repo = repoFor(state, ticket.repo_id);
        if (changedEvidence || before !== `${pr.state}:${pr.merged_at}`) {
          if (pr.state === 'merged') deriveStatusFromEvidence(ticket, { type: 'pr-merged', seq: ev.sequence ?? 0, evidence_id: evidenceId, pr_id: pr.id, merged_at: pr.merged_at ?? ev.occurred_at, source_event_id: ev.event_id }, repo);
          else if (pr.state === 'open') deriveStatusFromEvidence(ticket, { type: 'pr-open', seq: ev.sequence ?? 0, evidence_id: evidenceId }, repo);
          else if (pr.state === 'draft') deriveStatusFromEvidence(ticket, { type: 'pr-draft', seq: ev.sequence ?? 0, evidence_id: evidenceId }, repo);
          ticket.timeline.push(timelineEntry(ev, 'pr', `PR ${pr.url} observed ${pr.state}`));
          bumpRevision(ticket, ev.occurred_at);
          refreshDerived(state, ticket);
          result.changed.add(ticket.id);
        }
      }
      break;
    }
    default:
      result.rejected = 'kind-unknown';
  }
  return result;
}
