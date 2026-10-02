import { esc, ticketCard, ticketById, emptyState, matchesFilters, keyEl, icon, normalizeSnapshot } from '../components.js';

export function renderPickNext(rawSnapshot, filters, { now }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const entries = (snapshot.picknext ?? []).map((e) => ({ entry: e, ticket: ticketById(snapshot, e.ticket_id) })).filter((x) => x.ticket && matchesFilters(x.ticket, filters, snapshot));
  const blocked = (snapshot.blocked ?? []).map((b) => ({ b, ticket: ticketById(snapshot, b.ticket_id) })).filter((x) => x.ticket && matchesFilters(x.ticket, filters, snapshot));
  let main;
  if (!entries.length && blocked.length) {
    main = emptyState('Everything eligible is blocked', 'Clear a blocker below, or create new work with <code>/session-tracker:ticket create "&lt;title&gt;"</code>.');
  } else if (!entries.length) {
    main = emptyState('No eligible work', 'Pick next fills as tickets in to do, active, review or deploy-pending appear. Create one with <code>/session-tracker:ticket create "&lt;title&gt;"</code> in a Claude Code session.');
  } else {
    main = `<div class="section-head"><h2>Ranked candidates</h2><span class="section-count" style="margin:0">${esc(entries.length)} candidate${entries.length === 1 ? '' : 's'} · ranked by raw score, display capped at 100 · blocked and done excluded</span></div>
<div class="picknext-grid">${entries.map(({ entry, ticket }) => ticketCard(ticket, snapshot, { variant: 'picknext', now, showHandoff: true, entry })).join('')}</div>`;
  }
  const blockedHtml = blocked.length
    ? `<section class="blocked-list" aria-labelledby="blocked-heading"><h2 id="blocked-heading">${icon('alert')}Blocked <span class="count" aria-label="${esc(blocked.length)} blocked">${esc(blocked.length)}</span></h2><ul>${blocked.map(({ b, ticket }) => `<li><button type="button" class="link" data-open="${esc(ticket.id)}">${keyEl(ticket.key)} ${esc(ticket.title)}</button> — <span class="blocker-text">${esc(b.blocker)}</span></li>`).join('')}</ul></section>`
    : '';
  return `<section class="view view-picknext" aria-labelledby="tab-picknext"><h2 class="sr-only">Pick next</h2>${main}${blockedHtml}</section>`;
}
