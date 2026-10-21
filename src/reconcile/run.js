// One reconciliation run (TRD §Reconciliation and lifecycle): import pending events, age every
// open record, poll providers for nonterminal PRs, recompute derived state, publish one generation.
import { uuid } from '../lib/ids.js';
import { addMs, HOUR } from '../lib/time.js';
import { repoFor } from '../core/state.js';
import { applyLifecycle } from './lifecycle.js';
import { defaultProviders } from './providers/index.js';

export const NONTERMINAL_PR = new Set(['unknown', 'draft', 'open']);
export const MAX_PR_POLLS_PER_RUN = 200;

export function nextSyncDue(lastSync, intervalHours) {
  return lastSync ? addMs(lastSync, intervalHours * HOUR) : null;
}

export function isSyncDue(state, nowIso) {
  if (!state.lastSync) return true;
  return nowIso >= nextSyncDue(state.lastSync, state.meta.sync_interval_hours);
}

async function pollProviders(worker, providers, now) {
  const { state } = worker;
  const updates = [];
  const health = new Map();
  for (const h of state.providerHealth ?? []) health.set(h.provider, { ...h });
  let polled = 0;
  // Done tickets are polled too: their status never moves back, but a PR shown as open after it
  // merged is wrong on the board and in the brief.
  for (const ticket of state.tickets.values()) {
    for (const pr of ticket.prs) {
      if (!NONTERMINAL_PR.has(pr.state)) continue;
      if (polled >= MAX_PR_POLLS_PER_RUN) break;
      polled += 1;
      const repo = repoFor(state, ticket.repo_id);
      const provider = providers.for(repo);
      const entry = health.get(provider.name) ?? { provider: provider.name, last_success_at: null, last_attempt_at: null, error: null };
      entry.last_attempt_at = now;
      try {
        const result = await provider.fetchPr(pr.url);
        entry.last_success_at = now;
        entry.error = null;
        const envs = result.state === 'merged' && worker.environmentsResolution ? worker.environmentsResolution(ticket.repo_id) : null;
        if (envs && envs.error) {
          // Never journal a merge against a guessed environment list: keep the PR unrecorded so the
          // next run, after the config is fixed, creates the right obligations (ADR 0009).
          const message = `deployment environments for ${ticket.repo_id ?? 'this repository'} are unresolved (${envs.error}); the merge is recorded once that is fixed`;
          updates.push({ ticket_id: ticket.id, pr_id: pr.id, url: pr.url, error: message });
          if (worker.recordHealthError) worker.recordHealthError({ kind: 'config-invalid', error: message });
          continue;
        }
        // The environments travel with the evidence so replay builds the same obligations (ADR 0009).
        updates.push({ ticket_id: ticket.id, pr_id: pr.id, url: pr.url, ...result, observed_at: result.observed_at ?? now, error: null, evidence_id: `${pr.url}:${result.state}:${result.merged_at ?? ''}`, ...mergeContext(worker, repo, result) });
      } catch (err) {
        entry.error = err.message;
        updates.push({ ticket_id: ticket.id, pr_id: pr.id, url: pr.url, error: err.message });
      }
      health.set(provider.name, entry);
    }
  }
  await linkBranchPrs(worker, providers, now, updates, health);
  await pollRunPrs(worker, providers, now, updates, health);
  return { updates, provider_health: [...health.values()] };
}

export const REVERT_WINDOW_MS = 48 * HOUR;
export const MAX_RUN_PR_POLLS_PER_RUN = 50;
const RUN_PR_MAX_AGE_MS = 30 * 24 * HOUR;

// A run's draft PR whose outcome is settled (ADR 0033): closed unmerged, reverted, or merged and
// checked for a revert at or after the end of the 48-hour window.
export function runPrSettled(obs) {
  if (!obs || typeof obs !== 'object' || !obs.state) return false;
  if (obs.state === 'closed') return true;
  if (obs.state !== 'merged') return false;
  if (obs.reverted_by) return true;
  return !!(obs.merged_at && obs.revert_checked_at && Date.parse(obs.revert_checked_at) >= Date.parse(obs.merged_at) + REVERT_WINDOW_MS);
}

