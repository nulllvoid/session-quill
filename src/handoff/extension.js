// Worker extension that dispatches queued handoffs, enforces the 20-minute wall-clock cap,
// honours cancellation, and resolves runs interrupted by a restart (TRD §Handoff execution).
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nextDispatchable } from './reserve.js';
import { validateHandoffRequest } from './permissions.js';
import { createWorktree, headCommit, changedFiles, diffPatch, commitAll, pushBranch, openDraftPr } from './worktree.js';
import { buildPrompt, allowedToolsFor, selfCheckTools, runtimeAccess, parseAgentResult, spawnAgent, killTree, repairPrompt, SELF_CHECK_PROMPT, childEnvFor } from './runner.js';
import { runTestCommand, testGateSettings, testRepairPrompt } from './test-gate.js';
import { gatherContext, gatherDiff } from './context.js';
import { stageFiles, applyFileRun } from './files.js';
import { catalogFor, renderRecipe, recipeTools } from '../agents/recipes.js';
import { recordResult, updateHandoff } from './results.js';
import { handoffsDir, logsDir } from '../lib/paths.js';
import { addMs, MINUTE } from '../lib/time.js';
import { readJsonIfExists } from '../lib/atomic-fs.js';

export const HANDOFF_DEADLINE_MS = 20 * MINUTE;
export const DEFAULT_CONCURRENCY = { readonly: 2, fix: 1 };

// How many runs may execute at once (ADR 0023): runs that may edit source count against
// `[handoff] max_concurrent_fix`, every other run against `max_concurrent_readonly`. A value that
// is not a positive integer keeps the default.
export function concurrencyLimits(config = {}) {
  const h = config && config.handoff && typeof config.handoff === 'object' ? config.handoff : {};
  const pick = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return { readonly: pick(h.max_concurrent_readonly, DEFAULT_CONCURRENCY.readonly), fix: pick(h.max_concurrent_fix, DEFAULT_CONCURRENCY.fix) };
}

// What a draft PR says about tests: "passed (worker)" only after a real pass of the gate.
export function gateLine(gate) {
  if (gate && gate.status === 'passed') return `Tests passed (worker): \`${gate.command}\` exited 0${gate.repaired ? ' after one repair turn' : ''}.`;
  return 'Not test-verified by the worker: no test command is configured for this repository.';
}

const isFix = (h) => !!(h.permissions && h.permissions.edit_source);

function detectRuntime(claudePath) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [claudePath], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return fs.existsSync(claudePath);
  }
}

