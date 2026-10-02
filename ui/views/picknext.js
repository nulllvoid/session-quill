import { esc, attr, ticketCard, ticketById, emptyState, matchesFilters, keyEl, icon, normalizeSnapshot, sessionChip, timeEl, countLabel, hasUnlinkedWork, requestFeedback } from '../components.js';

function mentionHint(snapshot) {
  return `Mention a ticket key such as <code>${esc(snapshot.meta.key_example ?? 'PROJ-123')}</code> in a Claude Code prompt, or run <code>/session-quill:ticket create "&lt;title&gt;"</code>.`;
}

function inboxItem(s, snapshot, { now, pending }) {
  const w = s.unbound_work;
  const tz = snapshot.meta.timezone;
  const files = w.files ?? [];
  const commits = w.commits ?? [];
  const mine = pending.filter((r) => r.target_id === s.id);
  const preview = s.last_checkpoint_preview ?? '';
  return `<li class="inbox-item" data-session="${attr(s.id)}">
  <div class="inbox-head">${sessionChip(s.state)} <strong>${esc(s.title || s.host_session_id)}</strong> <span class="muted small">${esc(s.host_session_id)} · ${esc(s.machine_name)} · last change ${timeEl(w.last_at, now, tz)}</span></div>
  <p class="small">${esc(countLabel(files.length, 'file'))}${commits.length ? `, ${esc(countLabel(commits.length, 'commit'))}` : ''}${files.length ? `: ${files.slice(0, 5).map((f) => `<code>${esc(f.relative_path)}</code>`).join(' ')}` : ''}${files.length > 5 ? ` <span class="muted">and ${esc(files.length - 5)} more</span>` : ''}</p>
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
  return `<section class="inbox" aria-labelledby="inbox-heading"><h2 id="inbox-heading">${icon('inbox')}Unlinked work <span class="count">${esc(items.length)}</span></h2><p class="small muted">Sessions that changed files or committed without a ticket. Attach the work to a ticket, create the ticket from its key, or dismiss it.</p><ul>${items.map((s) => inboxItem(s, snapshot, { now, pending })).join('')}</ul></section>`;
}

export function renderPickNext(rawSnapshot, filters, { now, pending = [] }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const entries = (snapshot.picknext ?? []).map((e) => ({ entry: e, ticket: ticketById(snapshot, e.ticket_id) })).filter((x) => x.ticket && matchesFilters(x.ticket, filters, snapshot));
  const blocked = (snapshot.blocked ?? []).map((b) => ({ b, ticket: ticketById(snapshot, b.ticket_id) })).filter((x) => x.ticket && matchesFilters(x.ticket, filters, snapshot));
  let main;
  if (!entries.length && blocked.length) {
    main = emptyState('Everything eligible is blocked', `Clear a blocker below, or start new work. ${mentionHint(snapshot)}`);
  } else if (!entries.length) {
    main = emptyState('No eligible work', `Pick next fills as tickets in to do, active, review or deploy-pending appear. ${mentionHint(snapshot)}`);
  } else {
    main = `<div class="section-head"><h2>Ranked candidates</h2><span class="section-count" style="margin:0">${esc(entries.length)} candidate${entries.length === 1 ? '' : 's'} · ranked by raw score, display capped at 100 · blocked and done excluded</span></div>
<div class="picknext-grid">${entries.map(({ entry, ticket }) => ticketCard(ticket, snapshot, { variant: 'picknext', now, showHandoff: true, entry })).join('')}</div>`;
  }
  const blockedHtml = blocked.length
    ? `<section class="blocked-list" aria-labelledby="blocked-heading"><h2 id="blocked-heading">${icon('alert')}Blocked <span class="count" aria-label="${esc(blocked.length)} blocked">${esc(blocked.length)}</span></h2><ul>${blocked.map(({ b, ticket }) => `<li><button type="button" class="link" data-open="${esc(ticket.id)}">${keyEl(ticket.key)} ${esc(ticket.title)}</button> — <span class="blocker-text">${esc(b.blocker)}</span></li>`).join('')}</ul></section>`
    : '';
  return `<section class="view view-picknext" aria-labelledby="tab-picknext"><h2 class="sr-only">Pick next</h2>${renderInbox(snapshot, { now, pending })}${main}${blockedHtml}</section>`;
}
