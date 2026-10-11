import { esc, attr, icon, ticketCard, filterTickets, STATUS_ORDER, STATUS_LABELS, emptyState, normalizeSnapshot } from '../components.js';
import { canSelect, renderSelectToggle, selectableCard } from './bulk.js';

export const BOARD_PAGE_SIZE = 40;

// Done starts collapsed and every other column open; `toggled` holds the columns flipped from that.
export function columnCollapsed(status, toggled) {
  return (status === 'done') !== toggled.has(status);
}

export function renderBoard(rawSnapshot, filters, { now, layout = 'columns', toggled = new Set(), pages = {}, selected = null, selecting = false, checked = new Set() }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tickets = filterTickets(snapshot, filters);
  if (!tickets.length) {
    const any = snapshot.tickets.length;
    return `<section class="view view-board" aria-labelledby="tab-board">${any ? emptyState('No tickets match the current filters', 'Clear a filter token above to see more.') : emptyState('No tickets yet', `Mention a ticket key such as <code>${esc(snapshot.meta.key_example ?? 'PROJ-123')}</code> in a Claude Code prompt to create the first one, or run <code>/session-quill:ticket create "&lt;title&gt;"</code>.`)}</section>`;
  }
  const staleCount = tickets.filter((t) => t.stale).length;
  // Same definition as the sidebar badge: open means not done.
  const done = tickets.filter((t) => t.status === 'done').length;
  const open = tickets.length - done;
  const columns = STATUS_ORDER.map((status) => {
    const all = tickets.filter((t) => t.status === status).sort((a, b) => (a.last_activity < b.last_activity ? 1 : -1));
    const collapsed = columnCollapsed(status, toggled);
    const page = pages[status] ?? 0;
    const shown = all.slice(0, (page + 1) * BOARD_PAGE_SIZE);
    const more = all.length - shown.length;
    const card = (t) => ticketCard(t, snapshot, { variant: 'board', now, selected: selected === t.id });
    const cards = collapsed ? '' : shown.map((t) => (selecting ? selectableCard(card(t), t, { checked: checked.has(t.id) }) : card(t))).join('');
    return `<section class="column" data-column="${attr(status)}" data-collapsed="${collapsed ? 'true' : 'false'}" aria-labelledby="col-${attr(status)}">
  <header class="column-head">
    <h3 id="col-${attr(status)}">${esc(STATUS_LABELS[status])} <span class="count" aria-label="${esc(all.length)} ticket${all.length === 1 ? '' : 's'}">${esc(all.length)}</span></h3>
    <button type="button" class="btn small ghost${collapsed ? '' : ' icon-only'}" data-action="toggle-column" data-column="${attr(status)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${attr(`${collapsed ? 'Show' : 'Hide'} ${STATUS_LABELS[status]}`)}" title="${attr(`${collapsed ? 'Show' : 'Hide'} ${STATUS_LABELS[status]}`)}">${collapsed ? 'Show' : icon('x')}</button>
  </header>
  <div class="column-body">${cards || (collapsed ? '' : '<p class="muted small empty-column">Empty</p>')}${!collapsed && more > 0 ? `<button type="button" class="btn small" data-action="column-page" data-column="${attr(status)}" data-page="${page + 1}">Show ${more > BOARD_PAGE_SIZE ? BOARD_PAGE_SIZE : more} more</button>` : ''}</div>
</section>`;
  }).join('');
  return `<section class="view view-board" aria-labelledby="tab-board" data-layout="${attr(layout)}">
${canSelect(snapshot) ? renderSelectToggle({ selecting, count: checked.size }) : ''}
<p class="section-count">${esc(open)} open ticket${open === 1 ? '' : 's'}${done ? ` · ${esc(done)} done` : ''}${staleCount ? ` · <button type="button" class="link" data-action="toggle-stale" aria-pressed="${filters.stale ? 'true' : 'false'}">${esc(staleCount)} stale</button>` : ''}</p>
<div class="board">${columns}</div></section>`;
}
