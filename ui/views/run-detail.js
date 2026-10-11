// Run detail (spec §3): what a run did, what the worker verified, where it is, and what is left for
// the owner to decide. Sections an export stripped are omitted, never shown empty.
import { esc, attr, icon, timeEl, handoffChip, ticketById, normalizeSnapshot, contentViewer, keyEl } from '../components.js';
import { testGateChip, accessBadge, runTimings, runQuality, suggestionItem, fileEffects, SOURCE_LABELS } from './agents.js';
import { supersededBy } from '../lib/runs.js';

const section = (title, body) => (body ? `<section class="detail-section"><h3>${esc(title)}</h3>${body}</section>` : '');

function closeRow(t) {
  return `<div class="detail-nav"><button type="button" class="btn icon-only" data-action="close-run" aria-label="Close run (Escape)">${icon('x')}</button>${t ? `<button type="button" class="btn small ghost" data-action="open-ticket-from-run" data-ticket="${attr(t.id)}">Open ticket</button>` : ''}<span class="detail-nav-keys"><button type="button" class="btn small ghost icon-only prev" data-action="run-prev" aria-label="Previous run">${icon('chevron')}</button><button type="button" class="btn small ghost icon-only" data-action="run-next" aria-label="Next run">${icon('chevron')}</button></span></div>`;
}

export function renderRunNotFound(id) {
  return `<article class="detail run-detail" data-run="${attr(id)}"><header class="detail-head"><div class="detail-nav"><button type="button" class="btn icon-only" data-action="close-run" aria-label="Close (Escape)">${icon('x')}</button></div><h2 id="detail-title">Run not found</h2><p class="muted small">This run is not in the current snapshot. It may be older than the snapshot keeps or belong to another store.</p></header></article>`;
}

export function renderRunDetail(h, rawSnapshot, { now, pending = [], content = {}, contentStatus = {} } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const caps = snapshot.capabilities ?? {};
  const tz = snapshot.meta.timezone;
  const t = ticketById(snapshot, h.ticket_id);
  const name = h.recipe ? h.recipe.name : h.mode;
  const source = h.recipe && h.recipe.source ? ` <span class="chip small">${esc(SOURCE_LABELS[h.recipe.source] ?? h.recipe.source)}</span>` : '';
  const next = supersededBy(snapshot, h);

  const head = `<header class="detail-head run-head">${closeRow(t)}
  <div class="detail-keys">${t ? keyEl(t.key) : '<span class="muted">Ticket not in view</span>'}</div>
  <h2 id="detail-title">${t ? esc(t.title) : esc(name)}</h2>
  <div class="detail-chips">${handoffChip({ ...h, error: null })} <strong>${esc(name)}</strong>${source}${h.recipe && h.recipe.name !== h.mode ? ` <span class="muted small">${esc(h.mode)}</span>` : ''} ${accessBadge(h)} ${testGateChip(h.test_gate)}</div>
  ${runTimings(h)}
  <p class="small muted">Requested ${timeEl(h.requested_at, now, tz)}${h.batch_id ? ` · Batch ${esc(h.batch_id.slice(0, 8))}` : ''}${h.retry_of ? ' · Retry of an earlier run' : ''}${next ? ` · ${next.retried ? 'Retried as a new run' : 'Superseded by a later run'}` : ''}</p>
</header>`;

  const result = [
    h.error && h.error.message ? `<p class="small critical">${esc(h.error.message)}</p>` : '',
    h.result_summary ? `<p class="prewrap">${esc(h.result_summary)}</p>` : '',
    h.result_ref ? contentViewer(h.result_ref, { content, status: contentStatus, generation: snapshot.generation_id, label: h.state === 'done' ? 'Show full result' : 'Show partial result' }) : '',
    runQuality(h, { gate: false }),
  ].join('');

  const changes = [
    (h.changed_files ?? []).length ? `<p class="small">${h.changed_files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : '',
    h.commit_sha ? `<p class="small">Commit <code>${esc(h.commit_sha.slice(0, 7))}</code> <button type="button" class="btn small ghost icon-only" data-copy="${attr(h.commit_sha)}" data-copy-label="the commit" aria-label="Copy the commit">${icon('copy')}</button></p>` : '',
    (h.test_results ?? []).length ? `<ul class="small test-results">${h.test_results.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '',
    fileEffects(h, t ?? { id: h.ticket_id }, { canEdit: !!caps.edit_tickets, pending }),
  ].join('');

  const uncertain = (h.uncertain_effects ?? []).length ? `<div class="run-uncertain" role="note">${icon('alert')}<div><strong>The worker could not confirm:</strong><ul>${h.uncertain_effects.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div>` : '';
  const delivery = [
    h.pr_url ? (/^https?:\/\//i.test(h.pr_url) ? `<p><a href="${attr(h.pr_url)}" target="_blank" rel="noopener noreferrer">${esc(h.pr_url)}</a></p>` : `<p class="small"><code>${esc(h.pr_url)}</code></p>`) : '',
    h.branch ? `<p class="small">Branch <code>${esc(h.branch)}</code></p>` : '',
    uncertain,
  ].join('');

  // Local paths are owner-only text: never a link, never fetched, never exported.
  const where = caps.handoff && h.worktree_path ? `<p class="small"><code>${esc(h.worktree_path)}</code> <button type="button" class="btn small ghost icon-only" data-copy="${attr(h.worktree_path)}" data-copy-label="the run's checkout path" aria-label="Copy the checkout path">${icon('copy')}</button></p>` : '';

  const suggestions = (h.suggestions ?? []).length ? `<ul class="suggestions">${h.suggestions.map((s) => suggestionItem(s, h, t ?? { id: h.ticket_id }, { canEdit: !!caps.edit_tickets, pending })).join('')}</ul>` : '';

  const actions = [];
  if (caps.handoff && ['queued', 'running'].includes(h.state)) actions.push(`<button type="button" class="btn small" data-action="cancel-handoff" data-handoff="${attr(h.id)}">Cancel</button>`);
  if (caps.handoff && t && !next && ['failed', 'timed-out', 'cancelled'].includes(h.state)) actions.push(`<button type="button" class="btn small" data-action="run-agent" data-ticket="${attr(t.id)}" data-recipe="${attr(name)}" data-retry-of="${attr(h.id)}">Retry as new run</button>`);

  return `<article class="detail run-detail" data-run="${attr(h.id)}" aria-labelledby="detail-title">
${head}
${section('Result', result)}
${section('Changes', changes)}
${section('Delivery', delivery)}
${section('Where it is', where)}
${section('Suggestions', suggestions)}
${actions.length ? `<div class="run-actions">${actions.join(' ')}</div>` : ''}
</article>`;
}
