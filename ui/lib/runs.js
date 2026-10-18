// Runs (spec §2): which tab a run belongs to, batch groups, and the facts a row may state. Pure
// functions over snapshot records; nothing here guesses a reason or an ETA the worker did not record.
import { ticketById, matchesFilters, formatDuration } from '../components.js';

export const RUN_TABS = ['needs', 'live', 'failed', 'all'];
export const RUN_TAB_LABELS = { needs: 'Needs you', live: 'Live', failed: 'Failed', all: 'All' };
const LIVE = new Set(['queued', 'running']);
const FAILED = new Set(['failed', 'timed-out', 'cancelled']);
const DAY_MS = 86_400_000;
const NEEDS_WINDOW_MS = 7 * DAY_MS;
const ALL_WINDOW_MS = 30 * DAY_MS;

const newestFirst = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Whole minutes only, so a running row's markup changes at most once a minute and a poll does not
// rebuild the list (and drop focus) every 2 s.
function runningFor(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Running for under a minute';
  const h = Math.floor(mins / 60), m = mins % 60;
  return `Running for ${h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`}`;
}

export function isStaticSnapshot(snapshot) {
  return !!(snapshot.meta && snapshot.meta.exported_at);
}

// An export cannot act and strips suggestions, so it has no Needs you tab.
export function visibleRunTabs(snapshot) {
  return isStaticSnapshot(snapshot) ? RUN_TABS.filter((t) => t !== 'needs') : RUN_TABS;
}

export function ticketRuns(snapshot, ticketId) {
  return (snapshot.handoffs ?? []).filter((h) => h.ticket_id === ticketId).sort((a, b) => (a.requested_at < b.requested_at ? 1 : a.requested_at > b.requested_at ? -1 : 0));
}

// The run that retried this one (Retry as new run), else the next run on the same ticket.
export function supersededBy(snapshot, h) {
  const later = (snapshot.handoffs ?? []).filter((x) => x.id !== h.id && x.ticket_id === h.ticket_id && x.requested_at > h.requested_at);
  const retry = later.find((x) => x.retry_of && (x.retry_of === h.id || x.retry_of === h.request_id));
  if (retry) return { run: retry, retried: true };
  const next = later.sort((a, b) => (a.requested_at < b.requested_at ? -1 : 1))[0];
  return next ? { run: next, retried: false } : null;
}

export function openSuggestions(h) {
  return (h.suggestions ?? []).filter((s) => s.state === 'proposed');
}

// A finished run needs the owner while it has suggestions to decide on; a failure does for 7 days,
// on a ticket that is still open, until any later run on that ticket supersedes it. Cancelled runs
// never do: the owner cancelled them.
export function needsYou(snapshot, h, now) {
  if (h.state === 'done') return openSuggestions(h).length > 0;
  if (h.state !== 'failed' && h.state !== 'timed-out') return false;
  const t = ticketById(snapshot, h.ticket_id);
  if (!t || t.status === 'done') return false;
  if (Date.parse(now) - Date.parse(h.finished_at ?? h.requested_at) > NEEDS_WINDOW_MS) return false;
  return !supersededBy(snapshot, h);
}

// Mirrors the ticket filters matchesFilters applies (machine is Sessions-only, so it is not one here).
function hasFilters(f = {}) {
  return !!(f.project || f.category || f.tag || f.repo || f.stale || f.q);
}

// What of memory needs the owner (spec §6.4): each quarantined learning, and each group of entries
// that disagree on a key. Memory reaches the page only from the owner endpoint, never an export.
function memoryNeeds(memory, filters) {
  if (!memory) return [];
  const f = filters ?? {};
  // A memory item has no ticket: only a repo filter can select it, and only its own repo.
  const keep = (repoId) => !hasFilters(f) || (!!f.repo && repoId === f.repo && !f.project && !f.category && !f.tag && !f.stale && !f.q);
  const learnings = (memory.entries ?? []).filter((e) => e.trust === 'quarantined' && keep(e.repo_id ?? null)).map((e) => ({ kind: 'learning', id: e.id, at: e.created_at ?? '', entry: e }));
  const groups = (memory.conflicts ?? []).filter((c) => keep(c.repo_id ?? null)).map((c) => ({ kind: 'memory-conflict', id: c.id, at: c.at ?? '', conflict: c }));
  return [...learnings, ...groups];
}

export function runTabs(snapshot, filters, now, { memory = null } = {}) {
  const keep = (ticketId) => {
    const t = ticketById(snapshot, ticketId);
    return t ? matchesFilters(t, filters, snapshot) : !hasFilters(filters);
  };
  const runs = (snapshot.handoffs ?? []).filter((h) => keep(h.ticket_id)).map((h) => ({ kind: 'run', id: h.id, at: h.requested_at ?? '', run: h }));
  const proposals = (snapshot.run_proposals ?? []).filter((p) => (p.state === 'proposed' || p.state === 'expired') && keep(p.ticket_id)).map((p) => ({ kind: 'proposal', id: p.id, at: p.proposed_at ?? '', proposal: p }));
  const nowMs = Date.parse(now);
  const tabs = {
    needs: isStaticSnapshot(snapshot) ? [] : [...proposals.filter((x) => x.proposal.state === 'proposed'), ...runs.filter((x) => needsYou(snapshot, x.run, now)), ...memoryNeeds(memory, filters)],
    live: runs.filter((x) => LIVE.has(x.run.state)),
    failed: runs.filter((x) => FAILED.has(x.run.state)),
    all: [...proposals, ...runs.filter((x) => !Number.isFinite(Date.parse(x.at)) || nowMs - Date.parse(x.at) <= ALL_WINDOW_MS)],
  };
  for (const k of RUN_TABS) tabs[k].sort(newestFirst);
  return tabs;
}

export function defaultRunTab(tabs, names) {
  for (const k of ['needs', 'live']) if (names.includes(k) && tabs[k].length) return k;
  return 'all';
}

// Runs sharing a batch_id stay together, placed where their newest member falls.
export function groupRuns(items) {
  const out = [];
  const batches = new Map();
  for (const item of items) {
    const batchId = item.kind === 'run' ? item.run.batch_id : null;
    if (!batchId) { out.push(item); continue; }
    let group = batches.get(batchId);
    if (!group) { group = { kind: 'batch', id: batchId, at: item.at, items: [] }; batches.set(batchId, group); out.push(group); }
    group.items.push(item);
  }
  return out;
}

// What a row may say about a run: occupancy facts while queued, elapsed time while running, and
// outcomes once finished. Plain text; the caller escapes.
export function runFacts(snapshot, h, now) {
  const facts = [];
  if (h.state === 'queued') {
    facts.push('Queued');
    const fix = !!(h.permissions && h.permissions.edit_source);
    const running = (snapshot.handoffs ?? []).filter((x) => x.state === 'running' && !!(x.permissions && x.permissions.edit_source) === fix);
    const limits = snapshot.meta && snapshot.meta.handoff_limits;
    const cap = limits ? limits[fix ? 'fix' : 'readonly'] : null;
    if (Number.isInteger(cap) && running.length >= cap) facts.push(`${fix ? 'fix' : 'read-only'} slots ${running.length}/${cap} in use`);
    if (fix && h.repo_id && running.some((x) => x.repo_id === h.repo_id)) facts.push('repository busy');
  } else if (h.state === 'running') {
    facts.push(Number.isFinite(Date.parse(h.started_at)) ? runningFor(Math.max(0, Date.parse(now) - Date.parse(h.started_at))) : 'Running');
    if (h.timings && Number.isFinite(h.timings.worktree_ms)) facts.push(`setup ${formatDuration(h.timings.worktree_ms)}`);
  } else if (h.state === 'done') {
    const open = openSuggestions(h).length;
    if (open) facts.push(`${plural(open, 'suggestion')} to review`);
    if ((h.changed_files ?? []).length) facts.push(`${plural(h.changed_files.length, 'file')} changed`);
    if (h.pr_url) facts.push('draft PR opened');
    if (!facts.length) facts.push('Finished');
  } else {
    const gate = h.test_gate && h.test_gate.status;
    facts.push(h.error && h.error.message ? h.error.message : h.state === 'cancelled' ? 'Cancelled' : h.state === 'timed-out' ? 'Timed out' : gate === 'failed' ? 'Tests failed' : gate === 'timeout' ? 'Tests timed out' : 'Failed');
    const next = supersededBy(snapshot, h);
    if (next) facts.push(next.retried ? 'Retried as a new run' : 'Superseded by a later run');
  }
  return facts;
}

export function liveRunCount(snapshot) {
  return (snapshot.handoffs ?? []).filter((h) => LIVE.has(h.state)).length;
}

// The global attention count: the unfiltered Needs you list, memory items included (design system §7).
export function needsYouCount(snapshot, now, memory = null) {
  return runTabs(snapshot, {}, now, { memory }).needs.length;
}
