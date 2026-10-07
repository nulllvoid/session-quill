// Worker extension that dispatches queued handoffs, enforces the 20-minute wall-clock cap,
// honours cancellation, and resolves runs interrupted by a restart (TRD §Handoff execution).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nextDispatchable } from './reserve.js';
import { validateHandoffRequest } from './permissions.js';
import { createWorktree, headCommit, changedFiles, diffPatch, commitAll, pushBranch, openDraftPr } from './worktree.js';
import { buildPrompt, allowedToolsFor, parseAgentResult, spawnAgent, killTree, repairPrompt, SELF_CHECK_PROMPT } from './runner.js';
import { gatherContext, gatherDiff } from './context.js';
import { catalogFor, renderRecipe, recipeTools } from '../agents/recipes.js';
import { recordResult, updateHandoff } from './results.js';
import { handoffsDir, logsDir } from '../lib/paths.js';
import { addMs, MINUTE } from '../lib/time.js';
import { readJsonIfExists } from '../lib/atomic-fs.js';

export const HANDOFF_DEADLINE_MS = 20 * MINUTE;

function detectRuntime(claudePath) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [claudePath], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return fs.existsSync(claudePath);
  }
}

export function createExtension(ctx, { claudePath = 'claude', claudeArgs = [], spawnEnv = {}, deadlineMs = HANDOFF_DEADLINE_MS, maxConcurrent = 2, runtimeAvailable, model = null } = {}) {
  const running = new Map(); // handoff id -> { child, done, reason }
  let paused = false;

  function fail(worker, h, code, message, extra = {}) {
    recordResult(worker, h.id, { summary: null }, { state: 'failed', error: { code, message }, extra });
  }

  // A follow-up turn in the same runtime session. It is tracked like the first turn, so the
  // deadline and cancellation stop it too; null means it did not finish cleanly.
  async function followUp(entry, prompt, { tools, maxTurns }) {
    let run;
    try {
      run = spawnAgent({ claudePath, claudeArgs, prompt, cwd: entry.cwd, tools, env: entry.env, permissions: entry.permissions, logPath: entry.logPath, model, resume: entry.sessionId, maxTurns });
    } catch {
      return null;
    }
    entry.child = run.child;
    entry.done = run.done;
    const outcome = await run.done;
    if (entry.reason || outcome.error || outcome.code !== 0) return null;
    return outcome;
  }

  // ADR 0013: one repair turn when the reply broke its contract, then the recipe's optional
  // self-check. Each needs the session to resume and a minute left before the deadline; a turn
  // that fails or makes things worse leaves the earlier reply in place.
  async function improve(worker, entry, outcome) {
    const quality = { problems: [], repaired: false, self_checked: false };
    let parsed = parseAgentResult(outcome.stdout);
    quality.problems = parsed.problems;
    entry.sessionId = parsed.session_id;
    const timeLeft = () => !entry.deadlineAt || Date.parse(entry.deadlineAt) - Date.parse(worker.now()) >= 60_000;
    if (parsed.is_error || !entry.sessionId) return { outcome, quality };
    if (parsed.problems.length && timeLeft()) {
      const next = await followUp(entry, repairPrompt(parsed.problems), { tools: entry.tools, maxTurns: 2 });
      const fixed = next ? parseAgentResult(next.stdout) : null;
      if (fixed && !fixed.is_error && fixed.problems.length < parsed.problems.length) {
        outcome = next;
        parsed = fixed;
        quality.repaired = true;
        quality.problems = fixed.problems;
      }
    }
    if (entry.selfCheck && !parsed.problems.length && !entry.reason && timeLeft()) {
      // The check re-reads sources; it never edits, whatever the run was allowed to do.
      const readOnly = allowedToolsFor({ mode: 'analyse', permissions: { read_source: !!entry.permissions.read_source } });
      const next = await followUp(entry, SELF_CHECK_PROMPT, { tools: readOnly, maxTurns: 12 });
      const checked = next ? parseAgentResult(next.stdout) : null;
      if (checked && !checked.is_error && !checked.problems.length) {
        outcome = next;
        quality.self_checked = true;
      }
    }
    return { outcome, quality };
  }

  async function finish(worker, h, run, outcome) {
    const entry = running.get(h.id);
    const current = worker.state.handoffs.get(h.id);
    if (!current || !['running'].includes(current.state)) { running.delete(h.id); return; }
    let quality = null;
    if (entry && !entry.reason && !outcome.error && outcome.code === 0) {
      const first = outcome;
      ({ outcome, quality } = await improve(worker, entry, outcome));
      // A deadline or cancellation during a follow-up keeps the first reply as the partial result.
      if (entry.reason) outcome = first;
    }
    running.delete(h.id);
    const reason = entry ? entry.reason : null;
    if (reason === 'timeout') { recordResult(worker, h.id, parseAgentResult(outcome.stdout), { state: 'timed-out', error: { code: 'timeout', message: `execution exceeded ${Math.round(deadlineMs / 60000)} min wall clock` }, extra: await fixExtras(worker, current) }); return; }
    if (reason === 'cancel') { recordResult(worker, h.id, parseAgentResult(outcome.stdout), { state: 'cancelled', error: { code: 'cancelled', message: 'cancelled by owner' }, extra: await fixExtras(worker, current) }); return; }
    if (reason === 'stopped') { recordResult(worker, h.id, parseAgentResult(outcome.stdout), { state: 'failed', error: { code: 'interrupted', message: 'worker stopped while the run was in progress' }, extra: await fixExtras(worker, current) }); return; }
    if (outcome.error) { fail(worker, current, outcome.error.code === 'ENOENT' ? 'runtime-missing' : 'spawn-failed', outcome.error.message); return; }
    const resultFile = path.join(handoffsDir(worker.env), 'results', `${h.id}.result.json`);
    const explicit = readJsonIfExists(resultFile);
    const parsed = explicit ? { ...parseAgentResult(''), ...explicit, raw: outcome.stdout } : parseAgentResult(outcome.stdout);
    if (outcome.code !== 0) { recordResult(worker, h.id, parsed, { state: 'failed', error: { code: 'agent-exit', message: `agent exited with exit code ${outcome.code}${outcome.signal ? ` (signal ${outcome.signal})` : ''}` }, extra: await fixExtras(worker, current) }); return; }
    if (parsed.is_error) { recordResult(worker, h.id, parsed, { state: 'failed', error: { code: 'agent-error', message: parsed.summary ?? 'agent reported an error' }, extra: await fixExtras(worker, current) }); return; }
    const extras = await fixExtras(worker, current, { finalize: true });
    if (quality) extras.result_quality = { ...quality, problems: explicit ? [] : parsed.problems };
    recordResult(worker, h.id, parsed, { state: extras.error ? 'failed' : 'done', error: extras.error ?? null, extra: extras });
  }

  // For fix runs: collect changed files and a patch; perform explicitly permitted commit/push/PR.
  async function fixExtras(worker, h, { finalize = false } = {}) {
    const out = {};
    if (!h.worktree_path || !fs.existsSync(h.worktree_path)) return out;
    try {
      out.changed_files = await changedFiles(h.worktree_path);
      const patch = await diffPatch(h.worktree_path);
      const patchPath = path.join(handoffsDir(worker.env), 'results', `${h.id}.patch`);
      fs.mkdirSync(path.dirname(patchPath), { recursive: true });
      fs.writeFileSync(patchPath, patch);
      out.patch_path = patchPath;
    } catch (err) {
      out.uncertain_effects = [...(h.uncertain_effects ?? []), `could not collect diff: ${err.message}`];
      return out;
    }
    if (!finalize || !out.changed_files.length) return out;
    const p = h.permissions ?? {};
    const repo = ctx.config.repos[h.repo_id] ? { id: h.repo_id, ...ctx.config.repos[h.repo_id] } : null;
    try {
      if (p.commit) out.commit_sha = await commitAll(h.worktree_path, `handoff(${h.id.slice(0, 8)}): ${h.note || 'attempt fix'}`);
      if (p.push_branch && out.commit_sha) {
        try { await pushBranch(h.worktree_path, h.branch, repo); out.branch = h.branch; } catch (err) { out.uncertain_effects = [...(h.uncertain_effects ?? []), `push may have partially happened: ${err.message}`]; out.error = { code: 'push-failed', message: err.message }; return out; }
        if (p.open_draft_pr) {
          try { out.pr_url = await openDraftPr(h.worktree_path, { branch: h.branch, base: repo ? repo.default_branch : 'main', title: `Handoff: ${h.note || h.id.slice(0, 8)}`, body: `Draft opened by Session Quill handoff ${h.id} for ticket ${h.ticket_id}. Not a deployment.` }); } catch (err) { out.uncertain_effects = [...(h.uncertain_effects ?? []), `draft PR creation uncertain: ${err.message}`]; }
        }
      }
    } catch (err) {
      out.error = { code: 'commit-failed', message: err.message };
    }
    return out;
  }

  async function dispatch(worker, h) {
    const ticket = worker.state.tickets.get(h.ticket_id);
    if (!ticket) return fail(worker, h, 'ticket-missing', 'ticket no longer exists');
    const repoCfg = ctx.config.repos[h.repo_id] ? { id: h.repo_id, ...ctx.config.repos[h.repo_id] } : null;
    // The recipe must still be the one that was queued: an edited file could otherwise run with
    // instructions or permissions nobody reviewed (ADR 0008).
    const catalog = catalogFor(worker);
    // Runs queued before recipes existed have no recipe reference and use the built-in of their mode.
    const recipe = !h.recipe || h.recipe.source === 'builtin' ? catalog.builtin(h.recipe ? h.recipe.name : h.mode) : catalog.get(h.recipe.name, h.repo_id ?? null, { fresh: true });
    if (h.recipe && (!recipe || recipe.error || recipe.hash !== h.recipe.hash)) return fail(worker, h, 'recipe-changed', `recipe ${h.recipe.name} changed or was removed after this run was queued; review it and queue a new run`);
    try {
      validateHandoffRequest({ mode: h.mode, note: h.note, permissions: h.permissions, branch: h.branch, ...(h.recipe ? { recipe: h.recipe.name } : {}) }, { repo: repoCfg, recipe: h.recipe ? recipe : null });
    } catch (err) {
      return fail(worker, h, err.code ?? 'permission-invalid', err.message);
    }
    const available = runtimeAvailable ?? detectRuntime(claudePath);
    if (!available) return fail(worker, h, 'runtime-missing', `Claude Code runtime (${claudePath}) is not installed or not on PATH; install and authenticate it, then retry as a new run`);
    const needsSource = h.permissions && h.permissions.read_source;
    let cwd;
    let baseCommit = null;
    let worktreePath = null;
    if (needsSource) {
      if (!repoCfg || !repoCfg.canonical_path || !fs.existsSync(repoCfg.canonical_path)) return fail(worker, h, 'repo-unavailable', 'source access requires the registered repository on this owner machine; it is not available');
      try {
        baseCommit = await headCommit(repoCfg.canonical_path);
        worktreePath = path.join(handoffsDir(worker.env), 'worktrees', h.id);
        await createWorktree({ repoPath: repoCfg.canonical_path, baseCommit, dir: worktreePath });
      } catch (err) {
        return fail(worker, h, err.code === 'worktree-failed' ? 'worktree-failed' : 'source-failed', err.message);
      }
      cwd = worktreePath;
    } else {
      cwd = path.join(handoffsDir(worker.env), 'sandbox', h.id);
      fs.mkdirSync(cwd, { recursive: true });
    }
    const logPath = path.join(logsDir(worker.env), 'handoffs', `${h.id}.log`);
    const started = worker.now();
    const deadlineAt = addMs(started, Math.min(deadlineMs, h.deadline_ms ?? Infinity));
    updateHandoff(worker, h.id, { state: 'running', started_at: started, deadline_at: deadlineAt, base_commit: baseCommit, worktree_path: worktreePath, log_path: logPath });
    const current = worker.state.handoffs.get(h.id);
    const url = (ticket.external && ticket.external.url) || (ticket.jira && ticket.jira.url) || null;
    const environments = worker.environmentsFor ? worker.environmentsFor(ticket.repo_id) : repoCfg ? repoCfg.deployment_environments ?? [] : [];
    const render = (r) => renderRecipe(r, { ticket, url, note: h.note, prs: ticket.prs ?? [], deployments: ticket.deployments ?? [], environments });
    const context = gatherContext(worker.state, ticket, { env: worker.env, currentId: h.id });
    const inputs = !recipe || recipe.legacy ? null : new Set(recipe.inputs);
    // The diff is read from the run's own checkout, so it exists only with source access.
    if (worktreePath && (!inputs || inputs.has('work'))) context.diff = await gatherDiff(worktreePath, context.commits);
    const prompt = buildPrompt(current, ticket, { repo: repoCfg, recipe, render, context });
    const tools = recipe ? recipeTools(recipe, h.permissions ?? {}) : allowedToolsFor({ mode: h.mode, permissions: h.permissions });
    const env = { ...spawnEnv, QUILL_HANDOFF_ID: h.id, QUILL_HANDOFF_TICKET_ID: ticket.id, QUILL_HANDOFF_TICKET_KEY: ticket.key };
    if (ctx.env && ctx.env.QUILL_HOME) env.QUILL_HOME = ctx.env.QUILL_HOME;
    let run;
    try {
      run = spawnAgent({ claudePath, claudeArgs, prompt, cwd, tools, env, permissions: h.permissions ?? {}, logPath, model });
    } catch (err) {
      return fail(worker, h, 'spawn-failed', err.message);
    }
    running.set(h.id, { child: run.child, done: run.done, reason: null, deadlineAt, cwd, env, tools, logPath, permissions: h.permissions ?? {}, selfCheck: !!(recipe && recipe.self_check), sessionId: null });
    run.done.then((outcome) => finish(worker, current, run, outcome)).catch((err) => worker.log(`handoff finish failed: ${err.stack ?? err.message}`));
  }

  function killWithReason(id, reason) {
    const entry = running.get(id);
    if (!entry) return;
    entry.reason = reason;
    killTree(entry.child);
  }

  return {
    name: 'handoff',
    pause() { paused = true; },
    resume() { paused = false; },
    runningIds: () => new Set(running.keys()),
    async onStart(worker) {
      worker.recipeInfo = () => catalogFor(worker).list();
      for (const h of [...worker.state.handoffs.values()]) {
        if (h.state === 'running') recordResult(worker, h.id, { summary: null }, { state: 'failed', error: { code: 'interrupted', message: 'worker restarted while the run was in progress; no automatic rerun' } });
      }
    },
    tick(worker) {
      if (paused) return;
      const now = worker.now();
      for (const h of worker.state.handoffs.values()) {
        if (h.cancel_requested && h.state === 'running' && running.has(h.id) && running.get(h.id).reason === null) killWithReason(h.id, 'cancel');
      }
      for (const [id, entry] of running) {
        if (entry.reason === null && entry.deadlineAt && now >= entry.deadlineAt) killWithReason(id, 'timeout');
      }
      if (running.size >= maxConcurrent) return;
      for (const h of nextDispatchable(worker.state, { running: new Set(running.keys()) })) {
        if (running.size >= maxConcurrent) break;
        running.set(h.id, { child: null, done: null, reason: null, deadlineAt: null });
        dispatch(worker, h).then(() => { if (running.has(h.id) && !running.get(h.id).child) running.delete(h.id); }).catch((err) => { running.delete(h.id); worker.log(`dispatch failed: ${err.stack ?? err.message}`); fail(worker, h, 'dispatch-failed', err.message); });
      }
    },
    async onStop(worker, { abandonRuns = false } = {}) {
      if (abandonRuns) { running.clear(); return; }
      const pending = [];
      for (const [id, entry] of running) {
        if (entry.child) { killWithReason(id, 'stopped'); pending.push(entry.done); }
      }
      await Promise.all(pending);
      // give finish() handlers a tick to journal their outcomes
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}
