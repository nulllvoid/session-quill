// Reusable components as pure HTML-string renderers (UI-DESIGN §Components).
import { relativeTime, formatAbsolute, ageLabel, parseMs } from './lib/time.js';

export const STATUS_ORDER = ['todo', 'active', 'review', 'deploy-pending', 'blocked', 'done'];
export const STATUS_LABELS = { todo: 'To do', active: 'Active', review: 'Review', 'deploy-pending': 'Deploy pending', blocked: 'Blocked', done: 'Done' };
export const CATEGORY_LABELS = { feature: 'Feature', bugfix: 'Bugfix', vuln: 'Vulnerability', infra: 'Infra', research: 'Research', analysis: 'Analysis' };
export const SESSION_LABELS = { live: 'Live', idle: 'Idle', ended: 'Ended', extinct: 'Extinct' };
export const HANDOFF_LABELS = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', 'timed-out': 'Timed out' };
export const REQUEST_LABELS = { sending: 'Sending', pending: 'Pending', applying: 'Applying', applied: 'Applied', conflict: 'Conflict', failed: 'Failed', cancelled: 'Cancelled' };

const ICONS = {
  ticket: '<path d="M2 5h12v2.5a1.5 1.5 0 0 0 0 3V13H2v-2.5a1.5 1.5 0 0 0 0-3Z"/><path d="M6 5v8"/>',
  feature: '<path d="M8 2l1.8 3.7 4.2.6-3 2.9.7 4.1L8 11.4l-3.7 1.9.7-4.1-3-2.9 4.2-.6Z"/>',
  bugfix: '<circle cx="8" cy="9" r="4"/><path d="M8 5V3M4.5 6.5 3 5M11.5 6.5 13 5M3 10H1M15 10h-2M4.5 12.5 3 14M11.5 12.5 13 14"/>',
  vuln: '<path d="M8 2 14 4.5v4c0 3.5-2.6 5.6-6 7-3.4-1.4-6-3.5-6-7v-4Z"/><path d="M8 6v3M8 11.5v.5"/>',
  infra: '<rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><path d="M5 4.75h.01M5 11.25h.01"/>',
  research: '<path d="M3 2.5h7l3 3V13.5H3Z"/><path d="M6 8h4M6 10.5h4"/>',
  analysis: '<path d="M2 13.5h12"/><path d="M4 11V7M7.5 11V4M11 11V8.5"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 3-7 4"/>',
  alert: '<path d="M8 2.5 14.5 13.5h-13Z"/><path d="M8 7v3M8 12v.5"/>',
  check: '<path d="M3 8.5 6.5 12 13 4.5"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>',
  download: '<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 13.5h11"/>',
  moon: '<path d="M13 10.5A6 6 0 0 1 5.5 3a6 6 0 1 0 7.5 7.5Z"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  play: '<path d="M4.5 3v10l8-5Z"/>',
  machine: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5.5 13.5h5"/>',
  copy: '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/>',
  inbox: '<path d="M2 9.5 4 3h8l2 6.5V13H2Z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
  link: '<path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1"/>',
  rocket: '<path d="M8 1.5c2.5 1.5 4 4.5 4 8l-1.5 1.5h-5L4 9.5c0-3.5 1.5-6.5 4-8Z"/><circle cx="8" cy="7" r="1.2"/><path d="M5.5 11 4.5 14M10.5 11l1 3"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  chevron: '<path d="m6 3 5 5-5 5"/>',
  undo: '<path d="M6.5 4.5h4a3 3 0 0 1 0 6H4"/><path d="m6.5 2.5-2.5 2 2.5 2"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.4M8 11.5v.5"/>',
};

export function icon(name, { label } = {}) {
  const body = ICONS[name] ?? ICONS.ticket;
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}

export function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function attr(value) {
  return esc(value);
}

export function timeEl(iso, now, timeZone = 'UTC', { absolute = false } = {}) {
  if (!iso) return '<span class="muted" aria-label="none">-</span>';
  const abs = formatAbsolute(iso, timeZone);
  const rel = relativeTime(iso, now);
  if (absolute) return `<time datetime="${attr(iso)}">${esc(abs)} <span class="muted">(${esc(rel)})</span></time>`;
  return `<time datetime="${attr(iso)}" title="${attr(abs)}" aria-label="${attr(`${rel}, ${abs}`)}">${esc(rel)}</time>`;
}

// A measured duration as people say it: 450 ms, 1.2 s, 12 s, 1 min 5 s.
export function formatDuration(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1000) return `${n} ms`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)} s`;
  if (n < 60_000) return `${Math.round(n / 1000)} s`;
  const total = Math.round(n / 1000);
  const sec = total % 60;
  return `${Math.floor(total / 60)} min${sec ? ` ${sec} s` : ''}`;
}

export function staleAgeLabel(ticket, now) {
  if (!ticket.stale) return null;
  return ageLabel(parseMs(now) - parseMs(ticket.last_activity));
}

export function statusChip(status, { stale = false, staleAge = null } = {}) {
  const label = STATUS_LABELS[status] ?? status;
  let html = `<span class="chip status" data-status="${attr(status)}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span>`;
  if (stale) html += ` <span class="chip stale" data-stale="true">${icon('clock')}Stale${staleAge ? ` · ${esc(staleAge)}` : ''}</span>`;
  return html;
}

export function categoryChip(category) {
  return `<span class="chip category" data-category="${attr(category)}">${icon(category in ICONS ? category : 'ticket')}${esc(CATEGORY_LABELS[category] ?? category)}</span>`;
}

const PRIORITY_WORDS = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' };

export function priorityMark(priority) {
  const strong = priority === 'P0' || priority === 'P1';
  return `<span class="priority${strong ? ' strong' : ''}" aria-label="Priority ${attr(priority)} ${attr(PRIORITY_WORDS[priority] ?? '')}" title="${attr(PRIORITY_WORDS[priority] ?? '')}">${esc(priority)}${strong ? ` ${esc(PRIORITY_WORDS[priority])}` : ''}</span>`;
}

// The badge carries the full breakdown in its tooltip; the card shows only the leading reason.
export function scoreBadge(entry) {
  const capped = entry.raw_score > 100;
  const lines = [`Priority score ${entry.score}${capped ? ` (capped at 100; raw ${entry.raw_score} determines rank)` : ''}`, ...(entry.reasons ?? [])];
  const title = lines.join('\n');
  return `<span class="score" title="${attr(title)}" aria-label="${attr(lines.join('. '))}"><span class="score-label">Score</span> ${esc(entry.score)}${capped ? '<span class="cap">+</span>' : ''}</span>`;
}

