import { normalizeSnapshot, matchesFilters } from '../components.js';
import { needsYou, workAttentionItems } from './runs.js';

export const WORK_LENSES = { open: 'Open', suggested: 'Suggested next', attention: 'Needs attention', completed: 'Completed', all: 'All' };
const compareValue = (a, b) => String(a || '\uffff').localeCompare(String(b || '\uffff'));
export function workSort(sort = 'priority') {
  return (a, b) => (sort === 'title' ? compareValue(a.title, b.title) : sort === 'activity' ? compareValue(a.last_activity, b.last_activity) : compareValue(a.priority, b.priority)) || compareValue(a.due, b.due) || compareValue(a.last_activity, b.last_activity) || a.id.localeCompare(b.id);
}
export function buildWorkTree(raw, filters = {}, { lens = 'open', sort = 'priority', root = null, now = new Date().toISOString() } = {}) {
  const snapshot = normalizeSnapshot(raw), byId = new Map(snapshot.tickets.map(t => [t.id, t]));
  const parents = new Map(), children = new Map(), invalid = new Set();
  for (const t of snapshot.tickets) {
    if (t.parent_id && !byId.has(t.parent_id)) invalid.add(t.id);
    parents.set(t.id, byId.has(t.parent_id) ? t.parent_id : null);
  }
  const visited = new Set();
  for (const t of snapshot.tickets) {
    const path = new Set(); let id = t.id;
    while (id && !visited.has(id)) {
      if (path.has(id)) { invalid.add(id); parents.set(id, null); break; }
      path.add(id); id = parents.get(id);
    }
    for (const item of path) visited.add(item);
  }
  for (const t of snapshot.tickets) { const p = parents.get(t.id); if (!children.has(p)) children.set(p, []); children.get(p).push(t); }
  const active = new Set(snapshot.handoffs.filter(h => ['running', 'queued'].includes(h.state)).map(h => h.ticket_id));
  const attention = new Set(snapshot.handoffs.filter(h => needsYou(snapshot, h, now)).map(h => h.ticket_id));
  for (const t of snapshot.tickets) if (t.status === 'blocked' || t.work_rollup?.closure_state === 'needs-review' || invalid.has(t.id) || t.repo_state === 'needs-clone' || (children.get(t.id) || []).some(c => c.blocks_parent == null)) attention.add(t.id);
  for (const item of workAttentionItems(snapshot)) attention.add(item.ticket.id);
  for (const item of snapshot.reconciliation?.items || []) attention.add(item.ticket_id);
  for (const p of snapshot.run_proposals || []) if (p.state === 'proposed') attention.add(p.ticket_id);
  const ranking = new Map(snapshot.picknext.map((e, i) => [e.ticket_id, { ...e, index: i }]));
  const any = (value, candidate) => !value || String(value).split(',').includes(candidate);
  const matches = new Set(snapshot.tickets.filter(t => matchesFilters(t, filters, snapshot)
    && any(filters.status, t.status) && any(filters.priority, t.priority)
    && (!filters.attention || attention.has(t.id)) && (!filters.active_run || active.has(t.id))
    && (!filters.blocked || t.status === 'blocked') && (!filters.ready || t.work_rollup?.closure_state === 'ready')
    && (!filters.unresolved || invalid.has(t.id) || t.repo_state === 'needs-clone')
    && (lens === 'all' || lens === 'completed' && t.status === 'done' || lens === 'suggested' && ranking.has(t.id) || lens === 'attention' && attention.has(t.id) || lens === 'open' && (t.status !== 'done' || attention.has(t.id)))) .map(t => t.id));
  if (root && byId.has(root)) { const allowed = new Set(), queue = [root]; while (queue.length) { const id = queue.pop(); allowed.add(id); for (const c of children.get(id) || []) queue.push(c.id); } for (const id of matches) if (!allowed.has(id)) matches.delete(id); }
  const visible = new Set(matches), context = new Set(), groupRank = new Map();
  for (const id of matches) { let p = parents.get(id); const rank = ranking.get(id)?.index ?? Infinity; groupRank.set(id, Math.min(groupRank.get(id) ?? Infinity, rank)); while (p) { visible.add(p); if (!matches.has(p)) context.add(p); groupRank.set(p, Math.min(groupRank.get(p) ?? Infinity, rank)); p = parents.get(p); } }
  const compare = workSort(sort);
  for (const list of children.values()) list.sort(lens === 'suggested' ? (a, b) => (groupRank.get(a.id) ?? Infinity) - (groupRank.get(b.id) ?? Infinity) || compare(a, b) : compare);
  const roots = (root && byId.has(root) ? [byId.get(root)] : children.get(null) || []).filter(t => visible.has(t.id));
  const filtered = Object.values(filters).some(Boolean) || !['open', 'all'].includes(lens);
  return { snapshot, byId, parents, children, roots, matches, visible, context, invalid, active, attention, ranking, filtered };
}

export function completionText(t, shared = false) {
  const r = t.work_rollup;
  if (!r) return shared ? 'Shared tasks only · completion not assessed' : 'Completion not assessed';
  const n = r.required_completed ?? r.completed ?? 0;
  return `${r.required_total ? `${n} of ${r.required_total} required subtasks completed` : 'No required subtasks'}${shared ? ' · shared tasks only' : ''}`;
}
