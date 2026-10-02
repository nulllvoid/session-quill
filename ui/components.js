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
  if (!iso) return '<span class="muted">—</span>';
  const abs = formatAbsolute(iso, timeZone);
  const rel = relativeTime(iso, now);
  if (absolute) return `<time datetime="${attr(iso)}">${esc(abs)} <span class="muted">(${esc(rel)})</span></time>`;
  return `<time datetime="${attr(iso)}" title="${attr(abs)}" aria-label="${attr(`${rel}, ${abs}`)}">${esc(rel)}</time>`;
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

export function scoreBadge(entry) {
  const capped = entry.raw_score > 100;
  const title = capped ? `Displayed score capped at 100; raw ${entry.raw_score} determines rank` : `Score ${entry.score}`;
  return `<span class="score" title="${attr(title)}" aria-label="${attr(title)}">${esc(entry.score)}${capped ? '<span class="cap">+</span>' : ''}</span>`;
}

export function sessionChip(state) {
  return `<span class="chip session" data-state="${attr(state)}"><span class="dot${state === 'live' ? ' pulse' : ''}" aria-hidden="true"></span>${esc(SESSION_LABELS[state] ?? state)}</span>`;
}

export function handoffChip(handoff) {
  const reason = handoff.error && handoff.error.message ? ` — ${esc(handoff.error.message)}` : '';
  return `<span class="chip handoff" data-state="${attr(handoff.state)}">${esc(HANDOFF_LABELS[handoff.state] ?? handoff.state)}</span>${reason ? `<span class="muted small">${reason}</span>` : ''}`;
}

export function requestChip(state) {
  return `<span class="chip request" data-state="${attr(state)}">${esc(REQUEST_LABELS[state] ?? state)}</span>`;
}

export function keyEl(key) {
  return `<code class="key" data-copy="${attr(key)}" title="Click to copy">${esc(key)}</code>`;
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
export function ticketKey(ticket) {
  const link = externalLink(ticket);
  if (!link || !link.url || link.key !== ticket.key) return keyEl(ticket.key);
  const where = SYSTEM_LABELS[link.system] ?? 'tracker';
  return `<span class="key-group"><a class="key key-link" href="${attr(link.url)}" target="_blank" rel="noopener noreferrer" title="${attr(`Open ${ticket.key} in ${where} (new tab)`)}">${esc(ticket.key)}</a><button type="button" class="copy-key" data-copy="${attr(ticket.key)}" aria-label="${attr(`Copy ${ticket.key}`)}" title="Copy key">${icon('copy')}</button></span>`;
}

export function externalChip(ticket) {
  const link = externalLink(ticket);
  if (!link) return '';
  const label = `${SYSTEM_LABELS[link.system] ?? 'Tracker'} ${link.key} · ${link.validation}`;
  return link.url
    ? ` <a class="chip external" data-validation="${attr(link.validation)}" href="${attr(link.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${esc(label)}</a>`
    : ` <span class="chip external" data-validation="${attr(link.validation)}">${icon('link')}${esc(label)}</span>`;
}

export function hasUnlinkedWork(session) {
  const w = session && session.unbound_work;
  return !!(w && !w.dismissed_at && ((w.files ?? []).length || (w.commits ?? []).length));
}

export function requestFeedback(req, { now }) {
  const label = { 'set-next-action': 'next action', 'set-status': 'status', 'record-deployment': 'deployment', 'attach-unbound': 'attach', 'dismiss-unbound': 'dismiss', 'link-external': 'link', 'run-job': 'run', 'accept-suggestion': 'suggestion', 'dismiss-suggestion': 'dismissal' }[req.kind] ?? req.kind;
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
    body = `<strong>Conflict:</strong> the ticket changed to revision ${esc(req.error ? req.error.current_revision : '?')} first. Current: <code>${esc(JSON.stringify(current[req.kind === 'set-status' ? 'status' : 'next_action'] ?? current))}</code>; proposed: <code>${esc(JSON.stringify(proposed.status ?? proposed.next_action ?? proposed))}</code>. <button type="button" class="btn small" data-action="resubmit-request" data-request="${attr(req.id)}">Resubmit against new revision</button> <button type="button" class="btn small ghost" data-action="discard-request" data-request="${attr(req.id)}">Discard</button>`;
  } else if (req.state === 'failed') body = `<strong>Failed:</strong> ${esc(req.error ? req.error.message : 'unknown error')}${req.error && req.error.retryable ? ` <button type="button" class="btn small" data-action="retry-request" data-request="${attr(req.id)}">Retry</button>` : ''} <button type="button" class="btn small ghost" data-action="discard-request" data-request="${attr(req.id)}">Dismiss</button>`;
  else if (req.state === 'cancelled') body = 'Cancelled.';
  else if (req.state === 'already-applied') body = 'Cancellation lost the race: the edit was already applied. <button type="button" class="btn small" data-action="reverse-request" data-request="${attr(req.id)}">Revert with a new revision-checked edit</button>';
  const proposedValue = req.payload && (req.payload.next_action ?? (req.payload.status ? STATUS_LABELS[req.payload.status] : null) ?? req.payload.key ?? null);
  return `<div class="request-feedback" data-state="${attr(req.state)}" role="group" aria-label="${attr(`Pending ${label} change`)}">${requestChip(req.state)} <span class="label">${esc(label)}</span>${proposedValue ? ` → <span class="proposed">${esc(proposedValue)}</span>` : ''} <span class="feedback-body">${body}</span></div>`;
}

