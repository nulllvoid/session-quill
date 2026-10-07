import { esc, attr, ticketCard, ticketById, emptyState, matchesFilters, keyEl, icon, normalizeSnapshot, sessionChip, timeEl, countLabel, hasUnlinkedWork, requestFeedback } from '../components.js';

function mentionHint(snapshot) {
  return `Mention a ticket key such as <code>${esc(snapshot.meta.key_example ?? 'PROJ-123')}</code> in a Claude Code prompt, or run <code>/session-quill:ticket create "&lt;title&gt;"</code>.`;
}

const BLOCKED_PREVIEW = 5;

function basename(p) {
  return String(p ?? '').split(/[\/]/).filter(Boolean).pop() ?? String(p ?? '');
}

function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

function inboxItem(s, snapshot, { now, pending, multiMachine }) {
  const w = s.unbound_work;
  const tz = snapshot.meta.timezone;
  const files = w.files ?? [];
  const commits = w.commits ?? [];
  // Only live requests replace the actions; finished ones from an earlier batch must not hide them.
  const mine = pending.filter((r) => r.target_id === s.id && ['sending', 'pending', 'applying', 'conflict', 'failed'].includes(r.state));
  const preview = s.last_checkpoint_preview ?? '';
  return `<li class="inbox-item" data-session="${attr(s.id)}">
  <div class="inbox-head">${sessionChip(s.state)} <strong class="inbox-title">${s.title ? esc(s.title) : '<span class="muted">Untitled session</span>'}</strong> <span class="muted small">last change ${timeEl(w.last_at, now, tz)}${multiMachine ? ` · ${esc(s.machine_name)}` : ''} · <span title="${attr(s.host_session_id)}">session ${esc(shortId(s.host_session_id))}</span></span></div>
  <p class="small">${esc(countLabel(files.length, 'file'))}${commits.length ? `, ${esc(countLabel(commits.length, 'commit'))}` : ''}${files.length ? `: ${files.slice(0, 5).map((f) => `<code title="${attr(f.relative_path)}">${esc(basename(f.relative_path))}</code>`).join(' ')}` : ''}${files.length > 5 ? ` <span class="muted">and ${esc(files.length - 5)} more</span>` : ''}</p>
  ${commits.length ? `<p class="small muted">${commits.slice(0, 3).map((c) => `<code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.message)}`).join(' · ')}</p>` : ''}
  ${preview ? `<p class="small preview-inline"><span class="eyebrow">Last checkpoint</span> ${esc(preview.slice(0, 200))}${preview.length > 200 ? '…' : ''}</p>` : ''}
  ${mine.length ? mine.map((r) => requestFeedback(r, { now })).join('') : `<div class="inbox-actions"><button type="button" class="btn small" data-action="attach-unbound" data-session="${attr(s.id)}" data-mode="attach">${icon('link')}Attach to…</button><button type="button" class="btn small" data-action="attach-unbound" data-session="${attr(s.id)}" data-mode="create">${icon('ticket')}Create from key</button><button type="button" class="btn small ghost" data-action="dismiss-unbound" data-session="${attr(s.id)}" data-revision="${attr(w.revision)}">Dismiss as no-ticket</button></div>`}
</li>`;
}

// Work captured while a session had no ticket (ADR 0006). Owner-only: exports never carry it.
export function renderInbox(rawSnapshot, { now, pending = [] } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (!snapshot.capabilities || !snapshot.capabilities.edit_tickets) return '';
  const items = snapshot.sessions.filter(hasUnlinkedWork).sort((a, b) => (a.unbound_work.last_at < b.unbound_work.last_at ? 1 : -1));
  if (!items.length) return '';
  const multiMachine = new Set(snapshot.sessions.map((s) => s.machine_name)).size > 1;
  return `<section class="inbox" aria-labelledby="inbox-heading"><h2 id="inbox-heading">${icon('inbox')}Unlinked work <span class="count">${esc(items.length)}</span></h2><p class="small muted">Sessions that changed files or committed without a ticket. Attach the work to a ticket, create the ticket from its key, or dismiss it.</p><ul>${items.map((s) => inboxItem(s, snapshot, { now, pending, multiMachine })).join('')}</ul></section>`;
}