export function createExtension(ctx, { claudePath = 'claude', claudeArgs = [], spawnEnv = {}, deadlineMs = HANDOFF_DEADLINE_MS, maxConcurrent, maxReadonly, maxFix, runtimeAvailable, model = null } = {}) {
  const running = new Map(); // handoff id -> { child, done, reason, fix }
  // `maxConcurrent` (tests, embedders) sets both caps; otherwise they come from the user config.
  const configured = concurrencyLimits(ctx.config);
  const limits = { readonly: maxReadonly ?? maxConcurrent ?? configured.readonly, fix: maxFix ?? maxConcurrent ?? configured.fix };
  const inUse = (fix) => [...running.values()].filter((e) => e.fix === fix).length;
  let paused = false;

  function failRun(worker, h, code, message, extra = {}) {
    recordResult(worker, h.id, { summary: null }, { state: 'failed', error: { code, message }, extra });
  }

  // A follow-up turn in the same runtime session. It is tracked like the first turn, so the
  // deadline and cancellation stop it too; null means it did not finish cleanly.
  async function followUp(entry, prompt, { tools, maxTurns, permissionMode = entry.permissionMode }) {
    let run;
    try {
      run = spawnAgent({ claudePath, claudeArgs, prompt, cwd: entry.cwd, tools, env: entry.env, permissions: entry.permissions, logPath: entry.logPath, model, resume: entry.sessionId, maxTurns, permissionMode, keepCredentials: entry.keepCredentials });
    } catch {
      return null;
    }
    entry.child = run.child;
    entry.kill = null;
    entry.done = run.done;
    const outcome = await run.done;
    if (entry.reason || outcome.error || outcome.code !== 0) return null;
    return outcome;
  }

  // ADR 0013: one repair turn when the reply broke its contract, then the recipe's optional
  // self-check. Each needs the session to resume and a minute left before the deadline; a turn
  // that fails or makes things worse leaves the earlier reply in place.
  async function improve(worker, entry, outcome) {
    const parseOpts = { outputs: entry.outputs };
    const quality = { problems: [], repaired: false, self_checked: false };
    let parsed = parseAgentResult(outcome.stdout, parseOpts);
    quality.problems = parsed.problems;
    entry.sessionId = parsed.session_id;
    const timeLeft = () => !entry.deadlineAt || Date.parse(entry.deadlineAt) - Date.parse(worker.now()) >= 60_000;
    if (parsed.is_error || !entry.sessionId) {
      if (entry.selfCheck) quality.self_check_skipped = parsed.is_error ? 'the agent reported an error' : 'the reply carried no session id to resume';
      return { outcome, quality };
    }
    if (parsed.problems.length && !entry.reason && timeLeft()) {
      const next = await followUp(entry, repairPrompt(parsed.problems), { tools: entry.tools, maxTurns: 2 });
      const fixed = next ? parseAgentResult(next.stdout, parseOpts) : null;
      if (fixed && !fixed.is_error && fixed.problems.length < parsed.problems.length) {
        outcome = next;
        parsed = fixed;
        quality.repaired = true;
        quality.problems = fixed.problems;
      }
    }
    if (entry.selfCheck && !parsed.problems.length && !entry.reason && timeLeft()) {
      // The check re-reads sources; it never edits, whatever the run was allowed to do.
      const readOnly = selfCheckTools(entry.permissions);
      const next = await followUp(entry, SELF_CHECK_PROMPT, { tools: readOnly, maxTurns: 12, permissionMode: 'dontAsk' });
      const checked = next ? parseAgentResult(next.stdout, parseOpts) : null;
      if (checked && !checked.is_error && !checked.problems.length) {
        outcome = next;
        quality.self_checked = true;
      } else if (!entry.reason) quality.self_check_skipped = 'the self-check turn did not finish cleanly; the earlier reply stands';
    } else if (entry.selfCheck) {
      // Recorded so a fix run without its mandatory check says why (ADR 0022).
      quality.self_check_skipped = parsed.problems.length ? 'the reply still breaks its output contract' : entry.reason ? 'the run was stopped first' : 'less than a minute left before the deadline';
    }
    return { outcome, quality };
  }

  async function finish(worker, h, run, outcome) {
    const entry = running.get(h.id);
    const parseOpts = { outputs: entry ? entry.outputs : null };
    const current = worker.state.handoffs.get(h.id);
    if (!current || !['running'].includes(current.state)) { running.delete(h.id); return; }
    let quality = null;
    let gate = null;
    if (entry && !entry.reason && !outcome.error && outcome.code === 0) {
      const first = outcome;
      ({ outcome, quality } = await improve(worker, entry, outcome));
      // A run that may edit source is checked by the worker's own test gate (ADR 0023).
      if (!entry.reason && entry.permissions.edit_source) ({ outcome, gate } = await testGate(worker, entry, current, outcome));
      // A deadline or cancellation during a follow-up keeps the first reply as the partial result.
      if (entry.reason) { outcome = first; gate = null; }
    }
    running.delete(h.id);
    // Measured, not estimated (ADR 0022): agent time covers every turn, including the self-check
    // and the test repair turn; the gate's own test runs are test time.
    const testMs = gate && Number.isFinite(gate.total_ms) ? gate.total_ms : null;
    const timings = entry && entry.spawnedAt !== undefined ? { ...(current.timings ?? {}), agent_ms: Math.max(0, Math.round(performance.now() - entry.spawnedAt - (testMs ?? 0))), ...(testMs !== null ? { test_ms: testMs } : {}) } : null;
    if (gate) delete gate.total_ms;
    const record = (w, id, parsed, opts) => recordResult(w, id, parsed, timings ? { ...opts, extra: { ...(opts.extra ?? {}), timings } } : opts);
    const reason = entry ? entry.reason : null;
    if (reason === 'timeout') { record(worker, h.id, parseAgentResult(outcome.stdout, parseOpts), { state: 'timed-out', error: { code: 'timeout', message: `execution exceeded ${Math.round(deadlineMs / 60000)} min wall clock` }, extra: await fixExtras(worker, current) }); return; }
    if (reason === 'cancel') { record(worker, h.id, parseAgentResult(outcome.stdout, parseOpts), { state: 'cancelled', error: { code: 'cancelled', message: 'cancelled by owner' }, extra: await fixExtras(worker, current) }); return; }
    if (reason === 'stopped') { record(worker, h.id, parseAgentResult(outcome.stdout, parseOpts), { state: 'failed', error: { code: 'interrupted', message: 'worker stopped while the run was in progress' }, extra: await fixExtras(worker, current) }); return; }
    if (outcome.error) { record(worker, h.id, { summary: null }, { state: 'failed', error: { code: outcome.error.code === 'ENOENT' ? 'runtime-missing' : 'spawn-failed', message: outcome.error.message } }); return; }
    const resultFile = path.join(handoffsDir(worker.env), 'results', `${h.id}.result.json`);
    const explicit = readJsonIfExists(resultFile);
    const parsed = explicit ? { ...parseAgentResult(''), ...explicit, raw: outcome.stdout } : parseAgentResult(outcome.stdout, parseOpts);
    if (outcome.code !== 0) { record(worker, h.id, parsed, { state: 'failed', error: { code: 'agent-exit', message: `agent exited with exit code ${outcome.code}${outcome.signal ? ` (signal ${outcome.signal})` : ''}` }, extra: await fixExtras(worker, current) }); return; }
    if (parsed.is_error) { record(worker, h.id, parsed, { state: 'failed', error: { code: 'agent-error', message: parsed.summary ?? 'agent reported an error' }, extra: await fixExtras(worker, current) }); return; }
    // Tests that still fail after the repair turn leave no suggestion: no commit, push, PR or
    // ticket change, only the diff for the owner to inspect and the reason (ADR 0023).
    if (gate && (gate.status === 'failed' || gate.status === 'timeout')) {
      const extra = { ...(await fixExtras(worker, current)), test_gate: gate };
      if (quality) extra.result_quality = { ...quality, problems: explicit ? [] : parsed.problems };
      const why = gate.status === 'timeout' ? 'did not finish in time' : `exited with code ${gate.exit_code ?? 'unknown'}`;
      record(worker, h.id, parsed, { state: 'failed', error: { code: gate.status === 'timeout' ? 'tests-timeout' : 'tests-failed', message: `the test command ${why}${gate.attempts > 1 ? ' again after one repair turn' : ' and no repair turn was possible'}; no fix is suggested` }, extra });
      return;
    }
    const extras = await fixExtras(worker, current, { finalize: true, gate });
    if (gate) extras.test_gate = gate;
    if (quality) extras.result_quality = { ...quality, problems: explicit ? [] : parsed.problems };
    // Only a run that finished cleanly changes files; a failed, cancelled or timed-out one leaves
    // every original untouched.
    if (entry && entry.staged) {
      const { effects, skipped } = applyFileRun({ env: worker.env, handoffId: h.id, sandbox: entry.cwd, files: entry.staged, permissions: current.permissions ?? {}, deleteIds: parsed.delete_files ?? [], now: worker.now() });
      extras.file_effects = effects;
      if (skipped.length) extras.uncertain_effects = [...(current.uncertain_effects ?? []), ...skipped];
    }
    record(worker, h.id, parsed, { state: extras.error ? 'failed' : 'done', error: extras.error ?? null, extra: extras });
  }

  // For fix runs: collect changed files and a patch; perform explicitly permitted commit/push/PR.
  async function fixExtras(worker, h, { finalize = false, gate = null } = {}) {
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
          try { out.pr_url = await openDraftPr(h.worktree_path, { branch: h.branch, base: repo ? repo.default_branch : 'main', title: `Handoff: ${h.note || h.id.slice(0, 8)}`, body: `Draft opened by Session Quill handoff ${h.id} for ticket ${h.ticket_id}. Not a deployment.\n\n${gateLine(gate)}` }); } catch (err) { out.uncertain_effects = [...(h.uncertain_effects ?? []), `draft PR creation uncertain: ${err.message}`]; }
        }
      }
    } catch (err) {
      out.error = { code: 'commit-failed', message: err.message };
    }
    return out;
  }

  // ADR 0023: run the repository's tests in the run's checkout; on a failure, one repair turn
  // with the failing output, then the tests again. Only a real pass is ever reported as one.
  async function testGate(worker, entry, h, outcome) {
    const parsed = parseAgentResult(outcome.stdout, { outputs: entry.outputs });
    if (parsed.is_error || !h.worktree_path) return { outcome, gate: null };
    let changed = [];
    try { changed = await changedFiles(h.worktree_path); } catch { /* treated as no diff */ }
    if (!changed.length) return { outcome, gate: { status: 'skipped', reason: 'no changes to test' } };
    const { command, timeoutMs } = testGateSettings(ctx.config.repos[h.repo_id]);
    if (!command) return { outcome, gate: { status: 'skipped', reason: 'no test_command for this repository; the fix is not test-verified' } };
    const env = childEnvFor(entry.permissions, process.env, entry.env);
    // The gate's command is the run's child while it runs: cancellation, the deadline and a worker
    // stop kill it through its own handle, and onStop waits for it (entry.done).
    const once = () => {
      const p = runTestCommand({ command, cwd: h.worktree_path, timeoutMs, env, onChild: (child, kill) => { entry.child = child; entry.kill = kill; } });
      entry.done = p;
      return p;
    };
    let total = 0;
    let attempts = 1;
    let result = await once();
    total += result.ms;
    const timeLeft = () => !entry.deadlineAt || Date.parse(entry.deadlineAt) - Date.parse(worker.now()) >= 60_000;
    if (result.status !== 'passed' && !entry.reason && entry.sessionId && timeLeft()) {
      const next = await followUp(entry, testRepairPrompt(command, result), { tools: entry.tools, maxTurns: 40 });
      if (entry.reason) return { outcome, gate: null };
      const repaired = next ? parseAgentResult(next.stdout, { outputs: entry.outputs }) : null;
      if (repaired && !repaired.is_error && repaired.problems.length <= parsed.problems.length) outcome = next;
      attempts = 2;
      result = await once();
      total += result.ms;
    }
    if (entry.reason) return { outcome, gate: null };
    return { outcome, gate: { status: result.status, command, exit_code: result.exit_code, ms: result.ms, tail: result.tail, attempts, repaired: attempts > 1 && result.status === 'passed', total_ms: total } };
  }

  async function dispatch(worker, h) {
    // How long the run waited for a slot (worker clock), then each setup step that actually ran.
    // A run that fails before it starts keeps whatever was measured (ADR 0022).
    const timings = { queue_wait_ms: Math.max(0, Date.parse(worker.now()) - Date.parse(h.requested_at)) };
    const fail = (w, run, code, message) => failRun(w, run, code, message, { timings: { ...timings } });
    const ticket = worker.state.tickets.get(h.ticket_id);
    if (!ticket) return fail(worker, h, 'ticket-missing', 'ticket no longer exists');
    const repoCfg = ctx.config.repos[h.repo_id] ? { id: h.repo_id, ...ctx.config.repos[h.repo_id] } : null;
    // The recipe must still be the one that was queued: an edited file could otherwise run with
    // instructions or permissions nobody reviewed (ADR 0008).
    const catalog = catalogFor(worker);
    // Runs queued before recipes existed have no recipe reference and use the built-in of their mode.
    const recipe = !h.recipe || h.recipe.source === 'builtin' ? catalog.builtin(h.recipe ? h.recipe.name : h.mode) : catalog.get(h.recipe.name, h.repo_id ?? null, { fresh: true });
    // A built-in recipe ships with Quill: after an upgrade its text (and hash) may differ from what
    // was queued, and the current built-in is what this release runs. Only personal and repository
    // recipes, which anyone can edit on disk, must still match the reviewed hash.
    const builtin = h.recipe && h.recipe.source === 'builtin';
    if (h.recipe && (!recipe || recipe.error || (!builtin && recipe.hash !== h.recipe.hash))) return fail(worker, h, 'recipe-changed', `recipe ${h.recipe.name} changed or was removed after this run was queued; review it and queue a new run`);
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
        const worktreeStarted = performance.now();
        try {
          await createWorktree({ repoPath: repoCfg.canonical_path, baseCommit, dir: worktreePath });
        } finally { timings.worktree_ms = Math.round(performance.now() - worktreeStarted); }
      } catch (err) {
        return fail(worker, h, err.code === 'worktree-failed' ? 'worktree-failed' : 'source-failed', err.message);
      }
      cwd = worktreePath;
    } else {
      cwd = path.join(handoffsDir(worker.env), 'sandbox', h.id);
      fs.mkdirSync(cwd, { recursive: true });
    }
    // A files run (ADR 0015) gets copies of the ticket's attached files; the originals are never
    // in reach of the agent.
    let staged = null;
    if (h.mode === 'files') {
      try { staged = stageFiles(ticket, cwd); } catch (err) { return fail(worker, h, err.code ?? 'files-unavailable', err.message); }
      updateHandoff(worker, h.id, { files: staged.map(({ id, path: p, state, size }) => ({ id, path: p, state, size })) });
    }
    const logPath = path.join(logsDir(worker.env), 'handoffs', `${h.id}.log`);
    const started = worker.now();
    const deadlineAt = addMs(started, Math.min(deadlineMs, h.deadline_ms ?? Infinity));
    updateHandoff(worker, h.id, { state: 'running', started_at: started, deadline_at: deadlineAt, base_commit: baseCommit, worktree_path: worktreePath, log_path: logPath, timings });
    const current = worker.state.handoffs.get(h.id);
    const url = (ticket.external && ticket.external.url) || (ticket.jira && ticket.jira.url) || null;
    const environments = worker.environmentsFor ? worker.environmentsFor(ticket.repo_id) : repoCfg ? repoCfg.deployment_environments ?? [] : [];
    const render = (r) => renderRecipe(r, { ticket, url, note: h.note, prs: ticket.prs ?? [], deployments: ticket.deployments ?? [], environments });
    const context = gatherContext(worker.state, ticket, { env: worker.env, currentId: h.id });
    const inputs = !recipe || recipe.legacy ? null : new Set(recipe.inputs);
    // The diff is read from the run's own checkout, so it exists only with source access.
    if (worktreePath && (!inputs || inputs.has('work'))) context.diff = await gatherDiff(worktreePath, context.commits);
    if (staged) context.staged_files = staged;
    const prompt = buildPrompt(current, ticket, { repo: repoCfg, recipe, render, context });
    // Standard access keeps the recipe's own tool narrowing; settings and full access hand the
    // decision to Claude Code itself (ADR 0017).
    const access = h.access ?? 'standard';
    const rt = access === 'standard' ? { permissionMode: 'dontAsk', ...(recipe ? recipeTools(recipe, h.permissions ?? {}) : allowedToolsFor({ mode: h.mode, permissions: h.permissions })), keepCredentials: false } : runtimeAccess({ access, mode: h.mode, permissions: h.permissions ?? {} });
    const tools = { allowed: rt.allowed, disallowed: rt.disallowed };
    const env = { ...spawnEnv, QUILL_HANDOFF_ID: h.id, QUILL_HANDOFF_TICKET_ID: ticket.id, QUILL_HANDOFF_TICKET_KEY: ticket.key };
    if (ctx.env && ctx.env.QUILL_HOME) env.QUILL_HOME = ctx.env.QUILL_HOME;
    let run;
    try {
      run = spawnAgent({ claudePath, claudeArgs, prompt, cwd, tools, env, permissions: h.permissions ?? {}, logPath, model, permissionMode: rt.permissionMode, keepCredentials: rt.keepCredentials });
    } catch (err) {
      return fail(worker, h, 'spawn-failed', err.message);
    }
    const spawnedAt = performance.now();
    // A run that may edit source always self-checks, whatever its recipe says (ADR 0022).
    const selfCheck = !!(recipe && recipe.self_check) || !!(h.permissions && h.permissions.edit_source);
    running.set(h.id, { child: run.child, done: run.done, reason: null, fix: isFix(h), deadlineAt, cwd, env, tools, logPath, permissions: h.permissions ?? {}, selfCheck, sessionId: null, outputs: recipe ? recipe.outputs : null, staged, permissionMode: rt.permissionMode, keepCredentials: rt.keepCredentials, spawnedAt });
    running.get(h.id).finished = run.done.then((outcome) => finish(worker, current, run, outcome)).catch((err) => worker.log(`handoff finish failed: ${err.stack ?? err.message}`));
  }

  function killWithReason(id, reason) {
    const entry = running.get(id);
    if (!entry) return;
    entry.reason = reason;
    if (entry.kill) entry.kill(); else killTree(entry.child);
  }

  return {
    name: 'handoff',
    pause() { paused = true; },
    resume() { paused = false; },
    runningIds: () => new Set(running.keys()),
    async onStart(worker) {
      worker.recipeInfo = () => catalogFor(worker).list();
      worker.handoffLimits = () => ({ ...limits });
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
      for (const h of nextDispatchable(worker.state, { running: new Set(running.keys()) })) {
        const fix = isFix(h);
        if (inUse(fix) >= (fix ? limits.fix : limits.readonly)) continue;
        running.set(h.id, { child: null, done: null, reason: null, deadlineAt: null, fix });
        dispatch(worker, h).then(() => { if (running.has(h.id) && !running.get(h.id).child) running.delete(h.id); }).catch((err) => { running.delete(h.id); worker.log(`dispatch failed: ${err.stack ?? err.message}`); failRun(worker, h, 'dispatch-failed', err.message); });
      }
    },
    async onStop(worker, { abandonRuns = false } = {}) {
      if (abandonRuns) { running.clear(); return; }
      const pending = [];
      for (const [id, entry] of running) {
        // Wait for the whole finish, not just the process: it may be in a follow-up turn or the
        // test gate, and its outcome must reach the journal before the worker stops.
        if (entry.child) { killWithReason(id, 'stopped'); pending.push(entry.done, entry.finished); }
      }
      await Promise.all(pending);
      // give finish() handlers a tick to journal their outcomes
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}
