// Reconcile bounded, fair provider observations and publish one journaled generation.
import { uuid } from '../lib/ids.js';
import { addMs, HOUR } from '../lib/time.js';
import { repoFor } from '../core/state.js';
import { applyLifecycle } from './lifecycle.js';
import { defaultProviders } from './providers/index.js';
import { checkKey, selectChecks, recordCheck } from './checks.js';

export const NONTERMINAL_PR = new Set(['unknown', 'draft', 'open']);
export const MAX_PR_POLLS_PER_RUN = 200;
export const MAX_RUN_PR_POLLS_PER_RUN = 50;
export const MAX_BRANCH_LOOKUPS_PER_RUN = 50;
export const REVERT_WINDOW_MS = 48 * HOUR;

export function nextSyncDue(lastSync, intervalHours) {
  return lastSync ? addMs(lastSync, intervalHours * HOUR) : null;
}

export function isSyncDue(state, nowIso) {
  if (!state.lastSync) return true;
  return nowIso >= nextSyncDue(state.lastSync, state.meta.sync_interval_hours);
}

export function runPrSettled(obs) {
  if (!obs || typeof obs !== 'object' || !obs.state) return false;
  if (obs.state === 'closed') return true;
  if (obs.state !== 'merged') return false;
  if (obs.reverted_by) return true;
  return !!(obs.merged_at && obs.revert_checked_at && Date.parse(obs.revert_checked_at) >= Date.parse(obs.merged_at) + REVERT_WINDOW_MS);
}

function target(kind, repoId, targetId, activityAt, values) {
  return { kind, repo_id: repoId, target_id: targetId, key: checkKey(kind, repoId, targetId), activity_at: activityAt, ...values };
}

// The same environment validation applies to every source of merge evidence. Resolve once and
// carry the result with the observation so replay cannot silently invent deployment policy.
function mergeContext(worker, repo, result) {
  if (result.state !== 'merged') return {};
  const envs = worker.environmentsResolution?.(repo?.id ?? null);
  if (envs?.error) {
    const message = `deployment environments for ${repo?.id ?? 'this repository'} are unresolved (${envs.error}); the merge is recorded once that is fixed`;
    worker.recordHealthError?.({ kind: 'config-invalid', error: message });
    throw new Error(message);
  }
  const environments = envs?.list ?? worker.environmentsFor?.(repo?.id ?? null);
  return {
    ...(Array.isArray(environments) ? { environments } : {}),
    ...(repo?.deploy_on === 'merge' ? { deploy_on: 'merge' } : {}),
  };
}

function evidence(worker, repo, result, now) {
  return { ...result, observed_at: result.observed_at ?? now, error: null,
    evidence_id: `${result.url}:${result.state}:${result.merged_at ?? ''}`, ...mergeContext(worker, repo, result) };
}

// A branch name alone cannot attribute an old merge to work recorded after it. Captured writes
// must predate the merge; closed PRs without a closure timestamp cannot establish contribution.
function branchCoversWork(pr, branch, ticket) {
  if (pr.head_branch !== branch.name || !Number.isFinite(Date.parse(branch.last_seen))) return false;
  // A previous terminal PR bounds the earlier use of this branch. Without newer captured
  // writes, a later PR belongs to an unknown contribution, so leave it for owner review.
  if (ticket.prs.some((prior) => prior.url !== pr.url && prior.head_branch === branch.name
    && ['closed', 'merged'].includes(prior.state)
    && Date.parse(prior.merged_at ?? prior.observed_at) >= Date.parse(branch.last_seen))) return false;
  if (pr.state === 'merged') return Number.isFinite(Date.parse(pr.merged_at)) && Date.parse(branch.last_seen) <= Date.parse(pr.merged_at);
  return NONTERMINAL_PR.has(pr.state);
}

