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
  for (const ticket of state.tickets.values()) {
    if (ticket.status === 'done' && !ticket.deployments.some((d) => d.state === 'pending')) continue;
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
        updates.push({ ticket_id: ticket.id, pr_id: pr.id, url: pr.url, ...result, observed_at: result.observed_at ?? now, error: null, evidence_id: `${pr.url}:${result.state}:${result.merged_at ?? ''}` });
      } catch (err) {
        entry.error = err.message;
        updates.push({ ticket_id: ticket.id, pr_id: pr.id, url: pr.url, error: err.message });
      }
      health.set(provider.name, entry);
    }
  }
  return { updates, provider_health: [...health.values()] };
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
