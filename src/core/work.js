// Owner Work summaries, derived from the same closure policy as reconciliation.
import { assessClosure, closureContext, reconciliationItems } from './closure.js';
import { requiredCompleted } from './hierarchy.js';

export function buildWorkRollups(state, { nowIso, context = closureContext(state, nowIso), reviewItems = reconciliationItems(state, nowIso, { includeAcknowledged: true, context }) } = {}) {
  const rows = new Map();
  const reviews = new Map(reviewItems.map(x => [x.ticket_id, x]));
  const proposals = new Map();
  for (const p of state.runProposals?.values() ?? []) if (p.state === 'proposed') proposals.set(p.ticket_id, (proposals.get(p.ticket_id) ?? 0) + 1);
  for (const id of [...context.order, ...context.cycles]) {
    const t = context.byId.get(id), children = context.byParent.get(id) ?? [];
    const required = children.filter(c => c.blocks_parent === true);
    const completed = required.filter(c => requiredCompleted(c, context.conflicts)).length;
    const assessment = assessClosure(t, context), conflicts = context.conflicts.get(id) ?? [];
    const runs = context.runsByTicket.get(id) ?? [];
    const active = runs.filter(h => ['queued', 'running'].includes(h.state)).length;
    // Match Runs attention: starting a retry is not a resolution; completed tickets are quiet.
    const failed = t.status === 'done' ? 0 : runs.filter(h => {
      if (!['failed', 'timed-out'].includes(h.state) || !h.intent && Date.parse(nowIso) - Date.parse(h.finished_at ?? h.requested_at) > 7 * 86400000) return false;
      return !runs.some(x => x.id !== h.id && x.origin !== 'ci' && x.requested_at > h.requested_at && ['done', 'failed', 'timed-out'].includes(x.state));
    }).length;
    const reasons = [...conflicts];
    for (const text of assessment.blockers) if (!reasons.some(r => r.text === text)) reasons.push({ code: 'closure-blocked', text, ticket_id: id });
    const review = reviews.get(id);
    rows.set(id, {
      required_total: required.length, completed, remaining: required.length - completed,
      resolved_without_delivery: required.filter(c => c.status === 'done' && c.resolution && c.resolution.kind !== 'completed').length,
      independent: children.filter(c => c.blocks_parent === false).length,
      unclassified: children.filter(c => c.blocks_parent == null).length,
      pending_descendants: required.reduce((n, c) => n + (requiredCompleted(c, context.conflicts) ? 0 : 1) + (context.cycles.has(id) ? 0 : rows.get(c.id)?.pending_descendants ?? 0), 0),
      closure_state: conflicts.length ? 'needs-review' : t.status === 'done' ? 'closed' : assessment.closable ? 'ready' : 'not-ready',
      reasons: t.status === 'done' && !conflicts.length ? [] : reasons,
      evidence_version: review?.evidence_version ?? null,
      active_run_count: active,
      attention_count: (conflicts.length ? 1 : 0) + (t.status === 'blocked' ? 1 : 0) + failed + (proposals.get(id) ?? 0),
    });
  }
  return rows;
}
