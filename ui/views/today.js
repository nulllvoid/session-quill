// Today (ADR 0009): what happened each day of the last week, grouped by ticket. The digest job
// writes the same feed into the daily note.
import { esc, attr, keyEl, statusChip, timeEl, ticketById, matchesFilters, emptyState, normalizeSnapshot, openProposals, proposalItem } from '../components.js';

const LABELS = { commit: ['commit', 'commits'], pr: ['PR', 'PRs'], deployment: ['deployment', 'deployments'], status: ['status change', 'status changes'], write: ['file write', 'file writes'], plan: ['plan', 'plans'], conclusion: ['conclusion', 'conclusions'], handoff: ['agent run', 'agent runs'], comment: ['page comment', 'page comments'], proposal: ['proposed run', 'proposed runs'], bind: ['binding', 'bindings'] };
const KIND_TEXT = { commit: 'Commit', pr: 'PR', deployment: 'Deployment', status: 'Status', write: 'Write', plan: 'Plan', conclusion: 'Conclusion', handoff: 'Agent', comment: 'Comment', proposal: 'Proposed', bind: 'Bound' };

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

// Runs proposed from a shared page (ADR 0025) wait here for the owner, above the days.
function proposalsSection(snapshot, filters, { now, pending }) {
  const list = openProposals(snapshot).filter((p) => { const t = ticketById(snapshot, p.ticket_id); return !t || matchesFilters(t, filters, snapshot); });
  if (!list.length) return '';
  return `<section class="proposals" aria-labelledby="proposals-title"><div class="section-head"><h2 id="proposals-title">Proposed runs</h2><span class="section-count">${esc(list.length)} waiting for you</span></div>
  <p class="small muted">Picked with Run agent on a shared page. Nothing runs until you approve; an approved run leaves suggestions for you to accept.</p>
  <ul class="proposal-list">${list.map((p) => proposalItem(p, snapshot, { now, pending, withTicket: true })).join('')}</ul></section>`;
}

export function renderToday(rawSnapshot, filters, { now, pending = [] }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  const proposals = proposalsSection(snapshot, filters, { now, pending });
  if (!snapshot.today) {
    return `<section class="view view-today" aria-labelledby="tab-today">${proposals}${emptyState(snapshot.meta.exported_at ? 'Today is not included in exports' : 'Today is loading', snapshot.meta.exported_at ? 'An export is a snapshot of tickets; the daily feed stays on the owner\'s dashboard.' : 'The worker builds this feed with each update.')}</section>`;
  }
  const days = snapshot.today.days.map((d) => ({ ...d, tickets: d.tickets.filter((t) => { const ticket = ticketById(snapshot, t.ticket_id); return !ticket || matchesFilters(ticket, filters, snapshot); }) })).filter((d) => d.tickets.length || d.sessions);
  if (!days.length) return `<section class="view view-today" aria-labelledby="tab-today">${proposals}${emptyState('Nothing tracked in the last 7 days', 'Sessions, commits, PRs, deployments and status changes appear here day by day, grouped by ticket.')}</section>`;
  const html = days.map((d) => `<section class="today-day" aria-labelledby="day-${attr(d.date)}">
  <div class="section-head"><h2 id="day-${attr(d.date)}">${esc(dayLabel(d.date, snapshot.today.generated_for))}</h2><span class="section-count">${esc(d.date)} · ${esc(d.tickets.length)} ticket${d.tickets.length === 1 ? '' : 's'}${d.sessions ? ` · ${esc(d.sessions)} session${d.sessions === 1 ? '' : 's'}` : ''}</span></div>
  <ul class="today-tickets">${d.tickets.map((t) => `<li class="today-ticket"><div class="today-head"><button type="button" class="link" data-open="${attr(t.ticket_id)}">${keyEl(t.key)} ${esc(t.title)}</button> ${statusChip(t.status)} <span class="small muted">${esc(countsText(t.counts))}</span></div>
    <ul class="today-items">${t.items.map((i) => `<li><span class="tl-kind">${esc(KIND_TEXT[i.kind] ?? i.kind)}</span> ${timeEl(i.at, now, tz)} <span class="tl-text">${esc(i.text)}</span></li>`).join('')}</ul></li>`).join('')}</ul>
</section>`).join('');
  return `<section class="view view-today" aria-labelledby="tab-today">${proposals}${html}</section>`;
}
