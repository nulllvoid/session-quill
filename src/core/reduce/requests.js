// Owner requests and handoffs: request lifecycle, transactions and accepted suggestions.
import { deterministicId } from '../../lib/ids.js';
import { hasValidDescription, descriptionProblems } from '../description.js';
import { timelineEntry, touch } from './common.js';
import { applyTicketFields, createTicket, relinkTicket } from './tickets.js';
import { attachUnboundWork } from './capture.js';
import { applySnapshotRestore } from './snapshots.js';

export function handleRequest(state, ev, result) {
  const r = ev.payload;
  if (!r || !r.id) return { rejected: 'request-invalid' };
  if (state.requests.has(r.id)) return { duplicate: true };
  state.requests.set(r.id, {
    schema_version: 1, store_id: state.meta.store_id, id: r.id, revision: 1, created_at: r.created_at ?? ev.occurred_at, updated_at: ev.occurred_at,
    actor_id: r.actor_id ?? 'owner', kind: r.kind, target_id: r.target_id ?? null, expected_revision: r.expected_revision ?? null, payload: r.payload ?? {},
    not_before: r.not_before ?? ev.occurred_at, state: 'pending', applied_revision: null, error: null, result: null, retry_of: r.retry_of ?? null, sequence: ev.sequence ?? 0,
    body_hash: r.body_hash ?? null,
    // Who journaled it: 'worker' for requests submitted through the worker (the dashboard, schedules,
    // publishers), else the ingress producer (the CLI). Approving a critical change needs both the
    // owner and the worker (ADR 0028); ingress cannot claim the worker.
    producer: typeof ev.producer === 'string' ? ev.producer.slice(0, 40) : null,
  });
  result.requestsChanged.add(r.id);
  return {};
}