// "Merged PR awaiting deployment for 12 day(s): +20" -> the reason worth the most points, in words.
export function leadingReason(entry) {
  const reasons = entry.reasons ?? [];
  if (!reasons.length) return null;
  const points = (r) => { const m = /: \+(\d+)/.exec(r); return m ? Number(m[1]) : 0; };
  const top = reasons.reduce((best, r) => (points(r) > points(best) ? r : best), reasons[0]);
  return top.replace(/: \+\d+/, '').replace(/(\d+) day\(s\)/g, (_, n) => `${n} day${n === '1' ? '' : 's'}`);
}

export function sessionChip(state) {
  return `<span class="chip session" data-state="${attr(state)}"><span class="dot${state === 'live' ? ' pulse' : ''}" aria-hidden="true"></span>${esc(SESSION_LABELS[state] ?? state)}</span>`;
}

export function handoffChip(handoff) {
  const reason = handoff.error && handoff.error.message ? `: ${esc(handoff.error.message)}` : '';
  return `<span class="chip handoff" data-state="${attr(handoff.state)}">${esc(HANDOFF_LABELS[handoff.state] ?? handoff.state)}</span>${reason ? `<span class="muted small">${reason}</span>` : ''}`;
}

export function requestChip(state) {
  return `<span class="chip request" data-state="${attr(state)}">${esc(REQUEST_LABELS[state] ?? state)}</span>`;
}

export function keyEl(key, { short = false } = {}) {
  return `<code class="key" data-copy="${attr(key)}" title="${attr(key)} · Click to copy">${esc(short ? shortKey(key) : key)}</code>`;
}

// Long local keys keep their prefix and unique suffix; the full key stays in titles and copies.
export function shortKey(key, max = 22) {
  const k = String(key ?? '');
  if (k.length <= max) return k;
  const tail = Math.floor((max - 1) / 2);
  return `${k.slice(0, max - 1 - tail)}…${k.slice(-tail)}`;
}

export const SYSTEM_LABELS = { jira: 'Jira', linear: 'Linear', github: 'GitHub', custom: 'Tracker' };

