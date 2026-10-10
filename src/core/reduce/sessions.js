// Sessions: creation, bindings and checkpoint approval.
import { deterministicId } from '../../lib/ids.js';
import { sessionKey, newSession, registerSession } from '../state.js';
import { timelineEntry, touch } from './common.js';

export function getOrCreateSession(state, ev, { source = 'startup', cwd = null, parent_session_id = null } = {}) {
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

export function bindSession(state, session, ev, { ticket_id, project_id }, result) {
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

export function recomputeUnpromoted(state, session) {
  const ids = state.checkpointsBySession.get(session.id);
  session.unpromoted = ids ? [...ids].some((id) => { const cp = state.checkpoints.get(id); return cp && cp.complete && !cp.approved_at && !cp.dismissed_at; }) : false;
}

export function approveCheckpoint(state, ev, { checkpoint_id, ticket_id, provenance }, result) {
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
