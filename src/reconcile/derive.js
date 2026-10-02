import { applyLifecycle } from './lifecycle.js';
import { rankPickNext, blockedList } from './picknext.js';
import { buildToday } from '../today/feed.js';

// Derived projections computed at publish time: lifecycle flags, pick-next, blocked list and
// outstanding deployment obligations (oldest first).
export function derive(state, nowIso) {
  const life = applyLifecycle(state, nowIso);
  const tickets = [...state.tickets.values()];
  const outstanding = [];
  for (const t of tickets) {
    for (const d of t.deployments) {
      if (d.state !== 'pending') continue;
      const pr = t.prs.find((p) => p.id === d.pr_id);
      outstanding.push({ ticket_id: t.id, ticket_key: t.key, ticket_status: t.status, pr_id: d.pr_id, pr_url: pr ? pr.url : null, environment: d.environment, merged_at: d.merged_at, deployment_id: d.id });
    }
  }
  outstanding.sort((a, b) => (a.merged_at < b.merged_at ? -1 : a.merged_at > b.merged_at ? 1 : a.ticket_key < b.ticket_key ? -1 : 1));
  return {
    picknext: rankPickNext(tickets, { nowIso, timezone: state.meta.timezone }),
    blocked: blockedList(tickets),
    deployments_outstanding: outstanding,
    today: buildToday(state, { nowIso }),
    notify: life.notify,
    lifecycle_changed: life,
  };
}
