// One conservative closure policy for reconciliation, cleanup and owner-facing explanations.
import { ageMs, DAY } from '../lib/time.js';
import { contentHash } from '../lib/ids.js';
import { TrackerError } from '../lib/errors.js';

export function validateCompletionFields(state, ticket, fields) {
  if (fields.completion_mode !== undefined && !['evidence', 'children'].includes(fields.completion_mode)) throw new TrackerError('completion-mode-invalid', 'completion_mode must be evidence or children');
  if (fields.blocks_parent !== undefined && ((fields.blocks_parent !== null && typeof fields.blocks_parent !== 'boolean') || !(fields.parent_id ?? ticket.parent_id))) throw new TrackerError('child-relationship-invalid', 'blocks_parent must be a boolean or null on a child ticket');
  if (fields.resolution !== undefined) {
    const r = fields.resolution;
    if ((fields.status ?? ticket.status) !== 'done' || !r || !['completed', 'duplicate', 'superseded', 'abandoned'].includes(r.kind)) throw new TrackerError('resolution-invalid', 'resolution requires done and a valid kind');
    if (typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 500) throw new TrackerError('resolution-reason-required', 'resolution reason must contain 1–500 characters');
    if (['duplicate', 'superseded'].includes(r.kind) && (!state.tickets.has(r.related_ticket_id) || r.related_ticket_id === ticket.id)) throw new TrackerError('resolution-related-required', 'resolution requires a related ticket other than itself');
  }
}

const values = x => x instanceof Map ? [...x.values()] : x ?? [];
export function closureContext(state, nowIso) {
  const tickets = values(state.tickets), handoffs = values(state.handoffs), byParent = new Map(), runsByTicket = new Map();
  for (const t of tickets) if (t.parent_id) { if (!byParent.has(t.parent_id)) byParent.set(t.parent_id, []); byParent.get(t.parent_id).push(t); }
  for (const h of handoffs) { if (!runsByTicket.has(h.ticket_id)) runsByTicket.set(h.ticket_id, []); runsByTicket.get(h.ticket_id).push(h); }
  return { tickets, handoffs, byParent, runsByTicket, nowIso, complete: true };
}

export function assessClosure(ticket, context = {}) {
  const { nowIso, complete = false } = context;
  const children = context.byParent?.get(ticket.id) ?? values(context.tickets).filter(c => c.parent_id === ticket.id);
  const runs = context.runsByTicket?.get(ticket.id) ?? values(context.handoffs).filter(h => h.ticket_id === ticket.id);
  const prs = ticket.prs ?? [], deployments = ticket.deployments ?? [], blockers = [];
  if (ticket.status === 'blocked') blockers.push(ticket.blocker || 'Ticket is blocked');
  if (runs.some(h => ['queued', 'running'].includes(h.state))) blockers.push('An agent run is still active');
  if (runs.some(h => h.uncertain_effects?.length)) blockers.push('An agent run has unresolved effects');
  if (runs.some(h => h.pr_observed?.reverted_by && prs.some(p => p.url === h.pr_url))) blockers.push('Delivered work was reverted; owner review is required');
  if (children.some(c => c.blocks_parent == null)) blockers.push('Choose whether legacy children are required or independent');
  const required = children.filter(c => c.blocks_parent === true);
  if (required.some(c => c.status !== 'done')) blockers.push('Required child work remains open');
  if (required.some(c => c.status === 'done' && c.resolution && c.resolution.kind !== 'completed')) blockers.push('Required child work was resolved without delivery');
  if (prs.some(p => p.state !== 'merged')) blockers.push('A linked PR is open, unmerged or unknown');
  if (prs.some(p => p.error)) blockers.push('PR evidence could not be refreshed');
  if (nowIso && prs.some(p => !p.observed_at || ageMs(p.observed_at, nowIso) > DAY)) blockers.push('PR evidence needs a fresh check');
  if (deployments.some(d => !['deployed', 'waived'].includes(d.state))) blockers.push('Required deployment is pending');
  const merged = prs.filter(p => p.state === 'merged');
  if (merged.some(p => !deployments.some(d => d.pr_id === p.id))) blockers.push('Deployment evidence is missing');
  const newestMerge = merged.map(p => p.merged_at ?? '').sort().at(-1) ?? '';
  if (runs.some(h => (h.changed_files?.length || h.file_effects?.length) && h.finished_at && (!newestMerge || h.finished_at > newestMerge))) blockers.push('New run edits are not covered by the recorded merge');
  if (ticket.last_work_at && (!newestMerge || ticket.last_work_at > newestMerge)) blockers.push('New work is not covered by the recorded merge');
  const grouping = ticket.completion_mode === 'children';
  const kind = merged.length ? 'shipped' : grouping && required.length ? 'children-done' : 'review';
  if (!merged.length && !(grouping && required.length)) blockers.push(children.length ? 'Parent completion needs owner review' : 'Completion evidence is missing');
  if (!complete) blockers.push('Complete worker state is required before closing');
  const evidence_seq = Math.max(ticket.completion_evidence_seq ?? 0, grouping ? ticket.completion_policy_seq ?? 0 : 0,
    ...required.map(c => c.closed_sequence ?? 0));
  if ((ticket.manual_status_evidence_floor ?? 0) > 0 && evidence_seq <= ticket.manual_status_evidence_floor) blockers.push('A newer manual status decision needs owner review');
  return { closable: blockers.length === 0, kind, blockers, evidence_seq,
    reason: blockers.length ? blockers[0] : grouping && !merged.length ? 'All required child work is complete' : 'All linked PRs and required deployments are complete' };
}

