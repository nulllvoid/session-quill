// Time-derived state (TRD §Reconciliation and lifecycle). Derived writes never change status or
// reset activity; they only toggle flags and session states.
import { ageMs, MINUTE, HOUR, DAY } from '../lib/time.js';
import { refreshTags } from '../core/state.js';

export const LIVE_MAX_MS = 30 * MINUTE;
export const EXTINCT_MIN_MS = 48 * HOUR;

export function sessionState(session, nowIso) {
  if (session.ended_at) return 'ended';
  const age = ageMs(session.last_event_at, nowIso);
  if (age <= LIVE_MAX_MS) return 'live';
  if (age < EXTINCT_MIN_MS) return 'idle';
  return 'extinct';
}

export function isStale(ticket, nowIso, staleDays = 5) {
  if (ticket.status !== 'active') return false;
  return ageMs(ticket.last_activity, nowIso) >= staleDays * DAY;
}

export function applyLifecycle(state, nowIso) {
  const changed = { tickets: new Set(), sessions: new Set(), notify: [] };
  for (const ticket of state.tickets.values()) {
    const stale = isStale(ticket, nowIso, state.meta.stale_days);
    if (stale !== ticket.stale) {
      ticket.stale = stale;
      refreshTags(ticket);
      changed.tickets.add(ticket.id);
    }
  }
  for (const [key, session] of state.sessions) {
    const next = sessionState(session, nowIso);
    if (next !== session.state) {
      session.state = next;
      changed.sessions.add(key);
    }
    if (next === 'extinct' && session.unpromoted) {
      for (const cp of state.checkpoints.values()) {
        if (cp.session_id === session.id && cp.complete && !cp.approved_at && !cp.dismissed_at && !state.notified.has(cp.id)) changed.notify.push(cp.id);
      }
    }
  }
  return changed;
}