// Blocked work, grouped by project, reasons muted; long lists collapse behind "Show all".
function renderBlocked(blocked, { expanded }) {
  if (!blocked.length) return '';
  const groups = new Map();
  for (const x of blocked) {
    const name = x.ticket.project_name || 'No project';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(x);
  }
  const collapsible = blocked.length > BLOCKED_PREVIEW;
  let budget = collapsible && !expanded ? BLOCKED_PREVIEW : Infinity;
  const html = [];
  for (const [name, list] of groups) {
    if (budget <= 0) break;
    const shown = list.slice(0, budget);
    budget -= shown.length;
    html.push(`<li class="blocked-group">${groups.size > 1 ? `<h3>${esc(name)} <span class="count">${esc(list.length)}</span></h3>` : ''}<ul>${shown.map(({ b, ticket }) => `<li><button type="button" class="link" data-open="${attr(ticket.id)}">${keyEl(ticket.key)} ${esc(ticket.title)}</button>${b.blocker ? `<span class="blocker-text">${esc(b.blocker)}</span>` : ''}</li>`).join('')}</ul></li>`);
  }
  const toggle = collapsible ? `<button type="button" class="btn small ghost" data-action="toggle-blocked" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? 'Show fewer' : `Show all ${esc(blocked.length)}`}</button>` : '';
  return `<section class="blocked-list" aria-labelledby="blocked-heading"><h2 id="blocked-heading">${icon('alert')}Blocked <span class="count" aria-label="${attr(`${blocked.length} blocked`)}">${esc(blocked.length)}</span></h2><ul class="blocked-groups">${html.join('')}</ul>${toggle}</section>`;
}

export function renderPickNext(rawSnapshot, filters, { now, pending = [], blockedExpanded = false }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const entries = (snapshot.picknext ?? []).map((e) => ({ entry: e, ticket: ticketById(snapshot, e.ticket_id) })).filter((x) => x.ticket && matchesFilters(x.ticket, filters, snapshot));
  const blocked = (snapshot.blocked ?? []).map((b) => ({ b, ticket: ticketById(snapshot, b.ticket_id) })).filter((x) => x.ticket && matchesFilters(x.ticket, filters, snapshot));
  let main;
  const filtered = Object.values(filters).some(Boolean);
  if (!entries.length && !blocked.length && filtered) {
    main = emptyState('No matching work', 'Try a different search or filter. <button type="button" class="link" data-action="clear-filters">Clear all filters</button>');
  } else if (!entries.length && blocked.length) {
    main = emptyState('Everything eligible is blocked', `Clear a blocker below, or start new work. ${mentionHint(snapshot)}`);
  } else if (!entries.length) {
    main = emptyState('No eligible work', `Pick next fills as tickets in to do, active, review or deploy-pending appear. ${mentionHint(snapshot)}`);
  } else {
    main = `<div class="section-head"><h2>Up next</h2><span class="section-count" title="Ranked by raw score, display capped at 100; blocked and done excluded">${esc(entries.length)} candidate${entries.length === 1 ? '' : 's'} · ordered by priority score</span></div>
<div class="picknext-grid">${entries.map(({ entry, ticket }) => ticketCard(ticket, snapshot, { variant: 'picknext', now, showHandoff: true, entry })).join('')}</div>`;
  }
  const blockedHtml = renderBlocked(blocked, { expanded: blockedExpanded });
  const tickets = snapshot.tickets.filter((t) => matchesFilters(t, filters, snapshot));
  const stats = [
    ['Open tickets', tickets.filter((t) => t.status !== 'done').length, 'Not yet done', 'ticket'],
    ['In progress', tickets.filter((t) => t.status === 'active').length, 'Marked active', 'branch'],
    ['Needs attention', tickets.filter((t) => t.status === 'blocked' || t.stale).length, 'Blocked or stale', 'alert'],
    ['Completed', tickets.filter((t) => t.status === 'done').length, 'Marked done', 'check'],
  ];
  const overview = `<div class="work-overview" aria-label="Filtered ticket overview">${stats.map(([label, value, hint, glyph]) => `<div class="overview-stat"><span class="stat-label">${icon(glyph)}${label}</span><strong>${value}</strong><span class="stat-hint">${hint}</span></div>`).join('')}</div>`;
  return `<section class="view view-picknext" aria-labelledby="tab-picknext"><h2 class="sr-only">Pick next</h2>${overview}${renderInbox(snapshot, { now, pending })}${main}${blockedHtml}</section>`;
}
