// Records handoff outcomes as journal transactions. Children use stable (handoff, index) identities
// so result redelivery cannot duplicate them; next-action suggestions are revision-checked by the
// reducer against base_ticket_revision (TRD §Handoff execution).
import { putBlob } from '../core/blobs.js';
import { deterministicId } from '../lib/ids.js';
import { CATEGORIES, PRIORITIES } from '../core/state.js';
import { recordedStage } from './stage.js';
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
      category: CATEGORIES.includes(c.category) ? c.category : ticket.category, priority: PRIORITIES.includes(c.priority) ? c.priority : ticket.priority, next_action: c.next_action ?? '', summary: c.description ?? '',
    });
  });
  if (!suggesting && state === 'done' && result.next_action) items.push({ type: 'next-action', text: result.next_action });
  if (!suggesting && state === 'done' && result.blocker) items.push({ type: 'blocker', text: result.blocker });
  if (!suggesting && state === 'done' && result.description) items.push({ type: 'description', text: result.description });
  let result_ref = h.result_ref ?? null;
  if (result && (result.raw || result.summary)) {
    try { result_ref = putBlob(JSON.stringify({ summary: result.summary, next_action: result.next_action, blocker: result.blocker, children: result.children, deploy_evidence: result.deploy_evidence, comment_draft: result.comment_draft, test_results: result.test_results, changed_files: result.changed_files, description: result.description ?? null, confidence: result.confidence ?? null, sources: result.sources ?? [], stage_reached: result.stage_reached ?? null, plan: result.plan ?? [], attempts: result.attempts ?? [], verification: result.verification ?? [], critical_changes: result.critical_changes ?? [], learnings: result.learnings ?? [], contract_problems: result.contract_problems ?? [], raw: result.raw ?? null }, null, 2), worker.env).hash; } catch { /* keep previous */ }
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
  // The record carries counts and the stage only; the items live in the result blob (spec §5.3).
  // `recorded_stage` comes from facts the worker observed, never from the agent's claim.
  const count = (k, prior) => (result && Array.isArray(result[k]) ? result[k].length : prior ?? 0);
  update.attempt_count = count('attempts', h.attempt_count);
  update.learning_count = count('learnings', h.learning_count);
  update.critical_count = count('critical_changes', h.critical_count);
  update.stage_reached = result && result.stage_reached ? result.stage_reached : h.stage_reached ?? null;
  update.recorded_stage = recordedStage({ ...h, ...update });
  if (suggesting && state === 'done' && !(h.suggestions ?? []).length) update.suggestions = buildSuggestions(h.outputs ?? [], result, worker.now());
  return worker.emit('handoff-tx', { handoff_id: h.id, update, result_items: items }, { source_identity: `handoff-tx:${h.id}:${state}:${worker.now()}` });
}

export function updateHandoff(worker, handoffId, update) {
  return worker.emit('handoff-tx', { handoff_id: handoffId, update }, { source_identity: `handoff-tx:${handoffId}:${update.state ?? 'update'}:${worker.now()}:${Object.keys(update).join(',')}` });
}