// The ticket's tracker link, from `external` or the legacy `jira` field; only https URLs count.
export function externalLink(ticket) {
  const ext = ticket && ticket.external ? ticket.external : (ticket && ticket.jira ? { system: 'jira', ...ticket.jira } : null);
  if (!ext || typeof ext.key !== 'string') return null;
  const url = typeof ext.url === 'string' && /^https:\/\/[^\s"'<>`]+$/.test(ext.url) ? ext.url : null;
  return { system: ext.system ?? 'custom', key: ext.key, url, validation: ext.validation ?? 'pending' };
}

// A key that names an external ticket opens it in a new tab; the copy button copies the key.
export function ticketKey(ticket, { short = false } = {}) {
  const link = externalLink(ticket);
  if (!link || !link.url || link.key !== ticket.key) return keyEl(ticket.key, { short });
  const where = SYSTEM_LABELS[link.system] ?? 'tracker';
  return `<span class="key-group"><a class="key key-link" href="${attr(link.url)}" target="_blank" rel="noopener noreferrer" title="${attr(`Open ${ticket.key} in ${where} (new tab)`)}">${esc(short ? shortKey(ticket.key) : ticket.key)}</a><button type="button" class="copy-key" data-copy="${attr(ticket.key)}" aria-label="${attr(`Copy ${ticket.key}`)}" title="Copy key">${icon('copy')}</button></span>`;
}

export function externalChip(ticket) {
  const link = externalLink(ticket);
  if (!link) return '';
  const label = `${SYSTEM_LABELS[link.system] ?? 'Tracker'} ${link.key} · ${String(link.validation).replace(/-/g, ' ')}`;
  return link.url
    ? ` <a class="chip external" data-validation="${attr(link.validation)}" href="${attr(link.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${esc(label)}</a>`
    : ` <span class="chip external" data-validation="${attr(link.validation)}">${icon('link')}${esc(label)}</span>`;
}

export function hasUnlinkedWork(session) {
  const w = session && session.unbound_work;
  return !!(w && !w.dismissed_at && ((w.files ?? []).length || (w.commits ?? []).length));
}

export function requestFeedback(req, { now }) {
  const label = { 'set-next-action': 'next action', 'set-status': 'status', 'record-deployment': 'deployment', 'attach-unbound': 'attach', 'dismiss-unbound': 'dismiss', 'link-external': 'link', 'run-job': 'run', 'accept-suggestion': 'suggestion', 'dismiss-suggestion': 'dismissal', publish: 'publish', 'undo-file-effect': 'undo', 'restore-snapshot': 'restore', 'repo-clone': 'clone', 'approve-run': 'approve run', 'dismiss-run': 'dismiss run', 'memory-approve': 'approve learning', 'memory-edit': 'memory edit', 'memory-forget': 'retire', 'memory-pin': req.payload && req.payload.pinned === false ? 'unpin' : 'pin', 'memory-note': 'owner note' }[req.kind] ?? req.kind;
  const memory = typeof req.kind === 'string' && req.kind.startsWith('memory-');
  let body = '';
  if (req.state === 'sending') body = 'Sending to the worker…';
  else if (req.state === 'pending') {
    const left = Math.max(0, Math.ceil((parseMs(req.not_before) - parseMs(now)) / 1000));
    body = `Queued; applies in ${left} s. <button type="button" class="btn small" data-action="cancel-request" data-request="${attr(req.id)}">${icon('undo')}Undo</button>`;
  } else if (req.state === 'applying') body = 'Applying…';
  else if (req.state === 'applied') body = 'Applied.';
  else if (req.state === 'conflict') {
    const current = req.result && req.result.current ? req.result.current : {};
    const proposed = req.payload ?? {};
    if (memory) body = `<strong>Conflict:</strong> the entry changed to revision ${esc(req.error ? req.error.current_revision : '?')} first, so nothing was changed. Review it and try again. <button type="button" class="btn small ghost" data-action="discard-request" data-request="${attr(req.id)}">Dismiss</button>`;
    else body = `<strong>Conflict:</strong> the ticket changed to revision ${esc(req.error ? req.error.current_revision : '?')} first. Current: <code>${esc(JSON.stringify(current[req.kind === 'set-status' ? 'status' : 'next_action'] ?? current))}</code>; proposed: <code>${esc(JSON.stringify(proposed.status ?? proposed.next_action ?? proposed))}</code>. <button type="button" class="btn small" data-action="resubmit-request" data-request="${attr(req.id)}">Resubmit against new revision</button> <button type="button" class="btn small ghost" data-action="discard-request" data-request="${attr(req.id)}">Discard</button>`;
  } else if (req.state === 'failed') body = `<strong>Failed:</strong> ${esc(req.error ? req.error.message : 'unknown error')}${req.error && req.error.retryable ? ` <button type="button" class="btn small" data-action="retry-request" data-request="${attr(req.id)}">Retry</button>` : ''} <button type="button" class="btn small ghost" data-action="discard-request" data-request="${attr(req.id)}">Dismiss</button>`;
  else if (req.state === 'cancelled') body = 'Cancelled.';
  else if (req.state === 'already-applied' && memory) body = 'Too late to undo: the change was already applied.';
  else if (req.state === 'already-applied') body = 'Cancellation lost the race: the edit was already applied. <button type="button" class="btn small" data-action="reverse-request" data-request="${attr(req.id)}">Revert with a new revision-checked edit</button>';
  const proposedValue = memory ? null : req.payload && (req.payload.next_action ?? (req.payload.status ? STATUS_LABELS[req.payload.status] : null) ?? req.payload.key ?? req.payload.url ?? null);
  return `<div class="request-feedback" data-state="${attr(req.state)}" role="group" aria-label="${attr(`Pending ${label} change`)}">${requestChip(req.state)} <span class="label">${esc(label)}</span>${proposedValue ? ` → <span class="proposed">${esc(proposedValue)}</span>` : ''} <span class="feedback-body">${body}</span></div>`;
}

export function repoName(snapshot, repoId) {
  if (!repoId) return null;
  const r = (snapshot.repos ?? []).find((x) => x.id === repoId);
  return r ? r.display_name : repoId;
}

const ticketIndexes = new WeakMap();

export function ticketById(snapshot, id) {
  const tickets = snapshot.tickets ?? [];
  let index = ticketIndexes.get(tickets);
  if (!index) { index = new Map(tickets.map((t) => [t.id, t])); ticketIndexes.set(tickets, index); }
  return index.get(id) ?? null;
}

const TICKET_ARRAYS = ['aliases', 'children_ids', 'session_ids', 'tags', 'files_touched', 'plans', 'conclusions', 'timeline', 'prs', 'deployments', 'handoff_ids', 'validation_issues'];
const TICKET_DEFAULTS = { next_action: '', blocker: null, due: null, stale: false, files_touched_count: 0, plans_count: 0, children_done_count: 0, revision: 0, status: 'todo', priority: 'P3', category: 'research', summary: '', user_notes: '', project_name: '', parent_id: null, jira: null, external: null, status_source: 'manual', title: '', key: '' };
const normalized = new WeakMap();

export function normalizeTicket(t) {
  const out = { ...TICKET_DEFAULTS, ...t };
  for (const k of TICKET_ARRAYS) if (!Array.isArray(out[k])) out[k] = [];
  if (!('timeline_total' in out)) out.timeline_total = out.timeline.length;
  return out;
}

// Exports may omit fields; every renderer works from a snapshot with defaults filled in.
export function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  if (normalized.has(snapshot)) return normalized.get(snapshot);
  const out = {
    ...snapshot,
    tickets: (snapshot.tickets ?? []).map(normalizeTicket),
    sessions: (snapshot.sessions ?? []).map((s) => ({ bindings: [], ticket_ids: [], project_ids: [], current_binding_revision: 0, successful_write_count: 0, change_coverage: 'unknown', state: 'idle', machine_name: '', ...s })),
    checkpoints: snapshot.checkpoints ?? [],
    handoffs: (snapshot.handoffs ?? []).map((h) => ({ children_ids: [], changed_files: [], test_results: [], uncertain_effects: [], permissions: {}, ...h })),
    requests: snapshot.requests ?? [],
    schedules: snapshot.schedules ?? [], recipes: snapshot.recipes ?? [], publishers: snapshot.publishers ?? [], today: snapshot.today ?? null,
    run_proposals: snapshot.run_proposals ?? [],
    picknext: snapshot.picknext ?? [],
    blocked: snapshot.blocked ?? [],
    deployments_outstanding: snapshot.deployments_outstanding ?? [],
    repos: snapshot.repos ?? [],
    capabilities: snapshot.capabilities ?? { read: true },
    meta: { timezone: 'UTC', provider_health: [], counts_by_status: {}, stale_ticket_count: 0, unresolved_event_count: 0, tracker_version: '', store_name: '', schema_version: 1, ...(snapshot.meta ?? {}) },
  };
  normalized.set(snapshot, out);
  return out;
}

