// Tool capture: attribution of tool results, deferred results, unlinked work and stop checkpoints.
import { deterministicId } from '../../lib/ids.js';
import { sessionKey, repoFor, registerCheckpoint } from '../state.js';
import { deriveStatusFromEvidence } from '../transitions.js';
import { WRITE_TOOLS, timelineEntry, touch, UNBOUND_FILE_CAP, UNBOUND_COMMIT_CAP } from './common.js';
import { getOrCreateSession, bindSession, recomputeUnpromoted, approveCheckpoint } from './sessions.js';
import { createTicket } from './tickets.js';

// Owner-confirmed attachment of a session's unlinked work (ADR 0006). Unlike automatic binding
// this is retroactive by design: the owner picked the ticket for exactly the work shown.
export function attachUnboundWork(state, ev, m, result) {
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
  // Attached writes are the same evidence a linked session would have produced.
  if (w.files.length) deriveStatusFromEvidence(ticket, { type: 'write', seq: ev.sequence ?? 0, evidence_id: ev.event_id }, repoFor(state, ticket.repo_id));
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
export function resolveAttribution(state, ev, result) {
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

export function sweepDeferred(state, ev) {
  if (!state.deferredResults) return;
  for (const [deferredKey, pending] of state.deferredResults) {
    if (pending.occurred_at <= ev.occurred_at) {
      state.deferredResults.delete(deferredKey);
      state.unresolved.push({ event_id: pending.event_id, session_key: sessionKey(pending), tool_call_id: pending.tool_call_id, reason: 'missing-pre-tool', at: pending.occurred_at, swept_at: ev.occurred_at });
    }
  }
}

// Writes and commits captured while a session had no ticket stay on the session, unattributed,
// until the owner attaches or dismisses them from the inbox (ADR 0006). The revision only moves
// when this work changes, so inbox requests can be revision-checked against what the owner saw.
export function recordUnboundWork(session, ev, { writePaths, commit, repo_id }) {
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

export function handlePostTool(state, ev, result) {
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

export function handleStop(state, ev, result) {
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
