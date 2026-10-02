// Reservation rules: one queued/running handoff per ticket, one running attempt-fix per repository
// (TRD §Handoff execution, DATA-CONTRACT §Handoff).
const ACTIVE = new Set(['queued', 'running']);

export function reservationFor(state, ticketId) {
  for (const h of state.handoffs.values()) if (h.ticket_id === ticketId && ACTIVE.has(h.state)) return h;
  return null;
}

export function runningFixRepos(state, running = new Set()) {
  const repos = new Set();
  for (const h of state.handoffs.values()) {
    if (h.mode !== 'attempt-fix') continue;
    if (h.state === 'running' || running.has(h.id)) repos.add(h.repo_id ?? '__none__');
  }
  return repos;
}

// Queued handoffs eligible to start now, oldest first. Fix runs for the same repo serialize.
export function nextDispatchable(state, { running = new Set() } = {}) {
  const busyRepos = runningFixRepos(state, running);
  const out = [];
  const queued = [...state.handoffs.values()].filter((h) => h.state === 'queued' && !h.cancel_requested && !running.has(h.id));
  // Oldest first; ties (same second) resolve by the journal sequence of the creating request.
  const seq = (h) => { const r = state.requests.get(h.request_id); return r && Number.isInteger(r.sequence) ? r.sequence : Number.MAX_SAFE_INTEGER; };
  queued.sort((a, b) => (a.requested_at < b.requested_at ? -1 : a.requested_at > b.requested_at ? 1 : seq(a) - seq(b) || (a.id < b.id ? -1 : 1)));
  for (const h of queued) {
    if (h.mode === 'attempt-fix') {
      const repo = h.repo_id ?? '__none__';
      if (busyRepos.has(repo)) continue;
      busyRepos.add(repo);
    }
    out.push(h);
  }
  return out;
}