export function matchesFilters(ticket, filters, snapshot) {
  if (filters.project && ticket.project_id !== filters.project) return false;
  if (filters.category && ticket.category !== filters.category) return false;
  if (filters.repo === NEEDS_CLONE_FILTER) { if (ticket.repo_state !== 'needs-clone') return false; } else if (filters.repo && ticket.repo_id !== filters.repo) return false;
  if (filters.tag && !ticket.tags.includes(filters.tag)) return false;
  if (filters.stale && !ticket.stale) return false;
  if (filters.q) {
    const q = filters.q.toLowerCase();
    const hay = `${ticket.key} ${ticket.title} ${ticket.next_action ?? ''} ${ticket.blocker ?? ''} ${(ticket.aliases ?? []).join(' ')} ${repoName(snapshot, ticket.repo_id) ?? ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterTickets(snapshot, filters) {
  return snapshot.tickets.filter((t) => matchesFilters(t, filters, snapshot));
}

// "2 h 10 min active · 14 turns · 1.2M tokens (36k output)"; null when nothing was measured.
export function effortText(effort) {
  if (!effort || (!effort.active_ms && !effort.turns)) return null;
  const mins = Math.round((effort.active_ms ?? 0) / 60_000);
  const time = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  const t = effort.tokens ?? {};
  const total = (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0);
  const n = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x));
  return [`${time} active`, effort.turns ? `${effort.turns} turn${effort.turns === 1 ? '' : 's'}` : null, total ? `${n(total)} tokens (${n(t.output ?? 0)} output)` : null].filter(Boolean).join(' · ');
}

export const EMPTY_FILTERS ={ project: '', category: '', tag: '', repo: '', machine: '', stale: false, q: '' };

// A hash that names a view is the whole state: a shared or bookmarked link opens exactly what
// it says, never with a filter left over from earlier navigation.
export function filtersFromHash(hash, current, views) {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  const filters = views.includes(params.get('view')) ? { ...EMPTY_FILTERS } : { ...current };
  for (const k of ['project', 'category', 'tag', 'repo', 'machine', 'q']) if (params.has(k)) filters[k] = params.get(k);
  filters.stale = params.get('stale') === '1';
  return filters;
}

export const PICKNEXT_SIZE = 5;

// The worker publishes every eligible ticket in rank order; Pick next ranks within the filtered
// set, so a filter never empties the list while matching work exists.
export function pickNextEntries(snapshot, filters) {
  const out = [];
  for (const entry of snapshot.picknext ?? []) {
    const ticket = ticketById(snapshot, entry.ticket_id);
    if (!ticket || !matchesFilters(ticket, filters, snapshot)) continue;
    out.push({ entry: { ...entry, rank: out.length + 1 }, ticket });
    if (out.length === PICKNEXT_SIZE) break;
  }
  return out;
}

export function filterSessions(snapshot, filters) {
  let sessions = snapshot.sessions;
  if (filters.machine) sessions = sessions.filter((s) => s.machine_name === filters.machine);
  if (filters.project) sessions = sessions.filter((s) => (s.project_ids ?? []).includes(filters.project) || s.ticket_ids.some((id) => (ticketById(snapshot, id) ?? {}).project_id === filters.project));
  if (filters.q) {
    const q = filters.q.toLowerCase();
    sessions = sessions.filter((s) => `${s.host_session_id} ${s.title ?? ''} ${s.machine_name} ${s.ticket_ids.map((id) => (ticketById(snapshot, id) ?? {}).key ?? '').join(' ')}`.toLowerCase().includes(q));
  }
  return sessions;
}

// Sidebar badges count what each view shows under the current filters.
export function viewCounts(snapshot, filters = {}) {
  const tickets = filterTickets(snapshot, filters);
  const ids = new Set(tickets.map((t) => t.id));
  const today = snapshot.today && snapshot.today.days.length && snapshot.today.days[0].date === snapshot.today.generated_for ? snapshot.today.days[0] : null;
  return {
    picknext: pickNextEntries(snapshot, filters).length,
    board: tickets.filter((t) => t.status !== 'done').length,
    tree: tickets.filter((t) => !t.parent_id).length,
    sessions: filterSessions(snapshot, filters).filter((s) => s.state === 'live' || s.state === 'idle').length,
    deployments: snapshot.deployments_outstanding.filter((o) => ids.has(o.ticket_id)).length,
    runs: (snapshot.handoffs ?? []).filter((h) => (h.state === 'queued' || h.state === 'running') && ids.has(h.ticket_id)).length,
    today: today ? today.tickets.filter((t) => ids.has(t.ticket_id) || !ticketById(snapshot, t.ticket_id)).length : 0,
  };
}

// The repository chip (ADR 0024): Needs clone (with Clone… when the owner can act), Cloning while
// the worker clones, or No code. Tickets with a repository show its name instead.
export function repoChip(ticket, snapshot) {
  const state = ticket.repo_state;
  if (state === 'needs-clone') {
    const canClone = !!(snapshot.capabilities && snapshot.capabilities.edit_tickets);
    return `<span class="meta-item repo-state"><span class="chip warning small" data-repo-state="needs-clone">${icon('branch')}Needs clone</span>${canClone ? `<button type="button" class="btn small" data-action="clone-repo" data-ticket="${attr(ticket.id)}" aria-label="${attr(`Clone the repository for ${ticket.key}`)}">Clone…</button>` : ''}</span>`;
  }
  if (state === 'cloning') return `<span class="meta-item repo-state"><span class="chip small" data-repo-state="cloning"><span class="dot pulse" aria-hidden="true"></span>Cloning</span></span>`;
  if (state === 'no-code') return '<span class="meta-item repo-state"><span class="chip small" data-repo-state="no-code">No code</span></span>';
  return '';
}

export const NEEDS_CLONE_FILTER = ':needs-clone';

export function ticketCard(ticket, snapshot, { variant = 'board', now, selected = false, showHandoff = false, entry = null } = {}) {
  const canHandoff = showHandoff && snapshot.capabilities && snapshot.capabilities.handoff && ['todo', 'active', 'review', 'deploy-pending'].includes(ticket.status);
  const tz = snapshot.meta ? snapshot.meta.timezone : 'UTC';
  const meta = [];
  if (ticket.due) meta.push(`<span class="meta-item">${icon('clock')}Due ${esc(ticket.due)}</span>`);
  const repo = repoName(snapshot, ticket.repo_id);
  if (repo) meta.push(`<span class="meta-item">${icon('branch')}${esc(repo)}</span>`);
  const chip = repoChip(ticket, snapshot);
  if (chip) meta.push(chip);
  if (ticket.prs && ticket.prs.length) meta.push(`<span class="meta-item">${icon('link')}${ticket.prs.length} PR${ticket.prs.length === 1 ? '' : 's'}</span>`);
  if (ticket.files_touched_count) meta.push(`<span class="meta-item">${ticket.files_touched_count} file${ticket.files_touched_count === 1 ? '' : 's'}</span>`);
  meta.push(`<span class="meta-item">${icon('clock')}${timeEl(ticket.last_activity, now, tz)}</span>`);
  return `<article class="card card-${attr(variant)}${selected ? ' selected' : ''}${entry && entry.rank === 1 ? ' top' : ''}" data-ticket="${attr(ticket.id)}" tabindex="0" role="button" aria-label="${attr(`${ticket.key} ${ticket.title}`)}" aria-pressed="${selected ? 'true' : 'false'}">
  <header class="card-head">
    ${entry ? `<span class="rank" aria-label="Rank ${attr(entry.rank)}">${esc(entry.rank)}</span>` : ''}
    ${ticketKey(ticket, { short: true })}
    ${statusChip(ticket.status, { stale: ticket.stale, staleAge: staleAgeLabel(ticket, now) })}
    ${priorityMark(ticket.priority)}
    ${entry ? scoreBadge(entry) : ''}
  </header>
  <h3 class="card-title">${esc(ticket.title)}</h3>
  <div class="card-status">${categoryChip(ticket.category)}</div>
  ${variant !== 'compact' && ticket.next_action ? `<p class="next-strip"><span class="prompt" aria-hidden="true">&gt;</span><span><span class="eyebrow">Next action</span>${esc(ticket.next_action)}</span></p>` : ''}
  ${ticket.blocker ? `<p class="card-blocker">${icon('alert')}<span><span class="eyebrow">Blocker</span> ${esc(ticket.blocker)}</span></p>` : ''}
  ${entry && (leadingReason(entry) || (entry.limitations ?? []).length) ? `<ul class="reasons">${leadingReason(entry) ? `<li>${esc(leadingReason(entry))}</li>` : ''}${(entry.limitations ?? []).map((l) => `<li class="limitation">${icon('alert')}${esc(l)}</li>`).join('')}</ul>` : ''}
  <footer class="card-meta">${meta.join('')}</footer>
  ${canHandoff ? `<div class="card-actions"><button type="button" class="btn small" data-action="handoff" data-ticket="${attr(ticket.id)}">${icon('play')}Run agent</button></div>` : ''}
</article>`;
}

export function emptyState(title, body) {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${body}</p></div>`;
}

export function countLabel(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function pager(page, pages, { prefix }) {
  if (pages <= 1) return '';
  return `<nav class="pager" aria-label="Pagination"><button type="button" class="btn small" data-action="${attr(prefix)}-page" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${page + 1} of ${pages}</span><button type="button" class="btn small" data-action="${attr(prefix)}-page" data-page="${page + 1}" ${page + 1 >= pages ? 'disabled' : ''}>Next</button></nav>`;
}

// Loaded text for a content ref (results, timeline entries, plans, checkpoints) with its loading
// and failure states. A failure always offers Retry; nothing is left silently empty.
export function contentViewer(ref, { content = {}, status = {}, generation = '', label = 'Full text' } = {}) {
  if (!ref) return '';
  if (Object.hasOwn(content, ref)) return `<div class="content-viewer" data-ref="${attr(ref)}"><button type="button" class="link small" data-action="hide-content" data-hash="${attr(ref)}">Hide</button><pre class="full">${esc(content[ref])}</pre></div>`;
  const st = status[ref];
  if (st === 'reloading') return `<div class="content-viewer" data-ref="${attr(ref)}" aria-busy="true"><span class="muted small">The snapshot changed; reloading…</span></div>`;
  if (st === 'loading') return `<div class="content-viewer" data-ref="${attr(ref)}" aria-busy="true"><span class="muted small">Loading…</span></div>`;
  if (st && st.error) return `<div class="content-viewer" data-ref="${attr(ref)}"><span class="small critical" role="alert">Could not load: ${esc(st.error)}</span> <button type="button" class="btn small ghost" data-action="load-content" data-hash="${attr(ref)}" data-generation="${attr(generation)}">Retry</button></div>`;
  return `<button type="button" class="link small" data-action="load-content" data-hash="${attr(ref)}" data-generation="${attr(generation)}">${esc(label)}</button>`;
}

// How much of Claude Code a run may use (ADR 0017, ADR 0026). Autonomous is the default: every
// tool and connector, with Quill's guard checking each call and credentials redirected. The owner's
// own settings sit under Advanced; Full access is marked as a warning and says what it lifts.
export const FULL_ACCESS_NOTE = 'No Quill guard; prod writes allowed; your Claude Code deny rules still apply.';
// `access` is the level to show checked. When it is the one under Advanced, the details element
// renders open, so the group's checked member stays visible and focusable (design system §8);
// app.js keeps it open while it holds the checked radio. `scopes: true` (the single-run dialog)
// adds the Write scopes checklist under Advanced, after "Use my Claude Code settings".
export function accessFieldset(snapshot = null, { access = 'autonomous', scopes = false } = {}) {
  const level = ['autonomous', 'standard', 'full', 'settings'].includes(access) ? access : 'autonomous';
  const on = (v) => (v === level ? ' checked' : '');
  return `<fieldset class="access"><legend>Access</legend>
  <label><input type="radio" name="access" value="autonomous"${on('autonomous')}> Autonomous <span class="muted small">(your connected tools and local commands; production stays read-only; Quill's guard checks every call)</span></label>
  <label><input type="radio" name="access" value="standard"${on('standard')}> Standard <span class="muted small">(Quill's narrow profile: read, edit in the checkout, run tests; no connectors)</span></label>
  <label class="danger"><input type="radio" name="access" value="full"${on('full')}> Full access <span class="small access-note">${esc(FULL_ACCESS_NOTE)}</span></label>
  <details class="advanced access-advanced"${level === 'settings' ? ' open' : ''}><summary>Advanced: other access${scopes ? ' and write scopes' : ''}</summary>
  <label><input type="radio" name="access" value="settings"${on('settings')}> Use my Claude Code settings <span class="muted small">(your permission rules and connectors; anything that would need your approval is refused)</span></label>
  ${scopes ? writeScopes(snapshot, level) : ''}</details>${autonomyNotes(snapshot)}
</fieldset>`;
}

export const SCOPE_OFF_REASON = 'Write scopes need Autonomous access: only its guard holds a run to them.';

// Write scopes (spec §4.3, §8): one checkbox per catalog entry the worker reported (snapshot
// meta.autonomy.scopes), with what it permits and which credentials it switches to, and a target
// field where the scope takes one. Off, with the reason, unless the access is Autonomous; app.js
// switches them as the access changes, checks a box when its target is typed, and blocks Queue
// while a checked scope has no credentials configured (design system §5: blockers say why). Every word here comes from config, so all of it is escaped.
function writeScopes(snapshot, level) {
  const a = snapshot && snapshot.meta && snapshot.meta.autonomy && typeof snapshot.meta.autonomy === 'object' ? snapshot.meta.autonomy : null;
  const list = a && Array.isArray(a.scopes) ? a.scopes.filter((x) => x && typeof x.name === 'string') : [];
  if (!list.length) return '';
  const off = level !== 'autonomous';
  const dis = off ? ' disabled' : '';
  const rows = list.map((x, i) => {
    const targets = Array.isArray(x.targets) ? x.targets.filter((t) => typeof t === 'string') : [];
    const kind = typeof x.target_label === 'string' && x.target_label ? x.target_label : 'Target';
    const target = x.takes_target ? `<label class="indent small">${esc(kind)} <input type="text" name="scope_target:${attr(x.name)}" data-scope-target="${attr(x.name)}" aria-label="${attr(`${kind} for ${x.label ?? x.name}`)}" autocomplete="off" spellcheck="false" maxlength="128"${targets.length ? ` placeholder="${attr(targets[0])}"` : ''}${dis}></label>${targets.length ? ` <span class="muted small">credentials configured for ${esc(targets.join(', '))}</span>` : ''}` : '';
    const blocker = x.ready === false ? ` data-scope-blocker="${attr(`${x.label ?? x.name}: no credentials are configured for this scope, so a run that asks for it is refused. Set them in config.toml first, or untick it.`)}"` : '';
    return `<div class="scope-option"><label><input type="checkbox" name="scope" value="${attr(x.name)}" aria-describedby="scope-desc-${i}"${blocker}${dis}> ${esc(x.label ?? x.name)} <code>${esc(x.name)}</code></label>
  <p class="muted small" id="scope-desc-${i}">${esc(x.permits ?? '')} ${esc(x.switches ?? '')}</p>${target}</div>`;
  });
  return `<fieldset class="write-scopes"><legend>Write scopes</legend>
  <p class="muted small">Production and external writes this run may make, each only where its patterns in config.toml match. Everything else stays read-only; a write outside them is refused and recorded as a critical change.</p>
  <p class="small scope-reason" id="scope-reason" data-scope-reason${off ? '' : ' hidden'}>${esc(SCOPE_OFF_REASON)}</p>
  ${rows.join('\n  ')}
  <p class="small critical" role="alert" data-scope-blocked hidden></p>
  </fieldset>`;
}

// The scopes the Run dialog's form asks for: each checked one, as `name:target` when its target
// field holds one, in the order shown and without repeats. Disabled boxes are not in the form data.
export function scopeChoices(fd) {
  const out = [];
  for (const raw of fd.getAll('scope')) {
    const name = String(raw);
    const target = String(fd.get(`scope_target:${name}`) ?? '').trim();
    const spec = target ? `${name}:${target}` : name;
    if (name && !out.includes(spec)) out.push(spec);
  }
  return out;
}

// MCP sources an autonomous run trusts by origin; anything else only when the owner names the
// server in [handoff] trusted_mcp_servers (spec §4.2).
const TRUSTED_MCP_SOURCES = new Set(['claudeai', 'user', 'plugin']);
const MCP_SOURCE_TEXT = { claudeai: 'claude.ai connector', user: 'your Claude Code settings', plugin: 'plugin', project: "this repository's .mcp.json", local: 'local project settings' };
// The production CLIs whose credentials a run redirects (Task 9 report systems).
const CRED_SYSTEM_TEXT = [['kubernetes', 'Kubernetes (kubectl)'], ['aws', 'AWS (aws)'], ['gcp', 'Google Cloud (gcloud)'], ['azure', 'Azure (az)'], ['databases', 'Databases (psql, mysql)'], ['argo', 'Argo CD (argocd)']];
const CRED_VALUE_TEXT = { readonly: 'read-only profile', stub: 'no read-only profile; its reads are refused in autonomous runs', scope: 'write scope credentials', owner: 'your own credentials (shared with Claude Code\'s cloud sign-in)' };

// What the worker last recorded about autonomous runs on this machine (snapshot meta.autonomy):
// the connectors the latest run's Claude Code reported and the credential report of the latest
// autonomous run. Each line says what it rests on; with no meta.autonomy nothing is claimed.
function autonomyNotes(snapshot) {
  const a = snapshot && snapshot.meta && snapshot.meta.autonomy && typeof snapshot.meta.autonomy === 'object' ? snapshot.meta.autonomy : null;
  if (!a) return '';
  const short = (id) => esc(String(id ?? '').slice(0, 8));
  const out = ['<div class="autonomy-notes small">'];
  const inv = a.inventory && Array.isArray(a.inventory.mcpServers) ? a.inventory : null;
  if (!inv) out.push('<p class="muted">Connected tools: not known yet. The first run records what Claude Code reports.</p>');
  else {
    const trusted = new Set(Array.isArray(a.trusted_mcp_servers) ? a.trusted_mcp_servers : []);
    const rows = inv.mcpServers.map((s) => {
      const source = typeof s.source === 'string' && Object.hasOwn(MCP_SOURCE_TEXT, s.source) ? MCP_SOURCE_TEXT[s.source] : s.source ? `${s.source} configuration` : 'unknown source';
      const state = s.status === 'pending'
        ? '<span class="chip small">Not connected yet when the run started (pending)</span>'
        : s.status && s.status !== 'connected' ? `<span class="chip small">Unavailable (${esc(s.status === 'needs-auth' ? 'needs auth' : s.status)})</span>`
        : !TRUSTED_MCP_SOURCES.has(s.source) && !trusted.has(s.name) ? '<span class="chip small warning">Not trusted for autonomous runs</span>' : '<span class="chip small good">Connected</span>';
      return `<li><strong>${esc(s.name)}</strong> <span class="muted">${esc(source)}</span> ${state}</li>`;
    });
    out.push(`<p>Connected tools this run can use <span class="muted">(as Claude Code reported them when run ${short(inv.run_id)} started)</span></p>`);
    out.push(rows.length ? `<ul class="connected-tools">${rows.join('')}</ul>` : '<p class="muted">No MCP servers or connectors were reported.</p>');
  }
  const cred = a.credentials && a.credentials.report && typeof a.credentials.report === 'object' ? a.credentials : null;
  const report = cred ? cred.report : {};
  const configured = new Set(Array.isArray(a.readonly_configured) ? a.readonly_configured : []);
  const lines = CRED_SYSTEM_TEXT.map(([sys, label]) => {
    let text;
    if (report[sys] === 'readonly') text = CRED_VALUE_TEXT.readonly;
    else if (configured.has(sys)) text = cred ? `read-only profile configured; run ${short(cred.run_id)} could not use it` : 'read-only profile configured; checked when a run starts';
    else text = cred && typeof report[sys] === 'string' && Object.hasOwn(CRED_VALUE_TEXT, report[sys]) ? CRED_VALUE_TEXT[report[sys]] : 'no read-only profile';
    return `<li>${esc(label)}: ${esc(text)}</li>`;
  });
  out.push(`<p>Production command-line tools <span class="muted">(${cred ? `credentials as run ${short(cred.run_id)} got them` : 'from your config; no autonomous run yet'})</span></p><ul class="cred-systems">${lines.join('')}</ul>`);
  const issues = [];
  const anyReadonly = CRED_SYSTEM_TEXT.some(([sys]) => report[sys] === 'readonly' || configured.has(sys));
  if (!anyReadonly) issues.push('No read-only credentials configured: reads through production commands (kubectl, aws, gcloud, az, psql, argocd) are refused in autonomous runs; connectors and local tools still work. Add profiles under [prod.readonly] in config.toml.');
  // A profile the config names but the latest run could not use is as actionable as none (review M-4).
  const unusable = cred ? CRED_SYSTEM_TEXT.filter(([sys]) => configured.has(sys) && report[sys] !== 'readonly') : [];
  if (unusable.length) issues.push(`Read-only profile configured but not used by run ${String(cred.run_id ?? '').slice(0, 8)}: ${unusable.map(([, label]) => label).join(', ')}. Its reads were refused; check the path or profile name under [prod.readonly] in config.toml.`);
  if (report.provider === 'shared') issues.push('Claude Code signs in through Bedrock or Vertex, so the agent can use those provider credentials too.');
  for (const r of Array.isArray(report.residual) ? report.residual : []) issues.push(`Not redirected (the guard refuses reading these files, but a script could still reach them): ${r}`);
  for (const e of Array.isArray(report.scope_errors) ? report.scope_errors : []) issues.push(`Scope setting ignored: ${e}`);
  if (issues.length) out.push(`<ul class="issues">${issues.map((t) => `<li data-level="warning">${icon('alert')}${esc(t)}</li>`).join('')}</ul>`);
  out.push('</div>');
  return out.join('');
}

// Runs proposed from a shared page (ADR 0025), still waiting for the owner, oldest first.
export function openProposals(snapshot, ticketId = null) {
  return (snapshot.run_proposals ?? []).filter((p) => p.state === 'proposed' && (!ticketId || p.ticket_id === ticketId)).sort((a, b) => (a.proposed_at < b.proposed_at ? -1 : a.proposed_at > b.proposed_at ? 1 : 0));
}

const RUNNING = new Set(['queued', 'running']);
const IN_FLIGHT = new Set(['sending', 'pending', 'applying']);

// One proposed run: recipe, access, who proposed it on which page, and Approve / Dismiss for the
// owner. The editor is what the page reported, so it is shown as data, never as a name we vouch for.
export function proposalItem(p, snapshot, { now, pending = [], withTicket = false, leases = null } = {}) {
  const caps = snapshot.capabilities ?? {};
  const tz = snapshot.meta ? snapshot.meta.timezone : 'UTC';
  const sent = pending.find((r) => (r.kind === 'approve-run' || r.kind === 'dismiss-run') && r.payload && r.payload.proposal_id === p.id && IN_FLIGHT.has(r.state));
  if (p.origin === 'run') return criticalItem(p, snapshot, { now, tz, caps, sent, withTicket, leases });
  const t = withTicket ? ticketById(snapshot, p.ticket_id) : null;
  const access = p.access === 'full' ? '<span class="chip warning small">Full access</span>' : p.access === 'settings' ? '<span class="chip small">My settings</span>' : p.access === 'autonomous' ? '<span class="chip small">Autonomous</span>' : '<span class="chip small">Standard access</span>';
  const perms = p.permissions ?? {};
  const kind = p.read_only ? '<span class="chip small">Read-only</span>' : perms.edit_source ? '<span class="chip warning small">Edits source</span>' : perms.edit_files || perms.delete_files ? '<span class="chip warning small">Changes files</span>' : '';
  const key = p.ticket_key ?? (t ? t.key : '');
  const actions = !caps.handoff ? '' : sent
    ? ` <span class="muted small">${sent.kind === 'approve-run' ? 'Approval sent' : 'Dismissal queued'}${sent.kind === 'dismiss-run' && sent.state === 'pending' ? ` <button type="button" class="btn small" data-action="cancel-request" data-request="${attr(sent.id)}" aria-label="${attr(`Undo dismissing the ${p.recipe.name} run`)}">${icon('undo')}Undo</button>` : ''}</span>`
    : ` <span class="proposal-actions"><button type="button" class="btn small" data-action="approve-run" data-ticket="${attr(p.ticket_id)}" data-proposal="${attr(p.id)}" aria-label="${attr(`Approve the ${p.recipe.name} run on ${key}`)}">Approve</button> <button type="button" class="btn small ghost" data-action="dismiss-run" data-ticket="${attr(p.ticket_id)}" data-proposal="${attr(p.id)}" aria-label="${attr(`Dismiss the ${p.recipe.name} run on ${key}`)}">Dismiss</button></span>`;
  return `<li class="proposal" data-proposal="${attr(p.id)}">${t ? `<button type="button" class="link" data-open="${attr(t.id)}">${keyEl(t.key)} ${esc(t.title)}</button> ` : ''}<strong>${esc(p.recipe.name)}</strong> ${access}${kind ? ` ${kind}` : ''} <span class="muted small">proposed on the ${esc(p.publisher)} page by ${p.editor ? `<code>${esc(p.editor)}</code>` : 'an unknown editor'} ${timeEl(p.proposed_at, now, tz)}</span>${actions}</li>`;
}

// A critical change a run proposed (spec §7.4, ADR 0028), on its local-only child ticket: what it
// is and which run of which ticket proposed it, the write scopes it needs as warning chips (in
// words), the exact action the guard would allow as code, the proposal's verify and rollback, and
// Approve and queue (scopes: …) / Dismiss. Every word came from an agent or config: all escaped.
// Verify, rollback and risk are omitted when the record has none. ADR 0031: "Valid for" before
// approving (`leases` keeps a choice across polling renders), and, when the worker projected
// `dry_run`, the dry run the approved run must pass first, or that the action has none.
function criticalItem(p, snapshot, { now, tz, caps, sent, withTicket = false, leases = null }) {
  const child = ticketById(snapshot, p.ticket_id);
  const spec = child && child.critical_spec && typeof child.critical_spec === 'object' ? child.critical_spec : {};
  const run = (snapshot.handoffs ?? []).find((h) => h.id === p.from_handoff_id) ?? null;
  const parent = (run && ticketById(snapshot, run.ticket_id)) || (child && child.parent_id ? ticketById(snapshot, child.parent_id) : null);
  const id8 = String(p.from_handoff_id ?? '').slice(0, 8);
  const key = child ? child.key : p.ticket_key ?? '';
  const scopes = (Array.isArray(p.scopes) ? p.scopes : []).filter((s) => s && typeof s.name === 'string').map((s) => (s.target ? `${s.name}:${s.target}` : s.name));
  const chips = scopes.map((s) => `<span class="chip warning small" title="${attr(`The approved run may write in ${s}, and only the pinned action`)}">${icon('alert')}Write scope ${esc(s)}</span>`).join(' ');
  const action = p.action_pin && typeof p.action_pin.guard === 'string' ? p.action_pin.guard : '';
  const line = (label, v) => (typeof v === 'string' && v.trim() ? `<p class="small">${label}: ${esc(v)}</p>` : '');
  const what = child ? `<button type="button" class="link" data-open="${attr(child.id)}">${keyEl(child.key)} ${esc(child.title)}</button>` : keyEl(key);
  const scopeText = scopes.join(', ');
  // ADR 0031: how long the approval holds; the worker freezes the end in the run's grant.
  const where = withTicket ? 'runs' : 'detail';
  const chosen = leases && Object.hasOwn(leases, p.id) ? String(leases[p.id]) : '';
  const leaseId = `lease-${where}-${p.id}`;
  const lease = `<label class="lease-field small">Valid for <select id="${attr(leaseId)}" data-lease="${attr(p.id)}" aria-describedby="${attr(`${leaseId}-help`)}">${LEASE_CHOICES.map(([v, label]) => `<option value="${v}"${v === chosen ? ' selected' : ''}>${label}</option>`).join('')}</select></label> <span class="muted small" id="${attr(`${leaseId}-help`)}">The run's writes after it are refused; reads still run.</span>`;
  const actions = !caps.handoff ? '' : sent
    ? ` <span class="muted small">${sent.kind === 'approve-run' ? 'Approval sent' : 'Dismissal queued'}${sent.kind === 'dismiss-run' && sent.state === 'pending' ? ` <button type="button" class="btn small" data-action="cancel-request" data-request="${attr(sent.id)}" aria-label="${attr(`Undo dismissing the critical change on ${key}`)}">${icon('undo')}Undo</button>` : ''}</span>`
    : ` <span class="proposal-actions">${lease} <button type="button" class="btn small" data-action="approve-run" data-ticket="${attr(p.ticket_id)}" data-proposal="${attr(p.id)}" aria-label="${attr(`Approve and queue (scopes: ${scopeText}): the critical change on ${key}`)}">Approve and queue (scopes: ${esc(scopeText)})</button> <button type="button" class="btn small ghost" data-action="dismiss-run" data-ticket="${attr(p.ticket_id)}" data-proposal="${attr(p.id)}" aria-label="${attr(`Dismiss the critical change on ${key}`)}">Dismiss</button></span>`;
  return `<li class="proposal" data-kind="critical" data-proposal="${attr(p.id)}"><span class="critical-head"><strong>Critical change</strong> · ${what} · <span class="muted small">proposed by run <code>${esc(id8)}</code>${parent ? ` of ${esc(parent.key)}` : ''} ${timeEl(p.proposed_at, now, tz)}</span></span>${chips ? ` <span class="critical-scopes">${chips}</span>` : ''}<div class="critical-body"><p class="small">Action: <code class="critical-action">${esc(action)}</code></p>${dryRunLine(p.dry_run)}${line('Verify', spec.verify)}${line('Rollback', spec.rollback)}${line('Risk', spec.risk)}</div>${actions}</li>`;
}

const LEASE_CHOICES = [['', 'Whole run'], ['5', '5 min'], ['15', '15 min'], ['60', '1 h']];

function dryRunLine(d) {
  if (!d || typeof d !== 'object') return '';
  if (typeof d.twin === 'string' && d.twin) return `<p class="small">Dry run required in run: the guard refuses the action until <code class="critical-action">${esc(d.twin)}</code> exits 0 in the same run.</p>`;
  return `<p class="small"><span class="chip warning small">${icon('alert')}Dry run required in run</span> This action has no dry run Quill accepts, so the approved run refuses it while [critical] require_dry_run is on.</p>`;
}

// Whether the ticket already has a run, which an approval would then report instead of queueing.
export function hasActiveRun(snapshot, ticketId) {
  return (snapshot.handoffs ?? []).some((h) => h.ticket_id === ticketId && RUNNING.has(h.state));
}

// Memory trust (spec §6.2, ADR 0027), always in words: the colour only repeats it.
export const TRUST_LABELS = { owner: 'Owner', verified: 'Verified', sourced: 'Sourced', observed: 'Observed', quarantined: 'Quarantined' };
const TRUST_TITLES = {
  owner: 'Written, approved or edited by you',
  verified: 'Quill saw it: the worker observed it, or the run\'s own command is in the ledger with the claimed result',
  sourced: 'The cited file and line exist; the claim itself is not proven',
  observed: 'The run said so; Quill could not match it to a recorded command',
  quarantined: 'Held for your approval; never delivered to runs',
};

export function trustChip(trust) {
  return `<span class="chip trust small" data-trust="${attr(trust)}" title="${attr(TRUST_TITLES[trust] ?? '')}">${esc(TRUST_LABELS[trust] ?? trust)}</span>`;
}

const cut = (text, max) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

// Runs → Needs you (spec §6.4): a quarantined learning waits for the owner on the Memory page.
export function learningItem(e, snapshot, { now } = {}) {
  const tz = snapshot.meta ? snapshot.meta.timezone : 'UTC';
  const where = e.scope === 'repo' ? `repo ${repoName(snapshot, e.repo_id) ?? e.repo_id}` : e.scope === 'task' ? 'task' : 'machine';
  return `<li class="run-row memory-item" data-state="quarantined" data-entry="${attr(e.id)}"><span class="chip warning small">Quarantined learning</span> <span class="memory-text">${esc(cut(e.text, 200))}</span> <span class="small muted">Held: ${esc(e.quarantine_reason || 'awaiting approval')} · ${esc(where)} · filed ${timeEl(e.created_at, now, tz)}</span> <button type="button" class="btn small" data-action="open-memory" data-tab="quarantine" data-entry="${attr(e.id)}" aria-label="${attr(`Review the quarantined learning: ${cut(e.text, 60)}`)}">Review in Memory</button></li>`;
}

// Runs → Needs you: entries with the same key that disagree; runs get only the higher-ranked one.
export function memoryConflictItem(c, snapshot) {
  const where = c.scope === 'repo' ? `repo ${repoName(snapshot, c.repo_id) ?? c.repo_id}` : 'machine';
  return `<li class="run-row memory-item" data-state="conflict" data-conflict="${attr(c.id)}"><span class="chip warning small">Memory conflict</span> <span>Key <code>${esc(c.key)}</code>: ${esc(c.entry_ids.length)} entries disagree (${esc(where)}). Runs get only the higher-ranked one.</span> <button type="button" class="btn small" data-action="open-memory" data-tab="${c.scope === 'repo' ? 'repo' : 'machine'}"${c.repo_id ? ` data-repo="${attr(c.repo_id)}"` : ''} aria-label="${attr(`Resolve the memory conflict on ${c.key}`)}">Resolve in Memory</button></li>`;
}

// Whether a request record from the snapshot is tracked on this page (shown as feedback): one sent
// from here, or any still pending, applying, in conflict or failed. A request the owner dismissed
// stays dismissed when later polls bring it back, and a lost cancel race keeps its local state.
export function tracksSnapshotRequest(r, local, dismissed) {
  if (dismissed && dismissed.has(r.id)) return false;
  if (local && local.state === 'already-applied') return false;
  return !!local || ['pending', 'applying', 'conflict', 'failed'].includes(r.state);
}