export function handleRequestTx(state, ev, result) {
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
      // An approved proposal (ADR 0025) records who approved it and the run it became.
      const proposal = m.proposal_id && state.runProposals ? state.runProposals.get(m.proposal_id) : null;
      if (proposal && proposal.state === 'proposed') Object.assign(proposal, { state: 'approved', resolved_at: ev.occurred_at, resolved_by: req.actor_id ?? 'owner', request_id: req.id, handoff_id: handoff.id });
      result.handoffsChanged.add(m.handoff.id);
    } else if (m.type === 'file-effect-undo') {
      const h = state.handoffs.get(m.handoff_id);
      const effect = h ? (h.file_effects ?? []).find((x) => x.id === m.effect_id) : null;
      if (effect && !effect.undone_at) {
        effect.undone_at = ev.occurred_at;
        h.revision = (h.revision ?? 1) + 1;
        h.updated_at = ev.occurred_at;
        const ticket = state.tickets.get(h.ticket_id);
        if (ticket) { ticket.timeline.push(timelineEntry(ev, 'handoff', `Undid: ${effect.action === 'deleted' ? 'restored' : 'reverted'} ${effect.path}`)); touch(state, ticket, ev, result); }
        result.handoffsChanged.add(h.id);
      }
    } else if (m.type === 'snapshot-restore') {
      applySnapshotRestore(state, ev, m, result);
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
    } else if (m.type === 'run-proposal-dismiss') {
      const proposal = state.runProposals ? state.runProposals.get(m.proposal_id) : null;
      if (proposal && proposal.state === 'proposed') {
        Object.assign(proposal, { state: 'dismissed', resolved_at: ev.occurred_at, resolved_by: req.actor_id ?? 'owner', request_id: req.id });
        const ticket = state.tickets.get(proposal.ticket_id);
        if (ticket) { ticket.timeline.push(timelineEntry(ev, 'proposal', `Proposed ${proposal.recipe.name} run dismissed`)); result.changed.add(ticket.id); }
      }
    } else if (m.type === 'refresh') {
      // no state mutation; the worker runs reconciliation as an effect
    } else if (m.type === 'suggestion') {
      applySuggestion(state, ev, m, req, result);
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

// Accepting or dismissing a recipe suggestion (ADR 0008). The ticket change was computed when the
// request applied; a suggestion resolves once, so redelivery changes nothing.
export function applySuggestion(state, ev, m, req, result) {
  const h = state.handoffs.get(m.handoff_id);
  const sug = h ? (h.suggestions ?? []).find((s) => s.id === m.suggestion_id) : null;
  const ticket = state.tickets.get(m.ticket_id);
  if (!sug || sug.state !== 'proposed' || !ticket) return;
  sug.state = m.state;
  sug.resolved_at = ev.occurred_at;
  sug.request_id = req.id;
  h.revision = (h.revision ?? 1) + 1;
  h.updated_at = ev.occurred_at;
  result.handoffsChanged.add(h.id);
  if (m.state === 'dismissed' && typeof m.reason === 'string' && m.reason.trim()) {
    recordDismissal(ticket, h, sug, m.reason.trim(), req, ev);
    result.changed.add(ticket.id);
  }
  if (m.state !== 'accepted') return;
  if (m.fields) applyTicketFields(state, ticket, m.fields, ev, 'manual', result);
  if (m.child && !state.tickets.has(m.child.id)) {
    const r = createTicket(state, ev, { ...m.child, project_id: ticket.project_id, project_name: ticket.project_name, parent_id: ticket.id, repo_id: ticket.repo_id }, 'manual', result);
    if (!r.rejected) { sug.child_id = m.child.id; h.children_ids = [...(h.children_ids ?? []), m.child.id]; }
  }
  req.applied_revision = ticket.revision;
}

// The last this-many Run notes are kept per ticket; an older note is dropped when a new one arrives.
export const RUN_NOTES_MAX = 20;
// A note holding only dismissal reasons (a run that left no note of its own, ADR 0032) is capped on
// its own: it never pushes out a note with attempts, lessons or a failure record.
export const DISMISSAL_NOTES_MAX = 10;

const filled = (v) => Array.isArray(v) && v.length > 0;
const dismissalOnly = (n) => !filled(n.attempts) && !filled(n.lessons) && !n.failure && !n.withheld;

// The newest RUN_NOTES_MAX real notes and the newest DISMISSAL_NOTES_MAX dismissal-only ones, in
// arrival order: each kind only ever evicts its own oldest.
function capRunNotes(list) {
  let real = list.filter((n) => !dismissalOnly(n)).length;
  let quiet = list.length - real;
  return list.filter((n) => {
    if (dismissalOnly(n)) { if (quiet > DISMISSAL_NOTES_MAX) { quiet -= 1; return false; } return true; }
    if (real > RUN_NOTES_MAX) { real -= 1; return false; }
    return true;
  });
}

function appendRunNote(ticket, note, runId) {
  const entry = {
    run_id: runId,
    at: typeof note.at === 'string' ? note.at : null,
    attempts: Array.isArray(note.attempts) ? note.attempts.slice(0, 40) : [],
    lessons: Array.isArray(note.lessons) ? note.lessons.slice(0, 15) : [],
    // How many free-text fields the instruction filter withheld, and a page-proposed run's mark
    // (Task 14 must not deliver an origin 'page' note to other runs).
    ...(Number.isInteger(note.withheld) && note.withheld > 0 ? { withheld: note.withheld } : {}),
    ...(note.origin === 'page' ? { origin: 'page' } : {}),
  };
  const failure = runNoteFailure(note.failure);
  if (failure) entry.failure = failure;
  // Dismissals of this run's suggestions recorded before its note arrived stay with the note.
  const previous = (Array.isArray(ticket.run_notes) ? ticket.run_notes : []).find((n) => n && n.run_id === runId);
  if (previous && Array.isArray(previous.dismissals)) entry.dismissals = previous.dismissals;
  const list = (Array.isArray(ticket.run_notes) ? ticket.run_notes : []).filter((n) => n && n.run_id !== runId);
  list.push(entry);
  ticket.run_notes = capRunNotes(list);
}

// The failure ledger (ADR 0032): only the worker-structured fields of a failed test gate, copied
// field by field. Never test output or test names.
const SIGNATURE = /^[0-9a-f]{16}$/;
function runNoteFailure(f) {
  if (!f || typeof f !== 'object' || f.kind !== 'test-gate' || (f.status !== 'failed' && f.status !== 'timeout')) return null;
  return {
    kind: 'test-gate',
    status: f.status,
    command: typeof f.command === 'string' && f.command ? f.command.slice(0, 300) : null,
    exit_code: Number.isInteger(f.exit_code) ? f.exit_code : null,
    signature: typeof f.signature === 'string' && SIGNATURE.test(f.signature) ? f.signature : null,
    files_touched: (Array.isArray(f.files_touched) ? f.files_touched : []).filter((x) => typeof x === 'string' && x).slice(0, 20).map((x) => x.slice(0, 300)),
  };
}

// An owner's reason for dismissing a run's suggestion (ADR 0032), kept on that run's Run note, which
// stays local (exports, the mirror and vault notes drop run_notes). A run without a note gets a
// dismissal-only one, capped apart from the real notes (capRunNotes), so it never evicts one.
export const DISMISS_REASON_CHARS = 280;
export const DISMISSALS_MAX = 20;
function recordDismissal(ticket, h, sug, reason, req, ev) {
  const list = Array.isArray(ticket.run_notes) ? ticket.run_notes : [];
  let note = list.find((n) => n && n.run_id === h.id);
  if (!note) {
    note = { run_id: h.id, at: ev.occurred_at, attempts: [], lessons: [], ...(h.proposal ? { origin: 'page' } : {}) };
    ticket.run_notes = capRunNotes([...list, note]);
  }
  const item = { suggestion_id: sug.id, type: typeof sug.type === 'string' ? sug.type : null, reason: reason.slice(0, DISMISS_REASON_CHARS), at: ev.occurred_at, by: req.actor_id ?? 'owner' };
  note.dismissals = [...(Array.isArray(note.dismissals) ? note.dismissals : []).filter((d) => d && d.suggestion_id !== sug.id), item].slice(-DISMISSALS_MAX);
}

export function handleHandoffTx(state, ev, result) {
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
        const r = createTicket(state, ev, { id: childId, key: item.key, title: item.title, project_id: ticket.project_id, project_name: ticket.project_name, category: item.category ?? ticket.category, priority: item.priority ?? ticket.priority, parent_id: ticket.id, repo_id: ticket.repo_id, next_action: item.next_action ?? '', summary: item.summary ?? '' }, 'manual', result);
        if (!r.rejected) {
          state.handoffChildren.add(identity);
          h.children_ids = [...(h.children_ids ?? []), childId];
          ticket.handoff_ids = ticket.handoff_ids.includes(h.id) ? ticket.handoff_ids : [...ticket.handoff_ids, h.id];
        }
      } else if (item.type === 'next-action') {
        // The run's own tool calls are attributed to its ticket and bump the revision, so a run
        // queued with base_next_action conflicts only when the next action itself changed. Runs
        // journalled before that field existed keep the revision check, so replay is unchanged.
        const changed = typeof h.base_next_action === 'string' ? (ticket.next_action ?? '') !== h.base_next_action : ticket.revision !== h.base_ticket_revision;
        if (changed) {
          h.uncertain_effects = [...(h.uncertain_effects ?? []), `next_action suggestion conflicted with revision ${ticket.revision}`];
        } else {
          applyTicketFields(state, ticket, { next_action: item.text }, ev, 'manual', result);
        }
      } else if (item.type === 'description') {
        // A built-in run writes the description only where none is valid; the owner's stays (ADR 0014).
        if (!hasValidDescription(ticket) && descriptionProblems(item.text).length === 0) applyTicketFields(state, ticket, { summary: item.text }, ev, 'manual', result);
        else h.uncertain_effects = [...(h.uncertain_effects ?? []), 'description suggestion not applied: the ticket already has a valid description'];
      } else if (item.type === 'blocker') {
        h.result_summary = `${h.result_summary ?? ''}\nSuggested blocker: ${item.text}`.trim();
      }
    }
  }
  // A files run's changes (ADR 0015) join the timeline, and a ticket it changed waits for the
  // owner in review; it is never closed for them.
  if (ticket && p.update && Array.isArray(p.update.file_effects) && p.update.file_effects.length) {
    for (const [i, e] of p.update.file_effects.entries()) {
      ticket.timeline.push(timelineEntry(ev, 'write', `${e.action === 'deleted' ? 'Deleted (moved to Quill trash)' : 'Edited'} ${e.path}`, { index: i }));
    }
    if (['todo', 'active'].includes(ticket.status)) applyTicketFields(state, ticket, { status: 'review' }, ev, 'evidence', result);
    else touch(state, ticket, ev, result);
  }
  // A finished run's Run note (src/memory/file.js appendRunNotes): local to the ticket, never exported.
  if (ticket && p.run_notes && typeof p.run_notes === 'object' && !Array.isArray(p.run_notes) && (p.run_notes.ticket_id ?? h.ticket_id) === h.ticket_id) {
    appendRunNote(ticket, p.run_notes, h.id);
    result.changed.add(ticket.id);
  }
  if (ticket && p.update && p.update.state && terminal.includes(p.update.state)) {
    ticket.timeline.push(timelineEntry(ev, 'handoff', `Handoff ${p.update.state}${h.error && h.error.code ? ` (${h.error.code})` : ''}`, { content_ref: h.result_ref ?? null }));
    touch(state, ticket, ev, result);
  }
  result.handoffsChanged.add(h.id);
  return {};
}
