// Today (ADR 0009): what happened each day of the last week, grouped by ticket. The digest job
// writes the same feed into the daily note.
import { esc, attr, keyEl, statusChip, timeEl, ticketById, matchesFilters, emptyState, normalizeSnapshot } from '../components.js';

const LABELS = { commit: ['commit', 'commits'], pr: ['PR', 'PRs'], deployment: ['deployment', 'deployments'], status: ['status change', 'status changes'], write: ['file write', 'file writes'], plan: ['plan', 'plans'], conclusion: ['conclusion', 'conclusions'], handoff: ['agent run', 'agent runs'], bind: ['binding', 'bindings'] };
const KIND_TEXT = { commit: 'Commit', pr: 'PR', deployment: 'Deployment', status: 'Status', write: 'Write', plan: 'Plan', conclusion: 'Conclusion', handoff: 'Agent', bind: 'Bound' };

function previousDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function dayLabel(date, today) {
  if (date === today) return 'Today';
  if (date === previousDate(today)) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

export function countsText(counts = {}) {
  return Object.keys(LABELS).filter((k) => counts[k]).map((k) => `${counts[k]} ${LABELS[k][counts[k] === 1 ? 0 : 1]}`).join(' · ');
}

export function renderToday(rawSnapshot, filters, { now }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  if (!snapshot.today) {
    return `<section class="view view-today" aria-labelledby="tab-today">${emptyState(snapshot.meta.exported_at ? 'Today is not included in exports' : 'Today is loading', snapshot.meta.exported_at ? 'An export is a snapshot of tickets; the daily feed stays on the owner\'s dashboard.' : 'The worker builds this feed with each update.')}</section>`;
  }
  const days = snapshot.today.days.map((d) => ({ ...d, tickets: d.tickets.filter((t) => { const ticket = ticketById(snapshot, t.ticket_id); return !ticket || matchesFilters(ticket, filters, snapshot); }) })).filter((d) => d.tickets.length || d.sessions);
  if (!days.length) return `<section class="view view-today" aria-labelledby="tab-today">${emptyState('Nothing tracked in the last 7 days', 'Sessions, commits, PRs, deployments and status changes appear here day by day, grouped by ticket.')}</section>`;
  const html = days.map((d) => `<section class="today-day" aria-labelledby="day-${attr(d.date)}">
  <div class="section-head"><h2 id="day-${attr(d.date)}">${esc(dayLabel(d.date, snapshot.today.generated_for))}</h2><span class="section-count">${esc(d.date)} · ${esc(d.tickets.length)} ticket${d.tickets.length === 1 ? '' : 's'}${d.sessions ? ` · ${esc(d.sessions)} session${d.sessions === 1 ? '' : 's'}` : ''}</span></div>
  <ul class="today-tickets">${d.tickets.map((t) => `<li class="today-ticket"><div class="today-head"><button type="button" class="link" data-open="${attr(t.ticket_id)}">${keyEl(t.key)} ${esc(t.title)}</button> ${statusChip(t.status)} <span class="small muted">${esc(countsText(t.counts))}</span></div>
    <ul class="today-items">${t.items.map((i) => `<li><span class="tl-kind">${esc(KIND_TEXT[i.kind] ?? i.kind)}</span> ${timeEl(i.at, now, tz)} <span class="tl-text">${esc(i.text)}</span></li>`).join('')}</ul></li>`).join('')}</ul>
</section>`).join('');
  return `<section class="view view-today" aria-labelledby="tab-today">${html}</section>`;
}
