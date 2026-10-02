// Deterministic pick-next ranking (TRD §Pick-next).
import { isoDateInZone, dateDiffDays, ageMs, DAY } from '../lib/time.js';

export const ELIGIBLE = new Set(['todo', 'active', 'review', 'deploy-pending']);
const PRIORITY_POINTS = { P0: 40, P1: 25, P2: 10, P3: 0 };
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function scoreTicket(ticket, { nowIso, timezone, byId }) {
  const reasons = [];
  const limitations = [];
  let raw = 0;
  const pr = PRIORITY_POINTS[ticket.priority] ?? 0;
  if (pr) { raw += pr; reasons.push(`Priority ${ticket.priority}: +${pr}`); }

  if (ticket.due) {
    const today = isoDateInZone(nowIso, timezone);
    const diff = dateDiffDays(ticket.due, today);
    if (diff < 0) { raw += 30; reasons.push(`Due overdue: +30 (${-diff} day(s) late)`); }
    else if (diff <= 3) { raw += 30; reasons.push(`Due within 3 days: +30 (${ticket.due})`); }
    else if (diff <= 7) { raw += 15; reasons.push(`Due within 7 days: +15 (${ticket.due})`); }
  }

  const pendingMerged = (ticket.deployments ?? []).filter((d) => d.state === 'pending' && d.merged_at);
  if (pendingMerged.length) {
    const oldest = pendingMerged.reduce((m, d) => (d.merged_at < m ? d.merged_at : m), pendingMerged[0].merged_at);
    if (ageMs(oldest, nowIso) >= 2 * DAY) { raw += 20; reasons.push(`Merged PR awaiting deployment for ${Math.floor(ageMs(oldest, nowIso) / DAY)} day(s): +20`); }
  }
  const openPrs = (ticket.prs ?? []).filter((p) => p.state === 'open' || p.state === 'draft');
  if (ticket.status === 'review' && openPrs.length) {
    const dated = openPrs.filter((p) => p.opened_at);
    if (dated.length) {
      const oldest = dated.reduce((m, p) => (p.opened_at < m ? p.opened_at : m), dated[0].opened_at);
      if (ageMs(oldest, nowIso) >= DAY) { raw += 15; reasons.push(`Open PR in review for ${Math.floor(ageMs(oldest, nowIso) / DAY)} day(s): +15`); }
    } else {
      limitations.push('Open PR age unknown: provider evidence missing, no age points awarded');
    }
  }
  if ((ticket.prs ?? []).some((p) => p.state === 'unknown')) limitations.push('PR state unknown: provider evidence unavailable');

  if (ticket.next_action && String(ticket.next_action).trim()) { raw += 10; reasons.push('Has next action: +10'); }

  if (ticket.parent_id) {
    const parent = byId.get(ticket.parent_id);
    const doneSiblings = parent ? (parent.children_done_count ?? 0) - (ticket.status === 'done' ? 1 : 0) : 0;
    if (doneSiblings > 0) { raw += 10; reasons.push('Parent has another child done: +10'); }
  }
  if (ticket.stale) { raw += 10; reasons.push('Stale (no activity for 5+ days): +10'); }

  return { ticket_id: ticket.id, raw_score: raw, score: Math.min(100, raw), reasons, limitations };
}

export function rankPickNext(tickets, { nowIso, timezone, limit = 5 }) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const scored = tickets.filter((t) => ELIGIBLE.has(t.status)).map((t) => ({ ...scoreTicket(t, { nowIso, timezone, byId }), _t: t }));
  scored.sort((a, b) => {
    if (a.raw_score !== b.raw_score) return b.raw_score - a.raw_score;
    const da = a._t.due ?? '9999-99-99';
    const db = b._t.due ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    const pa = PRIORITY_ORDER[a._t.priority] ?? 9;
    const pb = PRIORITY_ORDER[b._t.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    if (a._t.last_activity !== b._t.last_activity) return a._t.last_activity < b._t.last_activity ? -1 : 1;
    return a.ticket_id < b.ticket_id ? -1 : a.ticket_id > b.ticket_id ? 1 : 0;
  });
  return scored.slice(0, limit).map(({ _t, ...entry }, i) => ({ rank: i + 1, ...entry }));
}

export function blockedList(tickets) {
  return tickets.filter((t) => t.status === 'blocked').sort((a, b) => (a.key < b.key ? -1 : 1)).map((t) => ({ ticket_id: t.id, blocker: t.blocker }));
}
