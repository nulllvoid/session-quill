// Worker extension: two-hour cadence (all days, store time zone via UTC instants), catch-up on
// start/wake, and immediate runs for refresh requests (TRD §Reconciliation, §Local dashboard).
import { uuid } from '../lib/ids.js';
import { runReconciliation, isSyncDue } from './run.js';
import { defaultProviders } from './providers/index.js';

export function createExtension(ctx, { providers } = {}) {
  const prov = providers ?? defaultProviders(ctx.config);
  let running = null;
  let activeRunId = null;

  function pendingRefresh(worker, now) {
    return [...worker.state.requests.values()].filter((r) => r.kind === 'refresh' && r.state === 'pending' && (r.not_before ?? now) <= now);
  }

  return {
    name: 'reconcile',
    get activeRunId() { return activeRunId; },
    idle: () => running ?? Promise.resolve(),
    tick(worker) {
      if (running) return;
      const now = worker.now();
      const refreshes = pendingRefresh(worker, now);
      const due = isSyncDue(worker.state, now);
      if (!refreshes.length && !due) return;
      const run_id = uuid();
      activeRunId = run_id;
      for (const r of refreshes) worker.emit('request-tx', { request_id: r.id, outcome: 'applying' }, { source_identity: `request-tx:${r.id}:applying` });
      running = (async () => {
        try {
          const result = await runReconciliation(worker, { reason: refreshes.length ? 'refresh' : 'scheduled', providers: prov, run_id });
          for (const r of refreshes) worker.emit('request-tx', { request_id: r.id, outcome: 'applied', result: { run_id, last_sync: result.last_sync }, mutation: { type: 'refresh' } }, { source_identity: `request-tx:${r.id}:applied` });
        } catch (err) {
          worker.log(`reconciliation failed: ${err.stack ?? err.message}`);
          for (const r of refreshes) worker.emit('request-tx', { request_id: r.id, outcome: 'failed', error: { code: 'reconcile-failed', message: err.message, retryable: true, current_revision: null } }, { source_identity: `request-tx:${r.id}:failed` });
        } finally {
          running = null;
          activeRunId = null;
          worker.markGenerationDirty();
        }
      })();
    },
  };
}