function collectTargets(worker, providers) {
  const { state } = worker;
  const groups = { 'ticket-pr': [], 'run-pr': [], branch: [] };
  const branches = new Map();
  for (const ticket of state.tickets.values()) {
    const repo = repoFor(state, ticket.repo_id);
    const provider = providers.for(repo);
    for (const pr of ticket.prs) {
      // Merged evidence on unfinished work can go stale while delivery waits. Keep it
      // refreshable too; an observation alone does not change the manual evidence floor.
      if ((NONTERMINAL_PR.has(pr.state) || (pr.state === 'merged' && ticket.status !== 'done')) && typeof provider?.fetchPr === 'function') {
        groups['ticket-pr'].push(target('ticket-pr', ticket.repo_id, `${ticket.id}:${pr.url}`, pr.opened_at ?? ticket.last_activity, { repo, provider, ticket, pr }));
      }
    }
    if (ticket.status === 'done' || !repo?.canonical_path || typeof provider?.findPrs !== 'function') continue;
    for (const branch of ticket.branches ?? []) {
      if ([repo.default_branch, 'main', 'master'].includes(branch.name)) continue;
      const key = checkKey('branch', repo.id, branch.name);
      let entry = branches.get(key);
      if (!entry) {
        entry = target('branch', repo.id, branch.name, branch.last_seen, { repo, provider, branch: branch.name, tickets: [] });
        branches.set(key, entry);
      }
      if (Date.parse(branch.last_seen) > Date.parse(entry.activity_at)) entry.activity_at = branch.last_seen;
      entry.tickets.push({ ticket, branch });
    }
  }
  groups.branch = [...branches.values()];
  for (const h of state.handoffs.values()) {
    if (typeof h.pr_url !== 'string' || !h.pr_url.startsWith('https://') || !h.finished_at) continue;
    const ticket = state.tickets.get(h.ticket_id);
    // A settled legacy observation still needs one provider confirmation for its missing link.
    const missingLink = ticket && ticket.repo_id === h.repo_id && typeof h.branch === 'string' && !ticket.prs.some((pr) => pr.url === h.pr_url);
    if (runPrSettled(h.pr_observed) && (!missingLink || h.pr_observed.state !== 'merged' || h.pr_observed.reverted_by)) continue;
    const repo = repoFor(state, h.repo_id);
    const provider = providers.for(repo);
    if (!provider || provider.name === 'none' || typeof provider.fetchPr !== 'function') continue;
    groups['run-pr'].push(target('run-pr', h.repo_id, `${h.id}:${h.pr_url}`, h.finished_at, { h, ticket, repo, provider }));
  }
  return groups;
}

async function pollTarget(worker, t, now, updates) {
  const { provider, repo } = t;
  if (t.kind === 'ticket-pr') {
    const result = await provider.fetchPr(t.pr.url);
    updates.push({ ticket_id: t.ticket.id, pr_id: t.pr.id, ...evidence(worker, repo, { ...result, url: t.pr.url }, now) });
    return;
  }
  if (t.kind === 'branch') {
    const prs = await provider.findPrs(t.branch, { cwd: repo.canonical_path });
    // Multiple tickets captured this head. Timestamps alone cannot prove that the PR
    // contains every contribution; exact run links may still establish an origin. Include
    // done tickets so closing one cannot silently attribute its PR to another next sweep.
    let matchingTickets = 0;
    for (const ticket of worker.state.tickets.values()) {
      if (ticket.repo_id === t.repo_id && ticket.branches?.some((b) => b.name === t.branch) && ++matchingTickets > 1) return;
    }
    for (const { ticket, branch } of t.tickets) {
      for (const pr of prs) {
        if (!branchCoversWork(pr, branch, ticket) || ticket.prs.some((p) => p.url === pr.url) || updates.some((u) => u.ticket_id === ticket.id && u.url === pr.url && !u.error)) continue;
        updates.push({ ticket_id: ticket.id, link: true, provider: provider.name, ...evidence(worker, repo, pr, now) });
      }
    }
    return;
  }
  const { h, ticket } = t;
  const result = await provider.fetchPr(h.pr_url);
  const context = mergeContext(worker, repo, result);
  const observation = { handoff_id: h.id, url: h.pr_url, state: result.state, merged_at: result.merged_at ?? null, merge_commit: result.merge_commit ?? null, observed_at: now, error: null };
  if (result.state === 'merged' && typeof provider.findRevert === 'function') {
    const rv = await provider.findRevert({ url: h.pr_url, merged_at: result.merged_at ?? null, merge_commit: result.merge_commit ?? null });
    Object.assign(observation, { reverted_by: rv.reverted_by ?? null, reverted_at: rv.reverted_at ?? null, revert_checked_at: now });
    if (!observation.merge_commit && rv.merge_commit) observation.merge_commit = rv.merge_commit;
  }
  updates.push(observation);
  // The reducer independently validates this recorded origin before accepting ordinary evidence.
  // Incomplete legacy identities stay visible as observations, rather than guessed associations.
  if (repo && ticket && ticket.repo_id === h.repo_id && typeof h.branch === 'string' && h.branch === result.head_branch && !observation.reverted_by) {
    updates.push({ ticket_id: ticket.id, link: true, origin_handoff_id: h.id, repo_id: h.repo_id, provider: provider.name,
      ...result, url: h.pr_url, observed_at: now, error: null, evidence_id: `${h.pr_url}:${result.state}:${result.merged_at ?? ''}`, ...context });
  }
}