export function repoName(snapshot, repoId) {
  if (!repoId) return null;
  const r = (snapshot.repos ?? []).find((x) => x.id === repoId);
  return r ? r.display_name : repoId;
}

export function ticketById(snapshot, id) {
  return (snapshot.tickets ?? []).find((t) => t.id === id) ?? null;
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
    schedules: snapshot.schedules ?? [], recipes: snapshot.recipes ?? [],
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
  if (filters.repo && ticket.repo_id !== filters.repo) return false;
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

export function ticketCard(ticket, snapshot, { variant = 'board', now, selected = false, showHandoff = false, entry = null } = {}) {
  const canHandoff = showHandoff && snapshot.capabilities && snapshot.capabilities.handoff && ['todo', 'active', 'review', 'deploy-pending'].includes(ticket.status);
  const tz = snapshot.meta ? snapshot.meta.timezone : 'UTC';
  const meta = [];
  if (ticket.due) meta.push(`<span class="meta-item">${icon('clock')}Due ${esc(ticket.due)}</span>`);
  const repo = repoName(snapshot, ticket.repo_id);
  if (repo) meta.push(`<span class="meta-item">${icon('branch')}${esc(repo)}</span>`);
  if (ticket.prs && ticket.prs.length) meta.push(`<span class="meta-item">${icon('link')}${ticket.prs.length} PR${ticket.prs.length === 1 ? '' : 's'}</span>`);
  if (ticket.files_touched_count) meta.push(`<span class="meta-item">${ticket.files_touched_count} file${ticket.files_touched_count === 1 ? '' : 's'}</span>`);
  meta.push(`<span class="meta-item">${icon('clock')}${timeEl(ticket.last_activity, now, tz)}</span>`);
  return `<article class="card card-${attr(variant)}${selected ? ' selected' : ''}${entry && entry.rank === 1 ? ' top' : ''}" data-ticket="${attr(ticket.id)}" tabindex="0" role="button" aria-label="${attr(`${ticket.key} ${ticket.title}`)}" aria-pressed="${selected ? 'true' : 'false'}">
  <header class="card-head">
    ${entry ? `<span class="rank" aria-label="Rank ${attr(entry.rank)}">${esc(entry.rank)}</span>` : ''}
    ${ticketKey(ticket)}
    ${statusChip(ticket.status, { stale: ticket.stale, staleAge: staleAgeLabel(ticket, now) })}
    ${priorityMark(ticket.priority)}
    ${entry ? scoreBadge(entry) : ''}
  </header>
  <h3 class="card-title">${esc(ticket.title)}</h3>
  <div class="card-status">${categoryChip(ticket.category)}</div>
  ${variant !== 'compact' && ticket.next_action ? `<p class="next-strip"><span class="prompt" aria-hidden="true">&gt;</span><span><span class="eyebrow">Next action</span>${esc(ticket.next_action)}</span></p>` : ''}
  ${ticket.blocker ? `<p class="card-blocker">${icon('alert')}<span><span class="eyebrow">Blocker</span> ${esc(ticket.blocker)}</span></p>` : ''}
  ${entry ? `<ul class="reasons">${entry.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}${(entry.limitations ?? []).map((l) => `<li class="limitation">${icon('alert')}${esc(l)}</li>`).join('')}</ul>${entry.raw_score > 100 ? `<p class="small muted">Displayed score capped at 100; raw ${esc(entry.raw_score)} determines the order.</p>` : ''}` : ''}
  <footer class="card-meta">${meta.join('')}</footer>
  ${canHandoff ? `<div class="card-actions"><button type="button" class="btn small" data-action="handoff" data-ticket="${attr(ticket.id)}">${icon('play')}Handoff</button></div>` : ''}
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
