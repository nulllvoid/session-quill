import { esc, attr, ticketCard, filterTickets, STATUS_ORDER, STATUS_LABELS, emptyState } from '../components.js';

export const BOARD_PAGE_SIZE = 40;

export function renderBoard(snapshot, filters, { now, layout = 'columns', expanded = new Set(), pages = {}, selected = null }) {
  const tickets = filterTickets(snapshot, filters);
  if (!tickets.length) {
    const any = snapshot.tickets.length;
    return `<section class="view view-board" aria-labelledby="tab-board">${any ? emptyState('No tickets match the current filters', 'Clear a filter token above to see more.') : emptyState('No tickets yet', 'Create the first one with <code>/session-tracker:ticket create "&lt;title&gt;"</code>.')}</section>`;
  }
  const staleCount = tickets.filter((t) => t.stale).length;
  const columns = STATUS_ORDER.map((status) => {
    const all = tickets.filter((t) => t.status === status).sort((a, b) => (a.last_activity < b.last_activity ? 1 : -1));
    const collapsed = status === 'done' && !expanded.has('done');
    const page = pages[status] ?? 0;
    const shown = all.slice(0, (page + 1) * BOARD_PAGE_SIZE);
    const more = all.length - shown.length;
    const cards = collapsed ? '' : shown.map((t) => ticketCard(t, snapshot, { variant: 'board', now, selected: selected === t.id })).join('');
    return `<section class="column" data-column="${attr(status)}" data-collapsed="${collapsed ? 'true' : 'false'}" aria-labelledby="col-${attr(status)}">
  <header class="column-head">
    <h3 id="col-${attr(status)}">${esc(STATUS_LABELS[status])} <span class="count" aria-label="${esc(all.length)} ticket${all.length === 1 ? '' : 's'}">${esc(all.length)}</span></h3>
    ${status === 'done' ? `<button type="button" class="btn small" data-action="toggle-column" data-column="done" aria-expanded="${collapsed ? 'false' : 'true'}">${collapsed ? 'Show' : 'Hide'}</button>` : ''}
  </header>
  <div class="column-body">${cards || (collapsed ? '' : '<p class="muted small empty-column">Empty</p>')}${!collapsed && more > 0 ? `<button type="button" class="btn small" data-action="column-page" data-column="${attr(status)}" data-page="${page + 1}">Show ${more > BOARD_PAGE_SIZE ? BOARD_PAGE_SIZE : more} more</button>` : ''}</div>
</section>`;
  }).join('');
  return `<section class="view view-board" aria-labelledby="tab-board" data-layout="${attr(layout)}">
<p class="section-count">${esc(tickets.length)} ticket${tickets.length === 1 ? '' : 's'}${staleCount ? ` · <button type="button" class="link" data-action="toggle-stale" aria-pressed="${filters.stale ? 'true' : 'false'}">${esc(staleCount)} stale</button>` : ''}</p>
<div class="board">${columns}</div></section>`;
}
