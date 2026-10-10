// Shared reducer helpers: timeline entries, ticket activity and the substantive-event set.
import { deterministicId } from '../../lib/ids.js';
import { refreshDerived, bumpRevision } from '../state.js';

// Owner edits applied through request transactions are substantive activity too (I7).
export const SUBSTANTIVE = new Set(['bind', 'post-tool', 'stop', 'subagent-stop', 'approve', 'ticket-update', 'ticket-create', 'relink', 'import', 'migration', 'handoff-tx', 'request-tx']);

export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function timelineEntry(ev, kind, text, { content_ref = null, coverage = 'complete', index = 0 } = {}) {
  return { id: deterministicId(`${ev.event_id}:timeline:${kind}:${index}:${text}`), at: ev.occurred_at, kind, text, event_id: ev.event_id, content_ref, coverage };
}

export function touch(state, ticket, ev, result) {
  bumpRevision(ticket, ev.occurred_at);
  if (SUBSTANTIVE.has(ev.kind) && ev.occurred_at > (ticket.last_activity ?? '')) ticket.last_activity = ev.occurred_at;
  refreshDerived(state, ticket);
  if (ticket.parent_id) {
    const parent = state.tickets.get(ticket.parent_id);
    if (parent) { refreshDerived(state, parent); result.changed.add(parent.id); }
  }
  result.changed.add(ticket.id);
}

export const UNBOUND_FILE_CAP = 500;

export const UNBOUND_COMMIT_CAP = 200;
