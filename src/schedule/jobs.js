// Job implementations for the scheduler; each returns a short summary for the Schedules panel.
import { runReconciliation } from '../reconcile/run.js';
import { catalogFor } from '../agents/recipes.js';
import { submitRequest } from '../server/requests.js';
import { repoFor } from '../core/state.js';
import { uuid } from '../lib/ids.js';
import path from 'node:path';
import { buildToday, localDate } from '../today/feed.js';
import { renderDigest, writeDigest, writeDigestFile } from '../today/digest.js';
import { stateDir, quillHome } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';
import { normalizePublishers, destinationOf, KIND_LABELS } from '../publish/config.js';
import { rowsFor } from '../publish/content.js';
import { publishMarkdown, publishHtml } from '../publish/writers.js';
import { publishArtifact } from '../publish/artifact.js';
import { createArtifactClient } from '../publish/artifact-client.js';

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

function previousDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function defaultArtifactClient(publisher, worker) {
  return createArtifactClient({ claudePath: worker.config.claude_path || 'claude', workRoot: path.join(quillHome(worker.env), 'publish', publisher.name, 'runs') });
}

export function createJobs({ providers, artifactClientFor = defaultArtifactClient }) {
  return {
    // Runs publishers (ADR 0010). A destination the owner has not confirmed is never sent anything:
    // the run records needs-confirmation until a publish request carries confirm.
    async publish(worker, { run_id, settings, trigger }) {
      const { publishers } = normalizePublishers(worker.config);
      const names = settings.publishers ?? (settings.publisher ? [settings.publisher] : null);
      const targets = names ? publishers.filter((p) => names.includes(p.name)) : publishers;
      if (settings.publisher && !targets.length) throw new Error(`no publisher named ${settings.publisher}`);
      if (!targets.length) return { summary: 'no publishers configured' };
      const snapshot = worker.getSnapshot();
      const indexPath = path.join(stateDir(worker.env), 'publish-index.json');
      const results = [];
      for (const p of targets) {
        const destination = destinationOf(p);
        const rec = worker.state.publishers.get(p.name);
        const confirmed = !!(rec && rec.confirmed.includes(destination));
        const base = { publisher: p.name, run_id, destination, trigger: trigger ?? 'manual', confirmed: !!settings.confirm };
        if (!confirmed && !settings.confirm) {
          const summary = `waiting for confirmation of the first publish to ${p.kind === 'artifact' ? (p.url ?? 'a new claude.ai artifact') : path.basename(p.path)}`;
          worker.emit('publish-run', { ...base, outcome: 'needs-confirmation', summary }, { source_identity: `publish-run:${run_id}:${p.name}` });
          results.push({ name: p.name, ok: true, summary });
          continue;
        }
        const now = worker.now();
        try {
          let out;
          if (p.kind === 'markdown') out = publishMarkdown(p, rowsFor(snapshot, p, { exportedAt: now }), { indexPath, now });
          else if (p.kind === 'html') out = publishHtml(p, snapshot, { now });
          else if (p.executor !== 'cli') {
            // The Artifact tools exist in Claude Code sessions, not in the worker: say what to run.
            worker.emit('publish-run', { ...base, outcome: 'needs-session', summary: `run /session-quill:publish ${p.name} in a Claude Code session to publish` }, { source_identity: `publish-run:${run_id}:${p.name}` });
            results.push({ name: p.name, ok: true, summary: `run /session-quill:publish ${p.name} in a Claude Code session to publish` });
            continue;
          } else {
            const sidecar = path.join(quillHome(worker.env), 'publish', p.name, 'state.json');
            const prior = readJsonIfExists(sidecar);
            out = await publishArtifact(p, rowsFor(snapshot, p, { exportedAt: now }), { client: artifactClientFor(p, worker), prior: prior && (!p.url || prior.url === p.url) ? prior : null, now });
            writeJsonAtomic(sidecar, out.state);
          }
          worker.emit('publish-run', { ...base, outcome: 'ok', summary: out.summary, url: out.url ?? null }, { source_identity: `publish-run:${run_id}:${p.name}` });
          results.push({ name: p.name, ok: true, summary: out.summary });
        } catch (err) {
          worker.log(`publish ${p.name} failed: ${err.stack ?? err.message}`);
          worker.emit('publish-run', { ...base, outcome: 'failed', error: err.message }, { source_identity: `publish-run:${run_id}:${p.name}` });
          results.push({ name: p.name, ok: false, error: err.message });
        }
      }
      if (results.every((r) => !r.ok)) throw new Error(results.map((r) => `${r.name}: ${r.error}`).join('; '));
      return { summary: results.map((r) => `${r.name} (${KIND_LABELS[targets.find((t) => t.name === r.name).kind].toLowerCase()}): ${r.ok ? r.summary : `failed: ${r.error}`}`).join('; ') };
    },
    async reconcile(worker, { run_id, reason }) {
      const r = await runReconciliation(worker, { reason, providers, run_id });
      const errors = r.provider_health.filter((h) => h.error).length;
      const checks = r.pr_updates.length;
      return { summary: `${checks} PR check${checks === 1 ? '' : 's'}${errors ? `, ${errors} provider error${errors === 1 ? '' : 's'}` : ''}`, last_sync: r.last_sync };
    },
    // Writes one store-local day of the Today feed as markdown (ADR 0009): into the store's daily
    // note, a file, or both. Never overwrites a digest section someone edited.
    async digest(worker, { settings, due_at = null }) {
      // The day comes from the slot the run is for, so a run caught up the next morning still
      // writes the evening it missed.
      const feed = buildToday(worker.state, { nowIso: worker.now(), days: 9 });
      const slotDay = localDate(due_at ?? worker.now(), worker.state.meta.timezone || 'UTC');
      const date = settings.day === 'yesterday' ? previousDate(slotDay) : slotDay;
      const day = feed.days.find((d) => d.date === date) ?? { date, tickets: [], sessions: 0 };
      const pendingDeployments = [];
      for (const t of worker.state.tickets.values()) for (const d of t.deployments ?? []) if (d.state === 'pending') pendingDeployments.push({ ticket_key: t.key, environment: d.environment });
      pendingDeployments.sort((a, b) => (a.ticket_key < b.ticket_key ? -1 : a.ticket_key > b.ticket_key ? 1 : a.environment < b.environment ? -1 : a.environment > b.environment ? 1 : 0));
      const markdown = renderDigest(day, { pendingDeployments });
      const indexPath = path.join(stateDir(worker.env), 'digest-index.json');
      const written = [];
      if (settings.to.includes('vault-daily')) written.push(writeDigest({ dir: path.join(worker.config.store_path, 'daily'), date, markdown, indexPath }).path);
      if (settings.to.includes('file')) written.push(writeDigestFile({ file: path.resolve(settings.path), markdown, indexPath }).path);
      const n = written.length;
      const tickets = day.tickets.length;
      return { summary: `wrote ${n} digest${n === 1 ? '' : 's'} for ${date} (${tickets} ticket${tickets === 1 ? '' : 's'})` };
    },
    // Queues a recipe run for each ticket in scope (ADR 0008). Scheduled runs never get more than
    // read access, so nothing unattended can edit, commit, push or open a PR.
    async agent(worker, { schedule, settings }) {
      const { recipe: name, scope, limit } = settings;
      const catalog = catalogFor(worker);
      const active = new Set([...worker.state.handoffs.values()].filter((h) => ['queued', 'running'].includes(h.state)).map((h) => h.ticket_id));
      const tickets = [...worker.state.tickets.values()].filter((t) => inAgentScope(t, scope))
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.key < b.key ? -1 : 1));
      let queued = 0;
      let busy = 0;
      let over = 0;
      let unusable = 0;
      let usable = 0;
      let firstError = null;
      for (const t of tickets) {
        // The effective recipe depends on the ticket's repository, so it is checked per ticket: one
        // ticket without it is skipped and counted, never the end of the run.
        let recipe;
        try { recipe = schedulableRecipe(catalog, name, t.repo_id ?? null); } catch (err) { unusable += 1; firstError = firstError ?? err.message; continue; }
        usable += 1;
        if (active.has(t.id)) { busy += 1; continue; }
        if (queued >= limit) { over += 1; continue; }
        const permissions = { ...NO_PERMISSIONS, read_source: !!(recipe.permissions.read_source && repoFor(worker.state, t.repo_id)) };
        // suggest: nobody is present, so even the built-in modes leave suggestions instead of edits.
        submitRequest(worker, { id: uuid(), kind: 'handoff', target_id: t.id, expected_revision: t.revision, payload: { recipe: name, note: `scheduled by ${schedule}`, permissions, suggest: true } }, { actor: `schedule:${schedule}` });
        queued += 1;
      }
      if (!usable && unusable) throw new Error(`no ticket in scope has a usable recipe named ${name} (${firstError})`);
      const notes = [busy ? `${busy} already running` : null, over ? `${over} over the limit` : null, unusable ? `${unusable} without a usable recipe` : null].filter(Boolean);
      return { summary: `queued ${queued} ${name} run${queued === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}` };
    },
  };
}
