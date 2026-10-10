// Tickets whose status no longer matches what happened: work that shipped while the ticket stayed
// open, parents whose children all finished, and open tickets nobody has touched in days. The
// first two have a safe, mechanical answer (done); idle tickets need the owner's judgment.
import { ageMs, DAY } from '../lib/time.js';

export const IDLE_DAYS = 5;
const OPEN = new Set(['todo', 'active', 'review', 'deploy-pending', 'blocked']);

function shipped(ticket) {
  const prs = ticket.prs ?? [];
  if (!prs.length) return null;
  if (prs.some((p) => p.state === 'open' || p.state === 'draft' || p.state === 'unknown')) return null;
  const merged = prs.filter((p) => p.state === 'merged');
  if (!merged.length) return null;
  if ((ticket.deployments ?? []).some((d) => d.state === 'pending')) return null;
  return `${merged.length === 1 ? 'its PR is' : `all ${merged.length} PRs are`} merged and nothing is waiting for deployment`;
}

function childrenDone(ticket, byParent) {
  const kids = byParent.get(ticket.id) ?? [];
  if (!kids.length || kids.some((k) => k.status !== 'done')) return null;
  return `all ${kids.length} child ticket${kids.length === 1 ? ' is' : 's are'} done`;
}

// Suggestions in a stable order: closable first (oldest activity first), then idle.
export function cleanupSuggestions(tickets, { nowIso, idleDays = IDLE_DAYS } = {}) {
  const byParent = new Map();
  for (const t of tickets) if (t.parent_id) { if (!byParent.has(t.parent_id)) byParent.set(t.parent_id, []); byParent.get(t.parent_id).push(t); }
  const out = [];
  for (const t of tickets) {
    if (!OPEN.has(t.status)) continue;
    const idle = t.last_activity ? Math.floor(ageMs(t.last_activity, nowIso) / DAY) : null;
    const reason = shipped(t) ?? childrenDone(t, byParent);
    if (reason) {
      out.push({ kind: shipped(t) ? 'shipped' : 'children-done', ticket_id: t.id, key: t.key, title: t.title, status: t.status, idle_days: idle, reason, suggested_status: 'done', closable: true });
    } else if (idle !== null && idle >= idleDays && t.status !== 'blocked') {
      out.push({ kind: 'idle', ticket_id: t.id, key: t.key, title: t.title, status: t.status, idle_days: idle, reason: `no activity for ${idle} days`, suggested_status: null, closable: false });
    }
  }
  const rank = { shipped: 0, 'children-done': 1, idle: 2 };
  return out.sort((a, b) => (rank[a.kind] - rank[b.kind]) || ((b.idle_days ?? 0) - (a.idle_days ?? 0)) || (a.key < b.key ? -1 : 1));
}
