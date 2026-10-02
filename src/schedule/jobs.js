// Job implementations for the scheduler; each returns a short summary for the Schedules panel.
import { runReconciliation } from '../reconcile/run.js';
import { catalogFor } from '../agents/recipes.js';
import { submitRequest } from '../server/requests.js';
import { repoFor } from '../core/state.js';
import { uuid } from '../lib/ids.js';

const NO_PERMISSIONS = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };

export function inAgentScope(ticket, scope) {
  if (scope === 'deploy-pending') return ticket.status === 'deploy-pending' || (ticket.deployments ?? []).some((d) => d.state === 'pending');
  if (scope === 'open') return ticket.status !== 'done';
  return ticket.status === scope;
}

function schedulableRecipe(catalog, name, repoId) {
  const recipe = catalog.get(name, repoId, { fresh: true });
  if (!recipe) throw new Error(`no recipe named ${name}`);
  if (recipe.error) throw new Error(`recipe ${name} is invalid: ${recipe.error}`);
  if (!recipe.schedulable) throw new Error(`${name} edits source and cannot run on a schedule`);
  return recipe;
}

export function createJobs({ providers }) {
  return {
    async reconcile(worker, { run_id, reason }) {
      const r = await runReconciliation(worker, { reason, providers, run_id });
      const errors = r.provider_health.filter((h) => h.error).length;
      const checks = r.pr_updates.length;
      return { summary: `${checks} PR check${checks === 1 ? '' : 's'}${errors ? `, ${errors} provider error${errors === 1 ? '' : 's'}` : ''}`, last_sync: r.last_sync };
    },
    // Queues a recipe run for each ticket in scope (ADR 0008). Scheduled runs never get more than
    // read access, so nothing unattended can edit, commit, push or open a PR.
    async agent(worker, { schedule, settings }) {
      const { recipe: name, scope, limit } = settings;
      const catalog = catalogFor(worker);
      const global = catalog.get(name, null, { fresh: true });
      if (global) schedulableRecipe(catalog, name, null);
      const active = new Set([...worker.state.handoffs.values()].filter((h) => ['queued', 'running'].includes(h.state)).map((h) => h.ticket_id));
      const tickets = [...worker.state.tickets.values()].filter((t) => inAgentScope(t, scope))
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.key < b.key ? -1 : 1));
      let queued = 0;
      let busy = 0;
      let over = 0;
      for (const t of tickets) {
        if (active.has(t.id)) { busy += 1; continue; }
        if (queued >= limit) { over += 1; continue; }
        const recipe = schedulableRecipe(catalog, name, t.repo_id ?? null);
        const permissions = { ...NO_PERMISSIONS, read_source: !!(recipe.permissions.read_source && repoFor(worker.state, t.repo_id)) };
        submitRequest(worker, { id: uuid(), kind: 'handoff', target_id: t.id, expected_revision: t.revision, payload: { recipe: name, note: `scheduled by ${schedule}`, permissions } }, { actor: `schedule:${schedule}` });
        queued += 1;
      }
      const notes = [busy ? `${busy} already running` : null, over ? `${over} over the limit` : null].filter(Boolean);
      return { summary: `queued ${queued} ${name} run${queued === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}` };
    },
  };
}
