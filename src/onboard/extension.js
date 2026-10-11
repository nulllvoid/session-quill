// Runs the dashboard's repo-clone requests (ADR 0024), one at a time: plan again against the
// current config and disk, clone (or reuse a clone that exists), register it in config.toml like
// `quill repo add`, and link the ticket. A request names the remote the owner saw and confirmed.
import { planClone, executeClone, registerClone, runGit, sweepPartials } from './clone.js';
import { onboardSettings } from './settings.js';

export function createExtension(ctx, { git = runGit, originOf = null, timeoutMs } = {}) {
  let running = null;
  let controller = null;

  const fail = (worker, req, err) => worker.emit('request-tx', { request_id: req.id, outcome: 'failed', error: { code: err.code ?? 'clone-failed', message: err.message, retryable: !!err.retryable, current_revision: null } }, { source_identity: `request-tx:${req.id}:failed` });

  async function perform(worker, req) {
    const ticket = worker.state.tickets.get(req.target_id);
    try {
      const plan = await planClone({ config: worker.config, ticket, url: req.payload.url, ...(originOf ? { originOf } : {}) });
      let repoId = plan.repo_id ?? null;
      if (plan.action !== 'link') {
        const dir = await executeClone(plan, { git, signal: controller.signal, ...(timeoutMs ? { timeoutMs } : {}) });
        repoId = registerClone(worker.env, dir, { projectId: plan.project_id });
        worker.reloadConfig();
      }
      const { result } = worker.emit('ticket-update', { ticket_id: ticket.id, fields: { repo_id: repoId }, source: 'clone' }, { ticket_id: ticket.id });
      if (result.rejected) throw Object.assign(new Error(`the clone is registered as ${repoId}, but linking ${ticket.key} was refused (${result.rejected}); link it with quill ticket set ${ticket.key} --repo ${repoId}`), { code: result.rejected });
      worker.emit('request-tx', { request_id: req.id, outcome: 'applied', result: { action: plan.action, repo_id: repoId, remote: plan.remote }, mutation: { type: 'repo-clone' } }, { source_identity: `request-tx:${req.id}:applied` });
      worker.log(`repo-clone: ${plan.action} ${plan.remote} for ${ticket.key} as ${repoId}`);
    } catch (err) {
      worker.log(`repo-clone for ${ticket ? ticket.key : req.target_id} failed: ${err.message}`);
      fail(worker, req, err);
    }
  }

  return {
    name: 'onboard',
    async idle() { while (running) await running; },
    onStart(worker) {
      // A clone interrupted by a stop or crash never finished: say so, and remove its partial folder.
      try {
        const removed = sweepPartials(onboardSettings(worker.config.tracker).auto_clone_dir);
        if (removed) worker.log(`repo-clone: removed ${removed} unfinished clone folder${removed === 1 ? '' : 's'}`);
      } catch (err) { worker.log(`repo-clone: sweeping unfinished clones failed: ${err.message}`); }
      for (const req of [...worker.state.requests.values()]) {
        if (req.kind === 'repo-clone' && req.state === 'applying') fail(worker, req, { code: 'interrupted', message: 'the worker stopped before this clone finished; try again', retryable: true });
      }
    },
    tick(worker) {
      if (running) return;
      const now = worker.now();
      const req = [...worker.state.requests.values()].find((r) => r.kind === 'repo-clone' && r.state === 'pending' && (r.not_before ?? now) <= now);
      if (!req) return;
      worker.emit('request-tx', { request_id: req.id, outcome: 'applying' }, { source_identity: `request-tx:${req.id}:applying` });
      worker.publishRequest(req.id);
      controller = new AbortController();
      running = perform(worker, req).finally(() => { running = null; controller = null; worker.publishRequest(req.id); worker.markGenerationDirty(); });
    },
    async onStop() {
      if (controller) controller.abort();
      if (running) await running;
    },
  };
}
