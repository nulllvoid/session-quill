import { esc, attr, keyEl, statusChip, filterTickets, emptyState, icon, normalizeSnapshot } from '../components.js';

export const TREE_MAX_DEPTH = 3;

function treeNode(ticket, byParent, depth, snapshot) {
  const children = (byParent.get(ticket.id) ?? []).sort((a, b) => (a.key < b.key ? -1 : 1));
  const done = children.filter((c) => c.status === 'done').length;
  const childHtml = depth < TREE_MAX_DEPTH
    ? children.map((c) => treeNode(c, byParent, depth + 1, snapshot)).join('')
    : (children.length ? `<li class="tree-more"><button type="button" class="btn small" data-action="tree-root" data-root="${attr(ticket.id)}">${icon('chevron')}View children (${esc(children.length)})</button></li>` : '');
  const issues = (ticket.validation_issues ?? []).filter((i) => i.startsWith('parent'));
  return `<li class="tree-node" data-depth="${depth}">
  <div class="tree-row"><button type="button" class="link tree-open" data-open="${attr(ticket.id)}">${keyEl(ticket.key)} ${esc(ticket.title)}</button> ${statusChip(ticket.status, { stale: ticket.stale })}${children.length ? ` <span class="muted small">${esc(done)}/${esc(children.length)} children done</span>` : ''}${issues.length ? ` <span class="chip warning">${icon('alert')}Unresolved parent link</span>` : ''}</div>
  ${childHtml ? `<ul class="tree-children">${childHtml}</ul>` : ''}
</li>`;
}

export function renderTree(rawSnapshot, filters, { root = null }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const visible = new Set(filterTickets(snapshot, filters).map((t) => t.id));
  const all = snapshot.tickets;
  const byId = new Map(all.map((t) => [t.id, t]));
  const byParent = new Map();
  for (const t of all) {
    if (!t.parent_id) continue;
    if (!byParent.has(t.parent_id)) byParent.set(t.parent_id, []);
    byParent.get(t.parent_id).push(t);
  }
  if (!all.length) return `<section class="view view-tree" aria-labelledby="tab-tree">${emptyState('No tickets yet', 'Parents and children appear here. Children are created with <code>/session-quill:ticket create "&lt;title&gt;" --parent KEY</code> or by a handoff with follow-ups.')}</section>`;
  let roots;
  let crumbs = '';
  if (root && byId.has(root)) {
    roots = [byId.get(root)];
    const chain = [];
    let cursor = byId.get(root);
    while (cursor) { chain.unshift(cursor); cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null; }
    crumbs = `<nav class="breadcrumb" aria-label="Tree position"><button type="button" class="link" data-action="tree-root" data-root="">All</button>${chain.map((c) => ` <span aria-hidden="true">/</span> <button type="button" class="link" data-action="tree-root" data-root="${attr(c.id)}">${esc(c.key)}</button>`).join('')}</nav>`;
  } else {
    roots = all.filter((t) => (!t.parent_id || !byId.has(t.parent_id)) && (visible.has(t.id) || (byParent.get(t.id) ?? []).some((c) => visible.has(c.id))));
    roots.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  const orphans = all.filter((t) => t.parent_id && !byId.has(t.parent_id));
  for (const o of orphans) if (!o.validation_issues.includes('parent-missing')) o.validation_issues = [...o.validation_issues, 'parent-missing'];
  const list = roots.map((r) => treeNode(r, byParent, root ? Math.max(0, 0) : 0, snapshot)).join('');
  return `<section class="view view-tree" aria-labelledby="tab-tree">${crumbs}<p class="section-count">${esc(roots.length)} root${roots.length === 1 ? '' : 's'}${orphans.length ? ` · ${esc(orphans.length)} with an unresolved parent link` : ''}</p><ul class="tree" role="tree">${list || '<li class="muted">No matching tickets</li>'}</ul><p class="muted small">Tree is read-only here. Create children from the CLI or through a handoff with follow-ups.</p></section>`;
}