async function pollProviders(worker, providers, now, manual) {
  const updates = [], checks = [];
  const health = new Map((worker.state.providerHealth ?? []).map((h) => [h.provider, { ...h }]));
  const attemptedProviders = new Set();
  const limits = { 'ticket-pr': MAX_PR_POLLS_PER_RUN, 'run-pr': MAX_RUN_PR_POLLS_PER_RUN, branch: MAX_BRANCH_LOOKUPS_PER_RUN };
  const coverage = { targets: 0, checked: 0, failed: 0, deferred: 0, remaining_eligible: 0, oldest_unchecked_at: null, by_kind: {} };
  for (const [kind, targets] of Object.entries(collectTargets(worker, providers))) {
    const { selected, coverage: group } = selectChecks(worker.state, targets, limits[kind], now, manual);
    for (const t of selected) {
      const name = t.provider.name;
      const entry = health.get(name) ?? { provider: name, last_success_at: null, last_attempt_at: null, error: null };
      if (!attemptedProviders.has(name)) { entry.error = null; attemptedProviders.add(name); }
      entry.last_attempt_at = now;
      let error = null;
      try {
        await pollTarget(worker, t, now, updates);
        entry.last_success_at = now;
      } catch (err) {
        error = String(err?.message ?? err);
        entry.error ??= error;
        group.failed += 1;
        if (kind === 'ticket-pr') updates.push({ ticket_id: t.ticket.id, pr_id: t.pr.id, url: t.pr.url, error });
        if (kind === 'run-pr') updates.push({ handoff_id: t.h.id, url: t.h.pr_url, error });
      }
      health.set(name, entry);
      checks.push(recordCheck(worker.state, t, now, error));
    }
    coverage.by_kind[kind] = group;
    if (group.oldest_unchecked_at && (!coverage.oldest_unchecked_at || Date.parse(group.oldest_unchecked_at) < Date.parse(coverage.oldest_unchecked_at))) coverage.oldest_unchecked_at = group.oldest_unchecked_at;
    for (const field of ['targets', 'checked', 'failed', 'deferred', 'remaining_eligible']) coverage[field] += group[field];
  }
  return { updates, checks, coverage, provider_health: [...health.values()] };
}

export async function runReconciliation(worker, { reason = 'scheduled', providers = defaultProviders(worker.config), run_id = uuid() } = {}) {
  worker.ingestOnce();
  const now = worker.now();
  const life = applyLifecycle(worker.state, now);
  const { updates, provider_health, checks, coverage } = await pollProviders(worker, providers, now, ['refresh', 'manual'].includes(reason));
  worker.emit('reconcile', { reason, run_id, last_sync: now, provider_health, checks, coverage, pr_updates: updates, lifecycle: { tickets: life.tickets.size, sessions: life.sessions.size } });
  for (const checkpoint_id of life.notify) worker.emit('notify', { checkpoint_id, reason: 'extinct-unpromoted' }, { source_identity: `notify:${checkpoint_id}` });
  worker.markGenerationDirty();
  worker.publishGeneration();
  return { run_id, last_sync: now, provider_health, checks, coverage, pr_updates: updates, notified: life.notify.length };
}
