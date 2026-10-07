// Records handoff outcomes as journal transactions. Children use stable (handoff, index) identities
// so result redelivery cannot duplicate them; next-action suggestions are revision-checked by the
// reducer against base_ticket_revision (TRD §Handoff execution).
import { putBlob } from '../core/blobs.js';
import { deterministicId } from '../lib/ids.js';
import { CATEGORIES, PRIORITIES } from '../core/state.js';
import { childKeys, buildSuggestions } from '../agents/suggestions.js';

export function recordResult(worker, handoffId, result, { state = 'done', error = null, extra = {} } = {}) {
  const h = worker.state.handoffs.get(handoffId);
  if (!h) return null;
  const ticket = worker.state.tickets.get(h.ticket_id);
  const items = [];
  // Recipes other than the built-in modes never edit the ticket: their outputs become suggestions.
  const suggesting = h.legacy === false;
  const children = !suggesting && state === 'done' && h.mode === 'analyse-followups' && ticket ? (result.children ?? []) : [];
  const keys = ticket ? childKeys(worker.state, ticket, children.length) : [];
  children.forEach((c, i) => {
    items.push({
      type: 'child', id: deterministicId(`${h.id}:child:${i}`), key: keys[i], title: c.title,
      category: CATEGORIES.includes(c.category) ? c.category : ticket.category, priority: PRIORITIES.includes(c.priority) ? c.priority : ticket.priority, next_action: c.next_action ?? '',
    });
  });
  if (!suggesting && state === 'done' && result.next_action) items.push({ type: 'next-action', text: result.next_action });
  if (!suggesting && state === 'done' && result.blocker) items.push({ type: 'blocker', text: result.blocker });
  let result_ref = h.result_ref ?? null;
  if (result && (result.raw || result.summary)) {
    try { result_ref = putBlob(JSON.stringify({ summary: result.summary, next_action: result.next_action, blocker: result.blocker, children: result.children, deploy_evidence: result.deploy_evidence, comment_draft: result.comment_draft, test_results: result.test_results, changed_files: result.changed_files, confidence: result.confidence ?? null, sources: result.sources ?? [], raw: result.raw ?? null }, null, 2), worker.env).hash; } catch { /* keep previous */ }
  }
  const update = {
    state,
    finished_at: worker.now(),
    error,
    result_ref,
    result_summary: result && result.summary ? result.summary : h.result_summary ?? null,
    // How sure the agent is and what it relied on (ADR 0013), shown beside the summary.
    result_confidence: result && result.confidence ? result.confidence : h.result_confidence ?? null,
    result_sources: result && Array.isArray(result.sources) && result.sources.length ? result.sources : h.result_sources ?? [],
    test_results: result && result.test_results && result.test_results.length ? result.test_results : h.test_results ?? [],
    changed_files: extra.changed_files ?? (result && result.changed_files && result.changed_files.length ? result.changed_files : h.changed_files ?? []),
    ...extra,
  };
  if (suggesting && state === 'done' && !(h.suggestions ?? []).length) update.suggestions = buildSuggestions(h.outputs ?? [], result, worker.now());
  return worker.emit('handoff-tx', { handoff_id: h.id, update, result_items: items }, { source_identity: `handoff-tx:${h.id}:${state}:${worker.now()}` });
}

export function updateHandoff(worker, handoffId, update) {
  return worker.emit('handoff-tx', { handoff_id: handoffId, update }, { source_identity: `handoff-tx:${handoffId}:${update.state ?? 'update'}:${worker.now()}:${Object.keys(update).join(',')}` });
}
