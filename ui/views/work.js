import { esc, attr, icon, STATUS_ORDER, STATUS_LABELS, requestFeedback } from '../components.js';
import { buildWorkTree, completionText, WORK_LENSES } from '../lib/work.js';

export function renderWork(raw, filters = {}, opts = {}) {
  const tree = buildWorkTree(raw, filters, opts), { snapshot: s } = tree;
  const expanded = opts.expanded || new Set(), checked = opts.checked || new Set(), revealed = opts.revealed || new Set();
  const editable = !s.meta.exported_at && s.capabilities.edit_tickets;
  const row = (t, depth = 0, force = false) => {
    const allChildren = tree.children.get(t.id) || [], children = allChildren.filter(c => force || revealed.has(t.id) || !tree.filtered || tree.visible.has(c.id));
    const isContext = tree.context.has(t.id), open = expanded.has(t.id) || tree.filtered && children.some(c => tree.visible.has(c.id));
    const ranked = tree.ranking.get(t.id);
    const r = t.work_rollup || {}, reason = (opts.lens === 'suggested' ? ranked?.reasons?.[0] : null) || r.reasons?.[0]?.text || t.blocker || t.next_action || '';
    const requiredTotal = Number.isSafeInteger(r.required_total) && r.required_total > 0 ? r.required_total : 0;
    const rawCompleted = r.required_completed ?? r.completed;
    const requiredCompleted = Number.isSafeInteger(rawCompleted) ? Math.max(0, Math.min(requiredTotal, rawCompleted)) : 0;
    const priority = editable ? `<select id="work-priority-${attr(t.id)}" data-action="priority-select" data-ticket="${attr(t.id)}" aria-label="Priority for ${attr(t.key)}">${['P0','P1','P2','P3'].map(p => `<option${p === t.priority ? ' selected' : ''}>${p}</option>`).join('')}</select>` : esc(t.priority);
    const status = editable ? `<select id="work-status-${attr(t.id)}" data-action="status-select" data-ticket="${attr(t.id)}" aria-label="Status for ${attr(t.key)}">${STATUS_ORDER.map(x => `<option value="${x}"${x === t.status ? ' selected' : ''}>${esc(STATUS_LABELS[x])}</option>`).join('')}</select>` : esc(STATUS_LABELS[t.status]);
    const groups = { open: [], completed: [], independent: [], unknown: [] };
    for (const c of children) groups[c.blocks_parent == null ? 'unknown' : c.blocks_parent === false ? 'independent' : c.status === 'done' && c.work_rollup?.closure_state !== 'needs-review' && (!c.resolution || c.resolution.kind === 'completed') ? 'completed' : 'open'].push(c);
    let budget = opts.childLimits?.[t.id] || 100;
    const list = (items) => { const shown = items.slice(0, Math.max(0, budget)); budget -= shown.length; return shown.map(c => row(c, depth + 1, force || revealed.has(t.id))).join(''); };
    const disclosure = (items, name) => items.length ? `<li><details data-disclosure="work-${attr(t.id)}-${name}"${tree.filtered ? ' open' : ''}><summary>${name} (${items.length})</summary><ul class="work-children">${list(items)}</ul></details></li>` : '';
    const urgent = allChildren.find(c => c.status !== 'done' && c.priority < t.priority);
    return `<li class="work-node"><div class="work-row${checked.has(t.id) ? ' is-checked' : ''}${opts.selected === t.id ? ' is-selected' : ''}${isContext ? ' work-context' : ''}" data-work-row="${attr(t.id)}" data-status="${attr(t.status)}" style="--work-depth:${Math.min(depth, 5)}">
      <div class="work-leading">${editable ? `<input type="checkbox" data-check="${attr(t.id)}" aria-label="Select ${attr(t.key)}"${checked.has(t.id) ? ' checked' : ''}>` : ''}<span class="work-disclosure">${allChildren.length ? `<button id="work-expand-${attr(t.id)}" type="button" class="btn small ghost icon-only" data-action="work-expand" data-ticket="${attr(t.id)}" aria-expanded="${open}" aria-controls="work-children-${attr(t.id)}" aria-label="${open ? 'Collapse' : 'Expand'} ${attr(t.title)}">${icon('chevron')}</button>` : '<span class="work-leaf" aria-hidden="true"></span>'}</span></div>
      <div class="work-identity"><button id="work-open-${attr(t.id)}" class="link work-title" type="button" data-open="${attr(t.id)}" title="${attr(t.title)}">${esc(t.title)}</button><div class="work-meta"><span class="work-key" title="${attr(t.key)}">${esc(t.key)}</span>${isContext ? '<span>Context</span>' : ''}${requiredTotal ? `<span class="work-completion" title="${attr(completionText(t, !!s.meta.exported_at))}"><meter min="0" max="${requiredTotal}" value="${requiredCompleted}" aria-label="${attr(completionText(t, !!s.meta.exported_at))}"></meter>${requiredCompleted}/${requiredTotal} subtasks<span class="sr-only"> · ${esc(completionText(t, !!s.meta.exported_at))}</span></span>` : ''}${urgent ? `<span class="warning">${esc(urgent.priority)} child</span>` : ''}${reason ? `<span class="work-preview" title="${attr(reason)}">${esc(reason)}</span>` : ''}</div></div>
      <span class="work-priority" data-priority="${attr(t.priority)}">${priority}</span><span class="work-status" data-status="${attr(t.status)}"><span class="status-orbit" aria-hidden="true"></span>${status}</span>
      <span class="work-signal">${opts.lens === 'suggested' && ranked ? `<details><summary>Why suggested</summary><p>Score ${esc(ranked.score)} · ${esc((ranked.reasons || []).join('; '))}</p></details>` : ''}${tree.invalid.has(t.id) ? '<span class="warning">Invalid parent link</span>' : ''}${tree.active.has(t.id) ? '<span class="work-live"><span class="dot" aria-hidden="true"></span>Run active</span>' : tree.attention.has(t.id) ? '<button type="button" class="btn small ghost work-attention" data-open="' + attr(t.id) + '">' + icon('alert') + (r.closure_state === 'needs-review' ? 'Needs review' : 'Needs attention') + '</button>' : s.capabilities.handoff && !s.meta.exported_at && t.status !== 'done' ? `<button class="btn small ghost" data-action="handoff" data-ticket="${attr(t.id)}">${icon('play')}Run agent</button>` : ''}</span>
    </div>${(opts.pending || []).filter(p => p.target_id === t.id).map(p => requestFeedback(p, { now: opts.now })).join('')}
    ${allChildren.length ? `<ul id="work-children-${attr(t.id)}" class="work-children"${open ? '' : ' hidden'}>${open ? `${list(groups.open)}${disclosure(groups.completed, 'Completed')}${disclosure(groups.independent, 'Related follow-ups')}${disclosure(groups.unknown, 'Classify relationships')}${children.length > (opts.childLimits?.[t.id] || 100) ? `<li><button class="btn small" data-action="work-children-more" data-ticket="${attr(t.id)}">Show 100 more subtasks</button></li>` : ''}` : ''}${tree.filtered && children.length < allChildren.length ? `<li><button class="link" data-action="work-reveal" data-ticket="${attr(t.id)}">Show all subtasks</button></li>` : ''}</ul>` : ''}</li>`;
  };
  if (opts.order?.length) { const order = new Map(opts.order.map((id, i) => [id,i])); const stable = (a,b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity); tree.roots.sort(stable); for (const list of tree.children.values()) list.sort(stable); }
  const chain = []; let cursor = tree.byId.get(opts.root); while (cursor) { chain.unshift(cursor); cursor = tree.byId.get(tree.parents.get(cursor.id)); }
  const pageSize = opts.limit || 100, roots = tree.roots.slice(0, pageSize);
  return `<section class="view view-work" aria-labelledby="tab-work">
    ${renderWorkPulse(tree)}
    <div class="work-controls"><nav class="work-lenses" aria-label="Work lenses">${Object.entries(WORK_LENSES).map(([id, name]) => `<button id="work-lens-${id}" type="button" class="btn small ghost" data-action="work-lens" data-lens="${id}" aria-pressed="${(opts.lens || 'open') === id}">${name}</button>`).join('')}</nav><label class="work-sort"><span>Sort</span><select id="work-sort" data-work-sort aria-label="Sort work"><option value="priority"${!opts.sort || opts.sort === 'priority' ? ' selected' : ''}>Priority</option><option value="activity"${opts.sort === 'activity' ? ' selected' : ''}>Oldest activity</option><option value="title"${opts.sort === 'title' ? ' selected' : ''}>Title</option></select></label></div>
    <div class="work-toolbar"><p class="section-count">${tree.matches.size} matching task${tree.matches.size === 1 ? '' : 's'} in ${tree.roots.length} outcome${tree.roots.length === 1 ? '' : 's'}</p><span class="work-hint">Select a task to explore its context</span></div>
    ${opts.root ? `<nav class="breadcrumb" aria-label="Work position"><button type="button" class="link" data-action="tree-root" data-root="">All outcomes</button>${chain.map(t => ` / <button class="link" data-action="tree-root" data-root="${attr(t.id)}">${esc(t.key)}</button>`).join('')}</nav>` : ''}
    <div class="work-table"><div class="work-columns" aria-hidden="true"><span></span><span>Task / next step</span><span>Priority</span><span>Status</span><span>Action</span></div><ul class="work-list">${roots.map(t => row(t)).join('') || '<li class="empty"><div class="empty-mark" aria-hidden="true">' + icon('check') + '</div><h2>No matching work</h2><p>Try another lens or clear the filters.</p><button type="button" class="btn small" data-action="clear-filters">Clear filters</button></li>'}</ul></div>
    ${roots.length < tree.roots.length ? '<button type="button" class="btn work-more" data-action="work-more">Show 100 more outcomes</button>' : ''}
  </section>`;
}

