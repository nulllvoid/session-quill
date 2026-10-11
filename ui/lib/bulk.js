// Bulk selection and fan-out (ADR 0023): pure helpers the dashboard shell wires to the DOM. A bulk
// action is one ordinary request per ticket; runs queued together share a client-chosen batch id.
import { uuidv4 } from './api.js';
import { normalizeSnapshot, matchesFilters } from '../components.js';

// Statuses a run may be queued from, as on the ticket card's Handoff button.
export const RUNNABLE_STATUSES = ['todo', 'active', 'review', 'deploy-pending'];
const ACTIVE_RUN = new Set(['queued', 'running']);
const TERMINAL_RUN = new Set(['done', 'failed', 'cancelled', 'timed-out']);

export function toggleChecked(checked, id) {
  const next = new Set(checked);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// Shift-click: everything between the anchor and the clicked card, in the order shown.
export function selectRange(checked, orderedIds, anchor, id) {
  const next = new Set(checked);
  const from = orderedIds.indexOf(anchor);
  const to = orderedIds.indexOf(id);
  if (anchor === null || anchor === undefined || from < 0 || to < 0) { next.add(id); return next; }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (const x of orderedIds.slice(lo, hi + 1)) next.add(x);
  return next;
}

// Keyboard selection: `x` toggles the focused card, Esc clears a selection. With ctrl, meta or
// alt held, `x` belongs to the browser or the system (cut, shortcuts), not to the selection.
export function selectionKey(key, { focusedId = null, checkedSize = 0, ctrlKey = false, metaKey = false, altKey = false } = {}) {
  if (key === 'x' && focusedId && !ctrlKey && !metaKey && !altKey) return { type: 'toggle', id: focusedId };
  if (key === 'Escape' && checkedSize > 0) return { type: 'clear' };
  return null;
}

function repoOf(snapshot, ticket) {
  return ticket && ticket.repo_id ? (snapshot.repos ?? []).find((r) => r.id === ticket.repo_id) ?? null : null;
}

// What would happen to each selected ticket: ready, already running, no repository (fixes need
// one) or not eligible (done or blocked). A fix waits when another fix holds its repository.
export function bulkEntries(snapshot, ids, { mode = 'analyse' } = {}) {
  const fix = mode === 'attempt-fix';
  const tickets = new Map((snapshot.tickets ?? []).map((t) => [t.id, t]));
  const handoffs = snapshot.handoffs ?? [];
  const busyRepos = new Set(handoffs.filter((h) => ACTIVE_RUN.has(h.state) && h.permissions && h.permissions.edit_source).map((h) => h.repo_id ?? null));
  const out = [];
  for (const id of ids) {
    const ticket = tickets.get(id);
    if (!ticket) continue;
    const repo = repoOf(snapshot, ticket);
    let state = 'ready';
    if (!RUNNABLE_STATUSES.includes(ticket.status)) state = 'not-eligible';
    else if (handoffs.some((h) => h.ticket_id === id && ACTIVE_RUN.has(h.state))) state = 'running';
    else if (fix && !repo) state = 'no-repo';
    let waits = false;
    if (state === 'ready' && fix) {
      waits = busyRepos.has(repo.id);
      busyRepos.add(repo.id);
    }
    out.push({ ticket, state, waits, notesOnly: state === 'ready' && !repo });
  }
  return out;
}

// One handoff request per ready ticket, all with the same batch id.
export function bulkRequests(entries, { mode = 'analyse', access = 'settings', note = '', batchId = uuidv4() } = {}) {
  const fix = mode === 'attempt-fix';
  return entries.filter((e) => e.state === 'ready').map((e) => ({
    kind: 'handoff',
    target_id: e.ticket.id,
    expected_revision: e.ticket.revision,
    payload: {
      mode,
      note,
      permissions: { read_source: fix || !e.notesOnly, edit_source: fix, commit: false, push_branch: false, open_draft_pr: false },
      access,
      branch: null,
      batch_id: batchId,
    },
  }));
}

// The per-ticket result of a bulk submit, from its request's state.
export function bulkOutcome(req) {
  if (!req) return { label: 'Skipped', tone: 'neutral' };
  if (req.state === 'applied') return { label: 'Queued', tone: 'good' };
  if (req.state === 'conflict') return { label: 'Stale, refresh', tone: 'warning' };
  if (req.state === 'failed' && req.error && req.error.code === 'handoff-reserved') return { label: 'Already running', tone: 'neutral' };
  if (req.state === 'failed') return { label: `Failed${req.error && req.error.message ? `: ${req.error.message}` : ''}`, tone: 'critical' };
  if (req.state === 'cancelled') return { label: 'Cancelled', tone: 'neutral' };
  return { label: 'Sending', tone: 'neutral' };
}

// Bulk status change: one revision-checked request per ticket, each with its own undo window.
// A ticket already in the status is skipped, and so is "done" with an outstanding deployment,
// which needs its own record, waive or leave choice.
export function bulkStatusRequests(snapshot, ids, { status, blocker = '' } = {}) {
  const tickets = new Map((snapshot.tickets ?? []).map((t) => [t.id, t]));
  const bodies = [];
  const skipped = [];
  for (const id of ids) {
    const t = tickets.get(id);
    if (!t) continue;
    if (t.status === status) { skipped.push({ ticketId: id, reason: 'already in that status' }); continue; }
    if (status === 'done' && (t.deployments ?? []).some((d) => d.state === 'pending')) { skipped.push({ ticketId: id, reason: 'has an outstanding deployment; mark it done on the ticket' }); continue; }
    const payload = { status };
    if (status === 'blocked') payload.blocker = blocker;
    bodies.push({ kind: 'set-status', target_id: id, expected_revision: t.revision, payload, original: { status: t.status, blocker: t.blocker } });
  }
  return { bodies, skipped };
}

// Request ids from a bulk edit that can still be undone: inside their delay window, or still being
// sent (Undo all waits for those to land, then cancels them).
export function pendingUndo(requests, ids) {
  const get = (id) => (requests instanceof Map ? requests.get(id) : (requests ?? []).find((r) => r.id === id));
  return ids.filter((id) => { const r = get(id); return r && (r.state === 'pending' || r.state === 'sending'); });
}

// A second bulk edit joins the Undo all set while the earlier ones are still undoable.
export function mergeUndo(requests, previous, ids) {
  return [...new Set([...pendingUndo(requests, previous), ...ids])];
}

// The results dialog of a bulk submit is refreshed only while it still shows that batch; a
// dialog the owner closed, or one for another batch, is left alone.
export function batchDialogUpdate(dialog, batchId, rows) {
  if (!dialog || dialog.type !== 'bulk-results' || dialog.batchId !== batchId) return dialog;
  return { type: 'bulk-results', batchId, rows };
}

export function withoutIds(checked, ids) {
  const next = new Set(checked);
  for (const id of ids) next.delete(id);
  return next;
}

// Checked tickets that the current filters hide are dropped, so a bulk action never reaches a
// ticket the owner cannot see.
export function pruneChecked(snapshot, checked, filters = {}) {
  const s = normalizeSnapshot(snapshot);
  const visible = new Set(s.tickets.filter((t) => matchesFilters(t, filters, s)).map((t) => t.id));
  return new Set([...checked].filter((id) => visible.has(id)));
}

export function batchProgress(snapshot, batchId) {
  const out = { total: 0, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const h of snapshot.handoffs ?? []) {
    if (h.batch_id !== batchId) continue;
    out.total += 1;
    if (h.state === 'queued') out.queued += 1;
    else if (h.state === 'running') out.running += 1;
    else if (h.state === 'done') out.done += 1;
    else if (h.state === 'cancelled') out.cancelled += 1;
    else if (TERMINAL_RUN.has(h.state)) out.failed += 1;
  }
  return out;
}

// Batches worth a progress strip: any with a queued or running run, and those launched from
// this page until dismissed. Oldest first.
export function activeBatches(snapshot, known = []) {
  const first = new Map();
  for (const h of snapshot.handoffs ?? []) {
    if (!h.batch_id) continue;
    const live = ACTIVE_RUN.has(h.state) || known.includes(h.batch_id);
    if (live && (!first.has(h.batch_id) || h.requested_at < first.get(h.batch_id))) first.set(h.batch_id, h.requested_at ?? '');
  }
  return [...first.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id);
}
