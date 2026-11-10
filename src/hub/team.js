// The team view over every stored board (ADR 0044): one row per board, the open work of all of
// them, and the deployments merged pull requests still owe. Built from stored, sanitized snapshots.
import { ageMs } from '../lib/time.js';

export const STATUSES = Object.freeze(['todo', 'active', 'blocked', 'review', 'deploy-pending', 'done']);
// A board whose owner's worker has not pushed for this long is marked, never hidden.
export const QUIET_AFTER_MS = 24 * 3_600_000;
export const MAX_OPEN_ROWS = 500;

const text = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function boardRow(name, storeId, info, snapshot, now) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of snapshot.tickets) if (Object.hasOwn(counts, t.status)) counts[t.status] += 1;
  const age = Math.max(0, ageMs(info.pushed_at, now));
  return {
    member: name,
    store_id: storeId,
    store_name: text(snapshot.meta && snapshot.meta.store_name, 80) || null,
    machine_name: text(info.machine_name, 80) || null,
    pushed_at: info.pushed_at,
    age_ms: age,
    quiet: age > QUIET_AFTER_MS,
    generation_id: text(info.generation_id, 100),
    ticket_count: snapshot.tickets.length,
    stale_ticket_count: snapshot.tickets.filter((t) => t.stale === true).length,
    counts_by_status: counts,
  };
}

/** `boards` is a list of { name, store_id, info, snapshot }; `now` an ISO time. */
export function teamOverview(boards, now) {
  const rows = [];
  const open = [];
  const deployments = [];
  for (const b of boards) {
    rows.push(boardRow(b.name, b.store_id, b.info, b.snapshot, now));
    const byId = new Map(b.snapshot.tickets.map((t) => [t.id, t]));
    for (const t of b.snapshot.tickets) {
      if (t.status === 'done') continue;
      open.push({
        member: b.name, store_id: b.store_id, key: text(t.key, 200), title: text(t.title), status: STATUSES.includes(t.status) ? t.status : 'todo',
        priority: text(t.priority, 10) || null, project_name: text(t.project_name, 80) || null, next_action: text(t.next_action), blocker: text(t.blocker),
        last_activity: time(t.last_activity), stale: t.stale === true,
      });
    }
    for (const d of b.snapshot.deployments_outstanding ?? []) {
      const t = byId.get(d.ticket_id);
      deployments.push({ member: b.name, store_id: b.store_id, ticket_key: text(d.ticket_key ?? (t && t.key), 200), title: text(t && t.title), environment: text(d.environment, 80), merged_at: time(d.merged_at) });
    }
  }
  rows.sort((a, b) => a.member.localeCompare(b.member) || a.store_id.localeCompare(b.store_id));
  // Newest activity first; a ticket nobody touched yet sorts last.
  open.sort((a, b) => (b.last_activity ?? '').localeCompare(a.last_activity ?? '') || a.key.localeCompare(b.key));
  // Oldest merge first: the deployment owed longest leads.
  deployments.sort((a, b) => (a.merged_at ?? '9').localeCompare(b.merged_at ?? '9') || a.ticket_key.localeCompare(b.ticket_key));
  const totals = Object.fromEntries(STATUSES.map((s) => [s, rows.reduce((n, r) => n + r.counts_by_status[s], 0)]));
  return { generated_at: now, boards: rows, totals, open_count: open.length, open: open.slice(0, MAX_OPEN_ROWS), deployments };
}
