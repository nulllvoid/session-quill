import { TrackerError } from '../lib/errors.js';
import { ageMs, MINUTE } from '../lib/time.js';

export const APPROVAL_PHRASES = ['approved', 'lgtm', 'go ahead', 'ship it'];
export const APPROVAL_WINDOW_MS = 10 * MINUTE;

// The complete trimmed case-insensitive prompt must equal a phrase. Quoted text, added
// sentences and negation never match (TRD §Capture and approval).
export function matchApprovalPhrase(prompt) {
  if (typeof prompt !== 'string') return false;
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  return APPROVAL_PHRASES.includes(normalized);
}

export function selectCheckpointForApproval(state, session, explicitId = null) {
  if (explicitId) {
    const cp = state.checkpoints.get(explicitId);
    if (!cp || !cp.complete) throw new TrackerError('no-checkpoint', `checkpoint ${explicitId} is unknown or incomplete`);
    if (cp.ticket_id !== session.current_ticket_id) {
      throw new TrackerError('checkpoint-mismatch', 'checkpoint belongs to a different ticket than the current binding');
    }
    return cp;
  }
  if (!session.current_ticket_id) throw new TrackerError('no-checkpoint', 'session is not bound to a ticket');
  let latest = null;
  for (const cp of state.checkpoints.values()) {
    if (cp.session_id !== session.id || !cp.complete) continue;
    if (cp.ticket_id !== session.current_ticket_id || cp.binding_revision !== session.current_binding_revision) continue;
    if (!latest || cp.recorded_at > latest.recorded_at || (cp.recorded_at === latest.recorded_at && cp.sequence > latest.sequence)) latest = cp;
  }
  if (!latest) throw new TrackerError('no-checkpoint', 'no complete checkpoint exists for the current binding');
  return latest;
}

export function heuristicApprovalEligible(state, session, promptAt) {
  if (!state.meta.approval_phrases_enabled) return null;
  if (!session.last_checkpoint_id) return null;
  const cp = state.checkpoints.get(session.last_checkpoint_id);
  if (!cp || !cp.complete || cp.approved_at || cp.dismissed_at) return null;
  if (cp.ticket_id === null || cp.ticket_id !== session.current_ticket_id) return null;
  if (cp.binding_revision !== session.current_binding_revision) return null;
  if (session.events_since_checkpoint !== 0) return null;
  if (ageMs(cp.recorded_at, promptAt) > APPROVAL_WINDOW_MS) return null;
  return cp;
}
