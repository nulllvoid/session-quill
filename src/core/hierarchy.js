// One indexed, iterative traversal keeps deep or malformed imported trees safe.
export function completionIndex(tickets, handoffs = []) {
  const byId = new Map(tickets.map(t => [t.id, t])), byParent = new Map(), runsByTicket = new Map();
  for (const t of tickets) if (t.parent_id) {
    if (!byParent.has(t.parent_id)) byParent.set(t.parent_id, []);
    byParent.get(t.parent_id).push(t);
  }
  for (const h of handoffs) {
    if (!runsByTicket.has(h.ticket_id)) runsByTicket.set(h.ticket_id, []);
    runsByTicket.get(h.ticket_id).push(h);
  }
  const pending = new Map(tickets.map(t => [t.id, (byParent.get(t.id) ?? []).length]));
  const order = tickets.filter(t => pending.get(t.id) === 0).map(t => t.id);
  for (let i = 0; i < order.length; i++) {
    const parent = byId.get(order[i])?.parent_id;
    if (!pending.has(parent)) continue;
    pending.set(parent, pending.get(parent) - 1);
    if (pending.get(parent) === 0) order.push(parent);
  }
  const cycles = new Set(tickets.filter(t => pending.get(t.id) > 0).map(t => t.id));
  const conflicts = new Map();
  const add = (id, code, text, source = id) => {
    if (!conflicts.has(id)) conflicts.set(id, []);
    conflicts.get(id).push({ code, text, ticket_id: source });
  };
  for (const t of tickets) {
    const children = byParent.get(t.id) ?? [];
    if (cycles.has(t.id)) add(t.id, 'parent-cycle', 'Parent links contain a cycle');
    if (t.parent_id && !byId.has(t.parent_id)) add(t.id, 'parent-missing', 'The parent task is unavailable');
    if (children.some(c => c.blocks_parent == null)) add(t.id, 'relationship-unclassified', 'Choose whether legacy children are required or independent');
    for (const c of children) {
      if (c.blocks_parent !== true) continue;
      if (c.status === 'done' && c.resolution && c.resolution.kind !== 'completed') add(t.id, 'required-not-delivered', 'Required child work was resolved without delivery', c.id);
      else if (t.status === 'done' && c.status !== 'done') add(t.id, 'required-reopened', 'Required child work reopened after completion', c.id);
    }
    if (t.status === 'done') {
      const runs = runsByTicket.get(t.id) ?? [];
      if (runs.some(h => ['queued', 'running'].includes(h.state))) add(t.id, 'completed-run-active', 'Completed work has an active agent run');
      if (runs.some(h => h.uncertain_effects?.length)) add(t.id, 'completed-effects-unresolved', 'Completed work has unresolved agent effects');
      if ((t.deployments ?? []).some(d => !['deployed', 'waived'].includes(d.state))) add(t.id, 'completed-deployment-pending', 'Completed work still requires deployment');
    }
    if ((runsByTicket.get(t.id) ?? []).some(h => h.pr_observed?.reverted_by)) add(t.id, 'delivery-reverted', 'Delivered work was reverted; owner review is required');
  }
  for (const id of order) {
    const t = byId.get(id);
    if (t.blocks_parent === true && byId.has(t.parent_id) && conflicts.has(id)) add(t.parent_id, 'required-child-conflict', 'Required child work has a completion conflict', id);
  }
  return { byId, byParent, runsByTicket, order, cycles, conflicts };
}

export function requiredCompleted(ticket, conflicts) {
  return ticket.status === 'done' && (!ticket.resolution || ticket.resolution.kind === 'completed') && !conflicts.has(ticket.id);
}
