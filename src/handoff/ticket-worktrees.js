// Teardown of ticket worktrees (ADR 0036, FR-1.3), run by the worker at start (without holding the
// start up) and then at most once an hour from its tick. A done ticket's worktree is removed once it is clean, `keep_days` have
// passed and no live session uses it; a dirty one, or one whose copied ignored files (`.env`) differ
// from the repository's, is kept and reported once. The branch is always
// kept (ADR 0021 finds PRs by branch). Nothing here ever forces a removal.
import fs from 'node:fs';
import path from 'node:path';
import { quillHome } from '../lib/paths.js';
import { HOUR } from '../lib/time.js';
import { worktreeConfig } from '../config/config.js';
import { teardownPlan, worktreeIdentity, KEPT_REASONS } from '../core/worktrees.js';
import { removeCleanWorktree, isUnder } from './worktree.js';

export const SWEEP_INTERVAL_MS = HOUR;

export const ticketWorktreesRoot = (env) => path.join(quillHome(env), 'worktrees');

function emitOnce(worker, payload) {
  const source_identity = worktreeIdentity(payload);
  if (worker.state.appliedSources.has(source_identity)) return null;
  return worker.emit('worktree', payload, { ticket_id: payload.ticket_id, source_identity });
}

/** One sweep over every ticket worktree the journal knows; returns what it did, for logs and tests. */
export async function sweepTicketWorktrees(worker, config, { removeFn = removeCleanWorktree } = {}) {
  const { keep_days, copy } = worktreeConfig(config);
  const root = ticketWorktreesRoot(worker.env);
  const out = { pruned: [], kept: [], skipped: [] };
  const plan = teardownPlan(worker.state.tickets.values(), worker.state.sessions.values(), { nowIso: worker.now(), keepDays: keep_days });
  for (const item of plan) {
    if (!item.due) continue;
    const { record } = item;
    const base = { ticket_id: item.ticket_id, mount_id: record.id, path: record.path };
    // The path comes from the journal: only a folder inside this home's worktrees root is ever touched.
    if (!isUnder(root, record.path)) { out.skipped.push({ ...base, reason: 'outside-worktrees-root' }); worker.log(`ticket worktree outside ${root}, not removed: ${item.key}`); continue; }
    const repo = config.repos && config.repos[record.repo_id];
    const repoPath = repo && repo.canonical_path;
    if (!repoPath || !fs.existsSync(repoPath)) { out.skipped.push({ ...base, reason: 'repository-missing' }); continue; }
    // A ticket reopened while git ran keeps its worktree.
    const ticket = worker.state.tickets.get(item.ticket_id);
    if (!ticket || ticket.status !== 'done') continue;
    let r;
    try { r = await removeFn({ repoPath, dir: record.path, root, copy }); } catch (err) { r = { removed: false, reason: 'remove-failed', message: err.message }; }
    try {
      if (r.removed) {
        emitOnce(worker, { op: 'pruned', ...base, repo_id: record.repo_id, branch: record.branch, base_sha: record.base_sha, ...(r.missing ? { reason: 'missing' } : {}) });
        out.pruned.push(base);
      } else if (KEPT_REASONS.includes(r.reason)) {
        if (record.state !== 'kept') emitOnce(worker, { op: 'kept', ...base, repo_id: record.repo_id, branch: record.branch, base_sha: record.base_sha, reason: r.reason });
        out.kept.push({ ...base, reason: r.reason });
      } else {
        out.skipped.push({ ...base, reason: r.reason });
        worker.log(`ticket worktree for ${item.key} not removed (${r.reason}${r.message ? `: ${r.message}` : ''}); will retry`);
      }
    } catch (err) {
      // A stop closed the journal while git ran; the next sweep tries again.
      out.skipped.push({ ...base, reason: 'emit-failed' });
      worker.log(`ticket worktree event not recorded: ${err.message}`);
    }
  }
  return out;
}

/** A sweep that runs at most once per `intervalMs` from the tick, one at a time. */
export function createTicketWorktreeSweep({ intervalMs = SWEEP_INTERVAL_MS, removeFn } = {}) {
  let last = -Infinity;
  let inFlight = null;
  const run = (worker, config) => {
    if (inFlight) return inFlight;
    last = Date.parse(worker.now());
    inFlight = sweepTicketWorktrees(worker, config, removeFn ? { removeFn } : {})
      .catch((err) => {
        const error = `ticket worktree sweep failed: ${err.message}`;
        worker.log(error);
        if (typeof worker.recordHealthError === 'function') worker.recordHealthError({ kind: 'worktree-sweep', error });
        return null;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    run,
    tick(worker, config) {
      if (inFlight || Date.parse(worker.now()) - last < intervalMs) return;
      run(worker, config);
    },
    idle: () => inFlight ?? Promise.resolve(),
  };
}