export function reconciliationItems(state, nowIso, { includeAcknowledged = false } = {}) {
  const context = closureContext(state, nowIso);
  return context.tickets.flatMap(t => {
    if (t.status === 'done') {
      const reopened = (context.byParent.get(t.id) ?? []).some(c => c.blocks_parent === true && c.status !== 'done');
      const reverted = (context.runsByTicket.get(t.id) ?? []).some(h => h.pr_observed?.reverted_by);
      return reopened || reverted ? [{ ticket_id: t.id, key: t.key, title: t.title, status: t.status, kind: 'closure-conflict', reason: reverted ? 'Delivered work was reverted' : 'Required child work reopened after completion', blockers: ['Review the completion decision'], closable: false }] : [];
    }
    const result = assessClosure(t, context);
    const idle = t.last_activity && ageMs(t.last_activity, nowIso) >= 5 * DAY;
    const remoteDone = /^(done|closed|resolved|completed)$/i.test(t.external?.remote?.status ?? '');
    const unlinked = t.branches?.length && !t.prs?.length;
    if (!idle && !remoteDone && !unlinked && !['review', 'deploy-pending', 'blocked'].includes(t.status) && !result.closable && !context.byParent.has(t.id)) return [];
    return [{ ticket_id: t.id, key: t.key, title: t.title, status: t.status, ...result,
      ...(remoteDone && !result.closable ? { reason: `Tracker says ${t.external.remote.status}; ${result.reason.toLowerCase()}` } : {}) }];
  }).map(item => {
    const t = state.tickets.get(item.ticket_id);
    const runs = context.runsByTicket.get(t.id) ?? [];
    const checks = values(state.reconcileChecks).filter(c => c.repo_id === t.repo_id && (c.kind === 'ticket-pr' && c.target_id.startsWith(`${t.id}:`) || c.kind === 'run-pr' && runs.some(h => c.target_id.startsWith(`${h.id}:`)) || c.kind === 'branch' && t.branches?.some(b => b.name === c.target_id)));
    // Poll times and retry counts are deliberately excluded: unchanged observations stay quiet.
    const evidence_version = contentHash(JSON.stringify([t.status, t.blocker, t.completion_mode, t.last_work_at, t.manual_status_evidence_floor, item.blockers,
      (t.prs ?? []).map(p => [p.id, p.state, p.merged_at, p.error]),
      (t.deployments ?? []).map(d => [d.id, d.state]),
      (context.byParent.get(t.id) ?? []).map(c => [c.id, c.status, c.blocks_parent, c.resolution?.kind]),
      runs.map(h => [h.id, h.state, h.finished_at, h.uncertain_effects, h.pr_observed?.reverted_by]), t.external?.remote?.status, checks.filter(c => c.error).map(c => [c.key, c.error]).sort((a, b) => a[0].localeCompare(b[0]))]));
    return { ...item, evidence_version, last_success_at: checks.map(c => c.last_success_at).filter(Boolean).sort().at(-1) ?? null,
      next_check_at: checks.map(c => c.next_check_at).filter(Boolean).sort()[0] ?? null, error: checks.find(c => c.error)?.error ?? null };
  }).filter(item => includeAcknowledged || state.tickets.get(item.ticket_id).closure_review?.evidence_version !== item.evidence_version);
}

export function validateClosureAcknowledgement(state, ticket, version, nowIso) {
  const item = reconciliationItems(state, nowIso, { includeAcknowledged: true }).find(i => i.ticket_id === ticket.id);
  if (typeof version !== 'string' || !item || item.evidence_version !== version) throw new TrackerError('closure-review-stale', 'Closure evidence changed; refresh before reviewing');
  return { evidence_version: version, at: nowIso };
}

// Cumulative local outcomes, not agent productivity scores. Unknown history stays unknown.
export function reconciliationSummary(state, nowIso) {
  const context = closureContext(state, nowIso);
  const tickets = context.tickets, runs = context.handoffs;
  const open = tickets.filter(t => t.status !== 'done');
  const completed = tickets.filter(t => t.status === 'done' && (!t.resolution || t.resolution.kind === 'completed'));
  const otherwise = tickets.filter(t => t.status === 'done' && t.resolution && t.resolution.kind !== 'completed');
  const delays = completed.flatMap(t => {
    const mergedAt = (t.prs ?? []).map(p => p.merged_at).filter(Boolean).sort().at(-1);
    const closedAt = (t.timeline ?? []).filter(e => e.kind === 'status').map(e => e.at).sort().at(-1);
    if (!mergedAt || !closedAt || Date.parse(closedAt) < Date.parse(mergedAt)) return [];
    return [Date.parse(closedAt) - Date.parse(mergedAt)];
  });
  return { tasks_created: tickets.length, open: open.length, completed: completed.length, otherwise_resolved: otherwise.length,
    oldest_open_at: open.map(t => t.created_at).filter(Boolean).sort()[0] ?? null,
    closure_conflicts: tickets.filter(t => t.status === 'done' && ((context.byParent.get(t.id) ?? []).some(c => c.blocks_parent === true && c.status !== 'done') || (context.runsByTicket.get(t.id) ?? []).some(h => h.pr_observed?.reverted_by))).length,
    suppressed_followups: runs.reduce((n, h) => n + (h.suggestions ?? []).filter(s => s.type === 'followup' && s.state === 'suppressed').length, 0),
    merge_to_closure: { measured: delays.length, mean_ms: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null } };
}