function renderWorkPulse(tree) {
  const tasks = [...tree.matches].map(id => tree.byId.get(id));
  const done = tasks.filter(t => t.status === 'done').length;
  const active = tasks.filter(t => tree.active.has(t.id)).length;
  const attention = tasks.filter(t => tree.attention.has(t.id)).length;
  const statuses = STATUS_ORDER.map(status => ({ status, count: tasks.filter(t => t.status === status).length }));
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  return `<section class="work-pulse" aria-label="Matching work overview">
    <div class="pulse-progress"><svg class="progress-ring" viewBox="0 0 64 64" role="img" aria-label="${done} of ${tasks.length} matching tasks marked done"><circle class="ring-track" cx="32" cy="32" r="26"/><circle class="ring-value" cx="32" cy="32" r="26" pathLength="100" stroke-dasharray="${percent} 100"/><text x="32" y="36" text-anchor="middle">${percent}%</text></svg><div><span class="pulse-label">Work in view</span><strong>${tasks.length}<span> task${tasks.length === 1 ? '' : 's'}</span></strong><span class="pulse-note">${done} marked done in this view</span></div></div>
    <div class="pulse-stat"><span class="pulse-label">With active runs</span><strong>${active}${active ? '<span class="work-live"><span class="dot" aria-hidden="true"></span>In motion</span>' : ''}</strong><span class="pulse-note">${active ? 'Agents are working on these tasks' : 'Ready when you are'}</span></div>
    <div class="pulse-stat"><span class="pulse-label">Needs attention</span><strong${attention ? ' class="warning"' : ''}>${attention}</strong><span class="pulse-note">${attention ? 'Blockers, reviews or missing context' : 'No attention flags in this view'}</span></div>
    <div class="pulse-distribution" aria-label="Task status distribution">${statuses.filter(x => x.count).map(({status,count}) => `<span data-status="${status}" style="flex:${count}" title="${attr(STATUS_LABELS[status])}: ${count}"><span class="sr-only">${esc(STATUS_LABELS[status])}: ${count}. </span></span>`).join('')}</div>
  </section>`;
}
