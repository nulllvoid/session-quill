// Job implementations for the scheduler; each returns a short summary for the Schedules panel.
import { runReconciliation } from '../reconcile/run.js';

export function createJobs({ providers }) {
  return {
    async reconcile(worker, { run_id, reason }) {
      const r = await runReconciliation(worker, { reason, providers, run_id });
      const errors = r.provider_health.filter((h) => h.error).length;
      const checks = r.pr_updates.length;
      return { summary: `${checks} PR check${checks === 1 ? '' : 's'}${errors ? `, ${errors} provider error${errors === 1 ? '' : 's'}` : ''}`, last_sync: r.last_sync };
    },
  };
}