// The PR a run opened (ADR 0033): observed on the run itself, never as ticket evidence, so a run's
// PR never moves its ticket's status by this path. A merged one is checked for a revert until its
// 48-hour window closes. Runs finished in the last 30 days, at most 50 polls per reconciliation.
async function pollRunPrs(worker, providers, now, updates, health) {
  const { state } = worker;
  let polled = 0;
  for (const h of state.handoffs.values()) {
    if (polled >= MAX_RUN_PR_POLLS_PER_RUN) break;
    if (typeof h.pr_url !== 'string' || !h.pr_url.startsWith('https://') || !h.finished_at) continue;
    if (Date.parse(now) - Date.parse(h.finished_at) > RUN_PR_MAX_AGE_MS || runPrSettled(h.pr_observed)) continue;
    const provider = providers.for(repoFor(state, h.repo_id));
    if (!provider || provider.name === 'none' || typeof provider.fetchPr !== 'function') continue;
    polled += 1;
    const entry = health.get(provider.name) ?? { provider: provider.name, last_success_at: null, last_attempt_at: null, error: null };
    entry.last_attempt_at = now;
    try {
      const r = await provider.fetchPr(h.pr_url);
      const upd = { handoff_id: h.id, url: h.pr_url, state: r.state, merged_at: r.merged_at ?? null, merge_commit: r.merge_commit ?? null, observed_at: now, error: null };
      if (r.state === 'merged' && typeof provider.findRevert === 'function') {
        const rv = await provider.findRevert({ url: h.pr_url, merged_at: r.merged_at ?? null, merge_commit: r.merge_commit ?? null });
        Object.assign(upd, { reverted_by: rv.reverted_by ?? null, reverted_at: rv.reverted_at ?? null, revert_checked_at: now });
        if (!upd.merge_commit && rv.merge_commit) upd.merge_commit = rv.merge_commit;
      }
      entry.last_success_at = now;
      entry.error = null;
      updates.push(upd);
    } catch (err) {
      entry.error = err.message;
      updates.push({ handoff_id: h.id, url: h.pr_url, error: err.message });
    }
    health.set(provider.name, entry);
  }
}

// The environments and the repository's deploy_on travel with merge evidence, so replay builds
// the same obligations and closes the same tickets (ADR 0009, ADR 0021).
function mergeContext(worker, repo, result) {
  if (result.state !== 'merged') return {};
  return {
    ...(worker.environmentsFor ? { environments: worker.environmentsFor(repo ? repo.id : null) } : {}),
    ...(repo && repo.deploy_on === 'merge' ? { deploy_on: 'merge' } : {}),
  };
}

export const MAX_BRANCH_LOOKUPS_PER_RUN = 50;
const BRANCH_MAX_AGE_MS = 30 * 24 * HOUR;

// PRs found by branch (ADR 0021): every open ticket whose captured work landed on a branch gets
// the PRs whose head is that branch, so one merge closes all the tickets it carried. One lookup
// per repository and branch per run; default branches are never looked up.
async function linkBranchPrs(worker, providers, now, updates, health) {
  const { state } = worker;
  const found = new Map();
  let lookups = 0;
  for (const ticket of state.tickets.values()) {
    if (ticket.status === 'done' || !Array.isArray(ticket.branches) || !ticket.branches.length) continue;
    const repo = repoFor(state, ticket.repo_id);
    if (!repo || !repo.canonical_path) continue;
    const provider = providers.for(repo);
    if (typeof provider.findPrs !== 'function') continue;
    for (const b of ticket.branches) {
      if ([repo.default_branch, 'main', 'master'].includes(b.name) || Date.parse(now) - Date.parse(b.last_seen) > BRANCH_MAX_AGE_MS) continue;
      if (ticket.prs.some((p) => p.head_branch === b.name)) continue;
      const key = `${repo.id}:${b.name}`;
      if (!found.has(key)) {
        if (lookups >= MAX_BRANCH_LOOKUPS_PER_RUN) continue;
        lookups += 1;
        const entry = health.get(provider.name) ?? { provider: provider.name, last_success_at: null, last_attempt_at: null, error: null };
        entry.last_attempt_at = now;
        try {
          found.set(key, await provider.findPrs(b.name, { cwd: repo.canonical_path }));
          entry.last_success_at = now;
          entry.error = null;
        } catch (err) {
          entry.error = err.message;
          found.set(key, []);
        }
        health.set(provider.name, entry);
      }
      for (const pr of found.get(key)) {
        if (ticket.prs.some((p) => p.url === pr.url) || updates.some((u) => u.ticket_id === ticket.id && u.url === pr.url)) continue;
        updates.push({ ticket_id: ticket.id, link: true, provider: provider.name, url: pr.url, ...pr, observed_at: now, error: null, evidence_id: `${pr.url}:${pr.state}:${pr.merged_at ?? ''}`, ...mergeContext(worker, repo, pr) });
      }
    }
  }
}

export async function runReconciliation(worker, { reason = 'scheduled', providers = defaultProviders(worker.config), run_id = uuid() } = {}) {
  worker.ingestOnce();
  const now = worker.now();
  const life = applyLifecycle(worker.state, now);
  const { updates, provider_health } = await pollProviders(worker, providers, now);
  worker.emit('reconcile', { reason, run_id, last_sync: now, provider_health, pr_updates: updates, lifecycle: { tickets: life.tickets.size, sessions: life.sessions.size } });
  for (const checkpoint_id of life.notify) worker.emit('notify', { checkpoint_id, reason: 'extinct-unpromoted' }, { source_identity: `notify:${checkpoint_id}` });
  worker.markGenerationDirty();
  worker.publishGeneration();
  return { run_id, last_sync: now, provider_health, pr_updates: updates, notified: life.notify.length };
}
