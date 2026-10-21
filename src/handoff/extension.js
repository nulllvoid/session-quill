// Worker extension that dispatches queued handoffs, enforces the 20-minute wall-clock cap,
// honours cancellation, and resolves runs interrupted by a restart (TRD §Handoff execution).
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nextDispatchable } from './reserve.js';
import { validateHandoffRequest } from './permissions.js';
import { git, createWorktree, removeWorktree, isUnder, pruneWorktrees, worktreeBase, headCommit, changedFiles, diffPatch, commitAll, pushBranch, openDraftPr, workingTree } from './worktree.js';
import { buildReceipt, guardSummary, changeSummary, publicCommand } from './receipt.js';
import { changeGlobs } from '../config/config.js';
import { buildPrompt, budgetFor, recipeCaps, allowedToolsFor, selfCheckTools, runtimeAccess, parseAgentResult, spawnAgent, killTree, repairPrompt, SELF_CHECK_PROMPT, childEnvFor } from './runner.js';
import { runTestCommand, testGateSettings, testRepairPrompt } from './test-gate.js';
import { gatherContext, gatherDiff, gatherMemory, inlineBudget, writeContext } from './context.js';
import { stageFiles, applyFileRun } from './files.js';
import { catalogFor, renderRecipe, recipeTools } from '../agents/recipes.js';
import { recordResult, updateHandoff } from './results.js';
import { reemitMissingCriticalProposals } from './critical-changes.js';
import { resultFromStream, sessionIdOf, readLedger } from './stream.js';
import { buildDocsMap, renderDocsMap } from './docs-map.js';
import { reconcileAttempts } from './reconcile.js';
import { countRunDrift } from '../core/planned-paths.js';
import { handoffsDir, handoffRunDir, logsDir, quillHome } from '../lib/paths.js';
import { fileLearnings, taskLessons, appendRunNotes, workerLearnings, readCiteSources } from '../memory/file.js';
import { writeDocsProjection } from '../memory/project.js';
import { failureRecord, repeatNotice } from '../memory/failure.js';
import { anchorStaleRatio, anchorCandidates, anchorCheckKey, staledEvent } from '../memory/anchors.js';
import { runEnvForFiling, runEnvStaleEvents } from './run-env.js';
import { anchorVerdicts } from '../memory/deliver.js';
import { addMs, MINUTE } from '../lib/time.js';
import { getBlob } from '../core/blobs.js';
import { parseInit, assertRuntime, autonomyInfo } from './inventory.js';
import { catalogScopes, createVersionProbe, prepareAutonomous, prepareObserve, prodEffects } from './autonomous.js';
import { interruptedEffects, batchBudgetUsd, batchBudgetReached, resumePrompt, carrySession, claudeConfigRoot } from './resume.js';
import { createTicketWorktreeSweep } from './ticket-worktrees.js';
import { takeSnapshot, archiveSnapshots } from './snapshots.js';
import { patchFields, criticSettings, runCritic, criticFields } from './critic.js';

// The default wall clock for a run that sets no timeout of its own. `budgetFor` supplies the
// per-run value (20 min, 30 for autonomous, up to 60 by recipe or config); `deadlineMs` below is an
// embedder or test cap on top of it.
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

// What a draft PR says about tests: "passed (worker)" only after a real pass of the gate. The
// command leaves the machine, so absolute paths in it are replaced (ADR 0033).
export function gateLine(gate) {
  if (gate && gate.status === 'passed') return `Tests passed (worker): \`${publicCommand(gate.command)}\` exited 0${gate.repaired ? ' after one repair turn' : ''}.`;
  return 'Not test-verified by the worker: no test command is configured for this repository.';
}

// Keep split on a terminal state (spec §10): a read-only run's checkout goes at once; a fix run's
// stays this long, because its patch is already collected but the owner may still inspect it.
export const FIX_WORKTREE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_RETENTION_DAYS = 30;
// A stop waits at most this long for runs that are still filing their memory (the cited files are
// read asynchronously after the terminal state is recorded); anything left is filed at the next start.
export const FINISH_WAIT_MS = 20_000;
// At start, terminal runs finished this recently that have no memory_filing are filed again.
export const REFILE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REFILE_MAX = 50;
// ADR 0032: how often the worker compares anchored memory with each registered repository's HEAD.
export const ANCHOR_CHECK_MS = 5 * MINUTE;
const TERMINAL = new Set(['done', 'failed', 'timed-out', 'cancelled']);

// `[handoff] log_retention_days`: how long a run's ledger directory and log are kept.
export function retentionDays(config = {}) {
  const v = config && config.handoff && typeof config.handoff === 'object' ? config.handoff.log_retention_days : undefined;
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_LOG_RETENTION_DAYS;
}

const isFix = (h) => !!(h.permissions && h.permissions.edit_source);

// Resolves once every promise has settled or `ms` has passed, whichever comes first.
async function settledWithin(promises, ms) {
  if (!promises.length) return;
  let timer;
  await Promise.race([Promise.allSettled(promises), new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

function detectRuntime(claudePath) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [claudePath], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return fs.existsSync(claudePath);
  }
}

// `resolveScopes(names, config, env)` turns a run's requested write scopes into resolved entries
// ([{ name, target, env, matchers, fingerprint, credentials, systems }]) or throws; the default is
// the scope catalog of the config (src/handoff/scopes.js).
// The first scope of an approved critical change whose table no longer has the approved fingerprint.
function scopeChanged(h, scopes) {
  if (!h.scope_fingerprints || typeof h.scope_fingerprints !== 'object') return null;
  for (const [spec, want] of Object.entries(h.scope_fingerprints)) {
    const s = scopes.find((x) => (x.target ? `${x.name}:${x.target}` : x.name) === spec);
    let got = null;
    try { got = s ? s.fingerprint : null; } catch (err) { return `scope ${spec} cannot be fingerprinted (${err.message})`; }
    if (got !== want) return h.action_pins ? `scope ${spec} changed in config.toml after this critical change was approved, so the run did not start: it runs only with the scope exactly as approved` : `scope ${spec} changed in config.toml since the run this one resumes started, so it did not start: a resumed run gets only the scope exactly as it was granted; queue a new run instead`;
  }
  return null;
}

// `{ 'name:target': fingerprint }` of resolved scopes, or null when one cannot be fingerprinted.
function grantedFingerprints(scopes) {
  try {
    const out = {};
    for (const s of scopes) {
      if (typeof s.fingerprint !== 'string' || !s.fingerprint) return null;
      out[s.target ? `${s.name}:${s.target}` : s.name] = s.fingerprint;
    }
    return out;
  } catch { return null; }
}

export function createExtension(ctx, { removeWorktreeFn = removeWorktree, openDraftPrFn = openDraftPr, claudePath = 'claude', claudeArgs = [], spawnEnv = {}, deadlineMs = null, maxConcurrent, maxReadonly, maxFix, runtimeAvailable, model = null, resolveScopes = catalogScopes, ticketWorktreeRemoveFn } = {}) {
  // Ticket worktree teardown (ADR 0036): at start (in the background), then at most hourly from the tick.
  const ticketWorktrees = createTicketWorktreeSweep(ticketWorktreeRemoveFn ? { removeFn: ticketWorktreeRemoveFn } : {});
  const running = new Map(); // handoff id -> { child, done, reason, fix }
  const finishing = new Set(); // finish() promises, until memory filing has landed
  const filings = new Map(); // ticket id -> Set of those promises, for the ticket's next dispatch
  const dispatches = new Map(); // handoff id -> its dispatch promise, until it settles (M7: onStop waits)
  const probeVersion = createVersionProbe({ claudePath, claudeArgs, spawnEnv });
  const anchorSeen = new Map(); // repo id -> anchorCheckKey (HEAD and the candidates) of its last anchor check
  let anchorCheckAt = null;
  let anchorCheck = null; // the anchor check in flight
  // `maxConcurrent` (tests, embedders) sets both caps; otherwise they come from the user config.
  const configured = concurrencyLimits(ctx.config);
  const limits = { readonly: maxReadonly ?? maxConcurrent ?? configured.readonly, fix: maxFix ?? maxConcurrent ?? configured.fix };
  const inUse = (fix) => [...running.values()].filter((e) => e.fix === fix).length;
  let paused = false;
  let stopping = false;
  let currentWorker = null;
  // Whether a run the tick handed to dispatch may still start: queued in the state, no cancel asked.
  const stillQueued = (worker, id) => { const cur = worker.state.handoffs.get(id); return !!cur && cur.state === 'queued' && !cur.cancel_requested; };

  function failRun(worker, h, code, message, extra = {}) {
    recordResult(worker, h.id, { summary: null }, { state: 'failed', error: { code, message }, extra });
  }

  // Spec §5.4: the writes an interrupted run's partial ledger shows the guard allowed. The worker
  // never saw the run finish, so each only may have run.
  function mayHaveRun(worker, id) {
    try { return interruptedEffects(readLedger(path.join(handoffRunDir(worker.env, id), 'ledger.jsonl'))); } catch { return []; }
  }

  // The reply of one turn, read only from its final stream `result` event (spec §5.4). A turn with
  // no result event parses as empty and is flagged `no_result`.
  function parseOutcome(outcome, opts) {
    let r = null;
    try { r = resultFromStream(outcome && outcome.collected); } catch { /* no result event */ }
    const parsed = parseAgentResult(r ?? { text: '' }, opts);
    if (!r) parsed.no_result = true;
    return parsed;
  }

  // The session id is recorded on the run the moment init arrives, so a run cut off by a worker
  // restart can still be resumed later (spec §5.4). A resumed turn that reports a new id moves it on.
  // The first init's tool inventory is stored on the run (R6). An autonomous run whose init reports
  // a runtime older than the guard needs is stopped (the version probe before spawn is the first gate).
  function onInitFor(worker, id) {
    return (event) => {
      const entry = running.get(id);
      if (!entry) return;
      const patch = {};
      const sid = sessionIdOf(event);
      if (sid && entry.sessionId !== sid) { entry.sessionId = sid; patch.session_id = sid; }
      if (!entry.inventoryRecorded) {
        entry.inventoryRecorded = true;
        try { patch.inventory = { ...parseInit(event), at: worker.now() }; } catch { /* no inventory */ }
      }
      if (entry.access === 'autonomous' && !entry.reason && patch.inventory && patch.inventory.version) {
        try { assertRuntime(patch.inventory.version); } catch (err) { entry.runtimeError = err.message; killWithReason(id, 'runtime-too-old'); }
      }
      const h = worker.state.handoffs.get(id);
      if (!Object.keys(patch).length || !h || h.state !== 'running') return;
      try { updateHandoff(worker, id, patch); } catch (err) { worker.log(`handoff init not recorded: ${err.message}`); }
    };
  }

  // Turns and spend across every turn of a run, from each turn's final result event (spec §5.4).
  // Verified against Claude Code 2.1.296 (haiku, one trivial turn then three --resume turns of the
  // same session): each invocation's result event reports its OWN num_turns (1, 1, 1, 1) and
  // total_cost_usd (about 0.004 to 0.006 each, with per-invocation token usage), not a running
  // total for the session. So turns and costs are summed. `--max-budget-usd` is likewise
  // per process, which is why follow-up turns get only what the run has left (remainingUsd).
  // Under claude.ai subscription auth (no API key in the child's environment) the cost is an
  // estimate, and the record says so.
  function addUsage(entry, outcome) {
    if (!entry || !outcome) return;
    let r = null;
    try { r = resultFromStream(outcome.collected); } catch { return; }
    entry.usage = entry.usage ?? { turns: 0, cost: 0, costSeen: false };
    if (r.num_turns !== null) entry.usage.turns += r.num_turns;
    if (r.total_cost_usd !== null) { entry.usage.cost += r.total_cost_usd; entry.usage.costSeen = true; }
  }

  // A follow-up turn in the same runtime session. It is tracked like the first turn, so the
  // deadline and cancellation stop it too; null means it did not finish cleanly.
  // What is left of the run's spend cap, in USD; Infinity when no cap applies.
  const remainingUsd = (entry) => {
    const cap = entry.budget.maxBudgetUsd;
    if (!Number.isFinite(cap) || cap <= 0) return Infinity;
    return Math.max(0, Math.round((cap - (entry.usage ? entry.usage.cost : 0)) * 10000) / 10000);
  };

  // Run snapshots (ADR 0035) before a follow-up turn: the run's id is its running entry's key.
  const snapshotBefore = (worker, entry, step) => { for (const [id, e] of running) if (e === entry) return takeSnapshot(worker, id, step); return null; };

  async function followUp(entry, prompt, { tools, maxTurns, permissionMode = entry.permissionMode, label = 'follow-up' }) {
    const left = remainingUsd(entry);
    if (left <= 0) {
      (entry.budgetNotes ??= []).push(`${label}-skipped-budget-spent`);
      return null;
    }
    let run;
    try {
      run = spawnAgent({ claudePath, claudeArgs, prompt, cwd: entry.cwd, tools, env: entry.env, permissions: entry.permissions, logPath: entry.logPath, ledgerPath: entry.ledgerPath, onInit: entry.onInit, model, resume: entry.sessionId, maxTurns, maxBudgetUsd: Number.isFinite(left) ? left : null, permissionMode, keepCredentials: entry.keepCredentials, ...entry.spawnExtras });
    } catch {
      return null;
    }
    entry.child = run.child;
    entry.kill = null;
    entry.done = run.done;
    const outcome = await run.done;
    addUsage(entry, outcome);
    if (entry.reason || outcome.error || outcome.code !== 0) return null;
    return outcome;
  }

  // ADR 0013: one repair turn when the reply broke its contract, then the recipe's optional
  // self-check. Each needs the session to resume and a minute left before the deadline; a turn
  // that fails or makes things worse leaves the earlier reply in place.
  async function improve(worker, entry, outcome) {
    const parseOpts = { outputs: entry.outputs };
    const quality = { problems: [], repaired: false, self_checked: false };
    let parsed = parseOutcome(outcome, parseOpts);
    quality.problems = parsed.problems;
    if (parsed.no_result) return { outcome, quality };
    entry.sessionId = parsed.session_id ?? entry.sessionId;
    const timeLeft = () => !entry.deadlineAt || Date.parse(entry.deadlineAt) - Date.parse(worker.now()) >= 60_000;
    if (parsed.is_error || !entry.sessionId) {
      if (entry.selfCheck) quality.self_check_skipped = parsed.is_error ? 'the agent reported an error' : 'the reply carried no session id to resume';
      return { outcome, quality };
    }
    if (parsed.problems.length && !entry.reason && timeLeft()) {
      await snapshotBefore(worker, entry, 'before-repair');
      const next = await followUp(entry, repairPrompt(parsed.problems), { tools: entry.tools, maxTurns: entry.budget.repairTurns, label: 'repair' });
      const fixed = next ? parseOutcome(next, parseOpts) : null;
      if (fixed && !fixed.no_result && !fixed.is_error && fixed.problems.length < parsed.problems.length) {
        outcome = next;
        parsed = fixed;
        quality.repaired = true;
        quality.problems = fixed.problems;
      }
    }
    if (entry.selfCheck && !parsed.problems.length && !entry.reason && timeLeft()) {
      // The check re-reads sources; it never edits, whatever the run was allowed to do. Under
      // autonomous access the guard still decides each call, with no static allow rule.
      await snapshotBefore(worker, entry, 'before-self-check');
      const readOnly = entry.access === 'autonomous' ? { allowed: [], disallowed: [...new Set([...entry.tools.disallowed, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent'])] } : selfCheckTools(entry.permissions);
      const next = await followUp(entry, SELF_CHECK_PROMPT, { tools: readOnly, maxTurns: entry.budget.selfCheckTurns, permissionMode: 'dontAsk', label: 'self-check' });
      const checked = next ? parseOutcome(next, parseOpts) : null;
      if (checked && !checked.no_result && !checked.is_error && !checked.problems.length) {
        outcome = next;
        quality.self_checked = true;
      } else if (!entry.reason) quality.self_check_skipped = 'the self-check turn did not finish cleanly; the earlier reply stands';
    } else if (entry.selfCheck) {
      // Recorded so a fix run without its mandatory check says why (ADR 0022).
      quality.self_check_skipped = parsed.problems.length ? 'the reply still breaks its output contract' : entry.reason ? 'the run was stopped first' : 'less than a minute left before the deadline';
    }
    return { outcome, quality };
  }

  async function finishRun(worker, h, run, outcome) {
    const entry = running.get(h.id);
    const parseOpts = { outputs: entry ? entry.outputs : null };
    const current = worker.state.handoffs.get(h.id);
    if (!current || !['running'].includes(current.state)) { running.delete(h.id); return; }
    addUsage(entry, outcome);
    await takeSnapshot(worker, h.id, 'agent');
    let quality = null;
    let gate = null;
    let critic = null;
    if (entry && !entry.reason && !outcome.error && outcome.code === 0) {
      const first = outcome;
      ({ outcome, quality } = await improve(worker, entry, outcome));
      // A run that may edit source is checked by the worker's own test gate (ADR 0023).
      if (!entry.reason && entry.permissions.edit_source) ({ outcome, gate } = await testGate(worker, entry, current, outcome));
      // ADR 0040: then, when the repository opts in, the critic reviews it (opinion, never a check).
      if (!entry.reason && gate) critic = await reviewRun(worker, entry, current, gate);
      // A deadline or cancellation during a follow-up keeps the first reply as the partial result.
      if (entry.reason) { outcome = first; gate = null; critic = null; }
    }
    running.delete(h.id);
    // Measured, not estimated (ADR 0022): agent time covers every turn, including the self-check
    // and the test repair turn; the gate's own test runs are test time.
    const testMs = gate && Number.isFinite(gate.total_ms) ? gate.total_ms : null;
    const criticMs = critic && Number.isFinite(critic.ms) ? critic.ms : null;
    const timings = entry && entry.spawnedAt !== undefined ? { ...(current.timings ?? {}), agent_ms: Math.max(0, Math.round(performance.now() - entry.spawnedAt - (testMs ?? 0) - (criticMs ?? 0))), ...(testMs !== null ? { test_ms: testMs } : {}), ...(criticMs !== null ? { critic_ms: criticMs } : {}) } : null;
    const criticExtra = critic ? criticFields(critic, worker.env, { runId: h.id }) : {};
    if (gate) delete gate.total_ms;
    // ADR 0033: the tested tree is its own field on the run, never inside the gate record.
    const testedTree = gate && gate.tested_tree ? gate.tested_tree : null;
    if (gate) delete gate.tested_tree;
    // A turn that produced no result event (killed by the deadline or a cancel) leaves usage unknown: recorded as null, not omitted.
    const usage = entry && entry.env ? { num_turns: entry.usage ? entry.usage.turns : null, cost_usd: entry.usage && entry.usage.costSeen ? Math.round(entry.usage.cost * 10000) / 10000 : null, cost_estimated: !((entry.spawnExtras && entry.spawnExtras.childEnv) ?? { ...process.env, ...entry.env }).ANTHROPIC_API_KEY } : null;
    // Spec §5.4: what the agent says it tried is checked against the run's tool ledger, and calls
    // the ledger shows were refused are added, so the stored list is the one list later reads use.
    const reconciled = (p) => {
      if (!p || typeof p !== 'object') return p;
      try {
        const lines = readLedger(path.join(handoffRunDir(worker.env, h.id), 'ledger.jsonl'));
        if (!lines.length && !(p.attempts ?? []).length) return p;
        const r = reconcileAttempts(p.attempts ?? [], lines);
        return { ...p, attempts: [...r.attempts, ...r.added] };
      } catch { return p; }
    };
    const withNotes = (p) => (entry && entry.budgetNotes && entry.budgetNotes.length && p && typeof p === 'object' ? { ...p, contract_problems: [...(p.contract_problems ?? []), ...entry.budgetNotes] } : p);
    // A full-access run's writes, as its observer saw them, whatever state it ends in (spec §7).
    let effects = null;
    if ((current.access ?? 'standard') === 'full' && entry && entry.observed) { try { effects = prodEffects(readLedger(path.join(handoffRunDir(worker.env, h.id), 'ledger.jsonl'))); } catch { effects = null; } }
    // Planned files (ADR 0037): how many allowed writes the guard marked outside them, whatever state
    // the run ends in. Observed, never refused; the export carries only this count.
    let drift = null;
    const guarded = current.access === 'autonomous' || (current.access === 'full' && !!(entry && entry.observed));
    if (guarded && Array.isArray(current.planned_paths) && current.planned_paths.length) { try { drift = countRunDrift(readLedger(path.join(handoffRunDir(worker.env, h.id), 'ledger.jsonl'))); } catch { drift = null; } }
    const record = async (w, id, parsed, opts) => {
      const final = withNotes(reconciled(parsed));
      const out = recordResult(w, id, final, timings || usage || effects || drift !== null ? { ...opts, extra: { ...(opts.extra ?? {}), ...(timings ? { timings } : {}), ...(usage ?? {}), ...(effects ? { prod_effects: effects } : {}), ...(drift !== null ? { scope_drift: drift } : {}) } } : opts);
      // Before cleanupRun removes the checkout: repo-file learnings are checked against it.
      await fileMemory(w, id, final);
      return out;
    };
    const reason = entry ? entry.reason : null;
    if (reason === 'timeout') { await record(worker, h.id, parseOutcome(outcome, parseOpts), { state: 'timed-out', error: { code: 'timeout', message: `execution exceeded ${Math.round((entry.timeoutMs ?? HANDOFF_DEADLINE_MS) / 60000)} min wall clock` }, extra: await fixExtras(worker, current) }); return; }
    if (reason === 'cancel') { await record(worker, h.id, parseOutcome(outcome, parseOpts), { state: 'cancelled', error: { code: 'cancelled', message: 'cancelled by owner' }, extra: await fixExtras(worker, current) }); return; }
    if (reason === 'runtime-too-old') { await record(worker, h.id, parseOutcome(outcome, parseOpts), { state: 'failed', error: { code: 'runtime-too-old', message: entry.runtimeError ?? 'Claude Code is too old for autonomous runs; queue the run again with standard access' }, extra: await fixExtras(worker, current) }); return; }
    if (reason === 'stopped') {
      const extra = await fixExtras(worker, current);
      // Owner-only (R55): exports, the mirror and vault notes see only how many there are.
      const effects = mayHaveRun(worker, h.id);
      if (effects.length) extra.possible_writes = effects;
      await record(worker, h.id, parseOutcome(outcome, parseOpts), { state: 'failed', error: { code: 'interrupted', message: 'worker stopped while the run was in progress' }, extra });
      return;
    }
    if (outcome.error) { await record(worker, h.id, { summary: null }, { state: 'failed', error: { code: outcome.error.code === 'ENOENT' ? 'runtime-missing' : 'spawn-failed', message: outcome.error.message } }); return; }
    // Spec §5.4 (final review M2): the result comes only from the stream's final result event; the
    // legacy handoffs/results/<id>.result.json file is never read, so it cannot bypass the parser's caps.
    const parsed = parseOutcome(outcome, parseOpts);
    if (outcome.code !== 0) { await record(worker, h.id, parsed, { state: 'failed', error: { code: 'agent-exit', message: `agent exited with exit code ${outcome.code}${outcome.signal ? ` (signal ${outcome.signal})` : ''}${current.resume_session_id ? '; Claude Code may not have found the session to resume, and its log says why. Retry as a new run to start afresh' : ''}` }, extra: await fixExtras(worker, current) }); return; }
    if (parsed.no_result) { await record(worker, h.id, parsed, { state: 'failed', error: { code: 'no-result', message: 'the agent exited without a final result event; its log and tool ledger show how far it got' }, extra: await fixExtras(worker, current) }); return; }
    if (parsed.is_error) { await record(worker, h.id, parsed, { state: 'failed', error: { code: 'agent-error', message: parsed.summary ?? 'agent reported an error' }, extra: await fixExtras(worker, current) }); return; }
    // Tests that still fail after the repair turn leave no suggestion: no commit, push, PR or
    // ticket change, only the diff for the owner to inspect and the reason (ADR 0023).
    if (gate && (gate.status === 'failed' || gate.status === 'timeout')) {
      const extra = { ...(await fixExtras(worker, current)), test_gate: gate, ...criticExtra };
      if (quality) extra.result_quality = { ...quality, problems: parsed.problems };
      const why = gate.status === 'timeout' ? 'did not finish in time' : `exited with code ${gate.exit_code ?? 'unknown'}`;
      await record(worker, h.id, parsed, { state: 'failed', error: { code: gate.status === 'timeout' ? 'tests-timeout' : 'tests-failed', message: `the test command ${why}${gate.attempts > 1 ? ' again after one repair turn' : ' and no repair turn was possible'}; no fix is suggested` }, extra });
      return;
    }
    const extras = await fixExtras(worker, current, { finalize: true, gate, testedTree });
    if (gate) extras.test_gate = gate;
    if (testedTree) extras.tested_tree = testedTree;
    Object.assign(extras, criticExtra);
    if (quality) extras.result_quality = { ...quality, problems: parsed.problems };
    // Only a run that finished cleanly changes files; a failed, cancelled or timed-out one leaves
    // every original untouched.
    if (entry && entry.staged) {
      const { effects, skipped } = applyFileRun({ env: worker.env, handoffId: h.id, sandbox: entry.cwd, files: entry.staged, permissions: current.permissions ?? {}, deleteIds: parsed.delete_files ?? [], now: worker.now() });
      extras.file_effects = effects;
      if (skipped.length) extras.uncertain_effects = [...(current.uncertain_effects ?? []), ...skipped];
    }
    await record(worker, h.id, parsed, { state: extras.error ? 'failed' : 'done', error: extras.error ?? null, extra: extras });
  }

  // Spec §6.2: a done run's learnings become memory events, with trust decided by provenance
  // (src/memory/file.js). Every finished run files what the worker itself observed (test gate,
  // guard denials, init inventory) as verified facts, and leaves a Run note on its ticket when it
  // attempted something. A failed, cancelled or timed-out run files none of the agent's learnings:
  // they were never checked against a finished result. Filing never fails the run.
  async function fileMemory(worker, id, result) {
    try {
      const h = worker.state.handoffs.get(id);
      if (!h || !TERMINAL.has(h.state) || !result || typeof result !== 'object') return;
      const ledger = readLedger(path.join(handoffRunDir(worker.env, id), 'ledger.jsonl'));
      // The run's checkout; once it is gone (a filing redone at start), the registered repository
      // serves the same objects for a read at the run's base commit.
      const canonical = h.base_commit ? repoPathOf(h) : null;
      const checkout = h.worktree_path && fs.existsSync(h.worktree_path) ? h.worktree_path : canonical && fs.existsSync(canonical) ? canonical : null;
      const existing = worker.state.memory.entries;
      // M4: the cited files are read with one asynchronous git call, before the synchronous filing.
      const learnings = h.state === 'done' ? result.learnings ?? [] : [];
      const citeSources = learnings.length ? await readCiteSources({ learnings, run: h, checkout }) : new Map();
      const workerFacts = workerLearnings({ run: h, ledger, testGate: h.test_gate ?? null, inventory: h.inventory ?? null });
      // ADR 0041: an autonomous run's environment-dependent learnings are anchored to its environment.
      const runEnv = runEnvForFiling(h, { runDir: handoffRunDir(worker.env, id) });
      const events = fileLearnings({ learnings, run: worker.state.handoffs.get(id) ?? h, ledger, checkout, existing, now: worker.now(), workerFacts, citeSources, runEnv });
      const lessons = taskLessons(events, existing);
      // Deterministic source identities: a filing redone at start never journals an event twice.
      const fresh = (e) => !(worker.journal && worker.journal.hasSource(e.source_identity));
      for (const e of events) if (fresh(e)) worker.emit(e.kind, e.payload, { source_identity: e.source_identity });
      // ADR 0032: a failed worker test gate leaves its worker-structured failure record on the note.
      const note = appendRunNotes(h.ticket_id, result.attempts ?? [], lessons, { run: h, at: worker.now(), failure: failureRecord(worker.state.handoffs.get(id) ?? h) });
      if (note && fresh(note)) worker.emit(note.kind, note.payload, { source_identity: note.source_identity });
    } catch (err) {
      worker.log(`memory filing failed for ${id}: ${err.stack ?? err.message}`);
    }
  }

  // A stop (or crash) between a run's terminal state and its memory filing leaves the run without
  // memory_filing; at start such recent runs are filed again from their stored result blob.
  async function refileMissing(worker) {
    const now = Date.parse(worker.now());
    const due = [...worker.state.handoffs.values()].filter((h) => TERMINAL.has(h.state) && !h.memory_filing && h.result_ref && h.finished_at && now - Date.parse(h.finished_at) <= REFILE_WINDOW_MS).slice(-REFILE_MAX);
    for (const h of due) {
      let result = null;
      try { result = JSON.parse(getBlob(h.result_ref, worker.env)); } catch { result = null; }
      if (result) await fileMemory(worker, h.id, result);
    }
  }

  // Spec §6.1: repos/<repo>.docs.md, rewritten only when the checkout's tree differs from the cached one.
  async function cacheDocsMap(worker, repoId, checkout, rendered) {
    try {
      const treeHash = await git(checkout, ['rev-parse', 'HEAD^{tree}'], { timeoutMs: 15_000 });
      writeDocsProjection(quillHome(worker.env), repoId, { treeHash, rendered });
    } catch (err) { worker.log(`docs map not cached for ${repoId}: ${err.message}`); }
  }

  async function finish(worker, h, run, outcome) {
    try {
      await finishRun(worker, h, run, outcome);
    } finally {
      try { await cleanupRun(worker, h.id); } catch (err) { worker.log(`handoff cleanup failed: ${err.stack ?? err.message}`); }
    }
  }

  const repoPathOf = (h) => (ctx.config.repos[h.repo_id] && ctx.config.repos[h.repo_id].canonical_path) || null;

  async function dropWorktree(worker, h) {
    const dir = h.worktree_path;
    if (!dir) return;
    // The path comes from the store: only a directory inside this store's worktrees folder is deleted.
    if (!isUnder(path.join(handoffsDir(worker.env), 'worktrees'), dir)) { worker.log(`worktree path outside the worktrees folder, not removed: ${h.id}`); return; }
    if (!fs.existsSync(dir)) {
      if (!h.worktree_removed_at && worker.state.handoffs.has(h.id)) { await archiveSnapshots(worker, h.id); try { updateHandoff(worker, h.id, { worktree_removed_at: worker.now() }); } catch { /* ignore */ } }
      return;
    }
    const repoPath = repoPathOf(h);
    try {
      if (repoPath && fs.existsSync(repoPath)) await removeWorktreeFn({ repoPath, dir });
      else fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* checked below */ }
    // Stamped only when the directory is really gone (a lock on Windows can leave it); the next sweep retries.
    if (fs.existsSync(dir)) { worker.log(`worktree not removed yet, will retry: ${h.id}`); return; }
    if (worker.state.handoffs.has(h.id)) {
      await archiveSnapshots(worker, h.id);
      try { updateHandoff(worker, h.id, { worktree_removed_at: worker.now() }); } catch (err) { worker.log(`worktree removal not recorded: ${err.message}`); }
    }
  }

  // On a terminal state: the sandbox and any run file other than the ledger go (they can hold
  // grants or settings); a read-only run's checkout goes now, a fix run's stays for pruneOldWorktrees.
  // The ledger and log stay until retention, because they are the evidence for the result.
  async function cleanupRun(worker, id) {
    const h = worker.state.handoffs.get(id);
    if (!h || !TERMINAL.has(h.state) || running.has(id)) return;
    try { fs.rmSync(path.join(handoffsDir(worker.env), 'sandbox', id), { recursive: true, force: true }); } catch { /* ignore */ }
    try {
      const dir = handoffRunDir(worker.env, id);
      for (const name of fs.readdirSync(dir)) if (name !== 'ledger.jsonl') fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch { /* no run dir */ }
    if (!isFix(h)) await dropWorktree(worker, h);
    pruneRetention(Date.parse(worker.now()));
  }

  // Fix checkouts older than 7 days, and any leftover checkout of a finished read-only run or of a
  // run this store no longer knows (older releases never removed them). Running runs are never touched.
  async function pruneOldWorktrees(now) {
    const worker = currentWorker;
    if (!worker) return;
    const at = now ?? Date.parse(worker.now());
    const root = path.join(handoffsDir(worker.env), 'worktrees');
    let names = [];
    try { names = fs.readdirSync(root); } catch { names = []; }
    for (const name of names) {
      const dir = path.join(root, name);
      const h = worker.state.handoffs.get(name);
      if (running.has(name) || (h && !TERMINAL.has(h.state))) continue;
      let ageMs;
      if (h && h.finished_at) ageMs = at - Date.parse(h.finished_at);
      else { try { ageMs = at - fs.statSync(dir).mtimeMs; } catch { continue; } }
      const expired = Number.isFinite(ageMs) && ageMs >= FIX_WORKTREE_KEEP_MS;
      if (h ? (isFix(h) && !expired) : !expired) continue;
      await dropWorktree(worker, h ?? { id: name, worktree_path: dir, repo_id: null });
    }
    const repos = new Set(Object.values(ctx.config.repos ?? {}).map((r) => r && r.canonical_path).filter((p) => p && fs.existsSync(p)));
    for (const repoPath of repos) await pruneWorktrees(repoPath, { under: root });
  }

  // Run ledgers and handoff logs older than `[handoff] log_retention_days` (default 30) are deleted.
  // Age is from the run's finish time when the store knows the run, else from the file's mtime.
  function pruneRetention(now) {
    const worker = currentWorker;
    if (!worker) return;
    const at = now ?? Date.parse(worker.now());
    const cutoff = retentionDays(ctx.config) * 86_400_000;
    const stale = (id, file) => {
      if (running.has(id)) return false;
      const h = worker.state.handoffs.get(id);
      if (h && !TERMINAL.has(h.state)) return false;
      let t = h && h.finished_at ? Date.parse(h.finished_at) : NaN;
      if (!Number.isFinite(t)) { try { t = fs.statSync(file).mtimeMs; } catch { return false; } }
      return at - t > cutoff;
    };
    const sweep = (dir, idOf) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const id = idOf(name);
        if (id && stale(id, path.join(dir, name))) { try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* ignore */ } }
      }
    };
    sweep(path.join(handoffsDir(worker.env), 'runs'), (n) => n);
    sweep(path.join(logsDir(worker.env), 'handoffs'), (n) => (n.endsWith('.log') ? n.slice(0, -4) : null));
  }

  // For fix runs: collect changed files and a patch; perform explicitly permitted commit/push/PR.
  async function fixExtras(worker, h, { finalize = false, gate = null, testedTree = null } = {}) {
    const out = {};
    // ADR 0033: counts of the guard's decisions, for a run the guard watched (autonomous, full).
    if (['autonomous', 'full'].includes(h.access)) { try { out.guard_summary = guardSummary(readLedger(path.join(handoffRunDir(worker.env, h.id), 'ledger.jsonl'))); } catch { /* no summary */ } }
    if (!h.worktree_path || !fs.existsSync(h.worktree_path)) return out;
    try {
      out.changed_files = await changedFiles(h.worktree_path);
      out.change_summary = changeSummary(out.changed_files, changeGlobs(ctx.config.repos[h.repo_id]));
      const patch = await diffPatch(h.worktree_path);
      const patchPath = path.join(handoffsDir(worker.env), 'results', `${h.id}.patch`);
      fs.mkdirSync(path.dirname(patchPath), { recursive: true });
      fs.writeFileSync(patchPath, patch);
      out.patch_path = patchPath;
      // ADR 0040: the patch as a blob too, so the owner's dashboard can show it grouped.
      Object.assign(out, patchFields(patch, worker.env));
    } catch (err) {
      out.uncertain_effects = [...(h.uncertain_effects ?? []), `could not collect diff: ${err.message}`];
      return out;
    }
    if (!finalize || !out.changed_files.length) return out;
    const p = h.permissions ?? {};
    const repo = ctx.config.repos[h.repo_id] ? { id: h.repo_id, ...ctx.config.repos[h.repo_id] } : null;
    let receipt = null;
    try {
      if (p.commit) await takeSnapshot(worker, h.id, 'before-commit');
      if (p.commit) out.commit_sha = await commitAll(h.worktree_path, `handoff(${h.id.slice(0, 8)}): ${h.note || 'attempt fix'}`);
      // ADR 0033: the evidence is journaled before anything leaves the machine, so the receipt a
      // draft PR carries is built from journaled facts only.
      if (out.commit_sha) {
        try { out.commit_tree = await git(h.worktree_path, ['rev-parse', `${out.commit_sha}^{tree}`]); } catch { /* compared as not recorded */ }
        // A receipt is built only from evidence that reached the journal; without it the PR has none.
        try {
          updateHandoff(worker, h.id, { ...(gate ? { test_gate: gate } : {}), ...(testedTree ? { tested_tree: testedTree } : {}), commit_sha: out.commit_sha, ...(out.commit_tree ? { commit_tree: out.commit_tree } : {}), ...(out.guard_summary ? { guard_summary: out.guard_summary } : {}), change_summary: out.change_summary, changed_files: out.changed_files });
          if (p.push_branch && p.open_draft_pr) receipt = buildReceipt(worker.state, h.id);
        } catch (err) { worker.log(`evidence receipt not built for ${h.id}: ${err.message}`); }
      }
      if (p.push_branch && out.commit_sha) {
        try { await pushBranch(h.worktree_path, h.branch, repo); out.branch = h.branch; out.pushed_branch = h.branch; } catch (err) { out.uncertain_effects = [...(h.uncertain_effects ?? []), `push may have partially happened: ${err.message}`]; out.error = { code: 'push-failed', message: err.message }; return out; }
        if (p.open_draft_pr) {
          const body = `Draft opened by Session Quill handoff ${h.id} for ticket ${h.ticket_id}. Not a deployment.\n\n${gateLine(gate)}${receipt ? `\n\n${receipt.markdown}` : ''}`;
          try {
            out.pr_url = await openDraftPrFn(h.worktree_path, { branch: h.branch, base: repo ? repo.default_branch : 'main', title: `Handoff: ${h.note || h.id.slice(0, 8)}`, body });
            if (receipt) out.receipt = { sha256: receipt.sha256, through_sequence: receipt.through_sequence };
          } catch (err) { out.uncertain_effects = [...(h.uncertain_effects ?? []), `draft PR creation uncertain: ${err.message}`]; }
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
    const parsed = parseOutcome(outcome, { outputs: entry.outputs });
    if (parsed.is_error || parsed.no_result || !h.worktree_path) return { outcome, gate: null };
    let changed = [];
    try { changed = await changedFiles(h.worktree_path); } catch { /* treated as no diff */ }
    if (!changed.length) return { outcome, gate: { status: 'skipped', reason: 'no changes to test' } };
    const { command, timeoutMs } = testGateSettings(ctx.config.repos[h.repo_id]);
    if (!command) return { outcome, gate: { status: 'skipped', reason: 'no test_command for this repository; the fix is not test-verified' } };
    // An autonomous run's tests see the same redirected environment as its agent.
    const env = (entry.spawnExtras && entry.spawnExtras.childEnv) ?? childEnvFor(entry.permissions, process.env, entry.env);
    // The gate's command is the run's child while it runs: cancellation, the deadline and a worker
    // stop kill it through its own handle, and onStop waits for it (entry.done).
    const once = () => {
      const p = runTestCommand({ command, cwd: h.worktree_path, timeoutMs, env, onChild: (child, kill) => { entry.child = child; entry.kill = kill; } });
      entry.done = p;
      return p;
    };
    let total = 0;
    let attempts = 1;
    await takeSnapshot(worker, h.id, 'before-tests');
    let result = await once();
    total += result.ms;
    // Every attempt's exit code and time is kept (ADR 0033); the output tail only for the last.
    const runs = [{ status: result.status, exit_code: result.exit_code, ms: result.ms }];
    const timeLeft = () => !entry.deadlineAt || Date.parse(entry.deadlineAt) - Date.parse(worker.now()) >= 60_000;
    if (result.status !== 'passed' && !entry.reason && entry.sessionId && timeLeft() && remainingUsd(entry) <= 0) (entry.budgetNotes ??= []).push('test-repair-skipped-budget-spent');
    else if (result.status !== 'passed' && !entry.reason && entry.sessionId && timeLeft()) {
      await takeSnapshot(worker, h.id, 'before-test-repair');
      const next = await followUp(entry, testRepairPrompt(command, result, repeatNotice(worker.state, worker.state.handoffs.get(h.id) ?? h, result)), { tools: entry.tools, maxTurns: entry.budget.maxTurns, label: 'test-repair' });
      if (entry.reason) return { outcome, gate: null };
      const repaired = next ? parseOutcome(next, { outputs: entry.outputs }) : null;
      if (repaired && !repaired.no_result && !repaired.is_error && repaired.problems.length <= parsed.problems.length) outcome = next;
      attempts = 2;
      result = await once();
      total += result.ms;
      runs.push({ status: result.status, exit_code: result.exit_code, ms: result.ms });
    }
    if (entry.reason) return { outcome, gate: null };
    // The tree the passing run saw, written with a temporary index so the checkout's own index is
    // untouched (ADR 0033); compared later with the commit's tree. Carried out of the gate record.
    let testedTree = null;
    if (result.status === 'passed') { try { testedTree = await workingTree(h.worktree_path); } catch (err) { worker.log(`tested tree not recorded for ${h.id}: ${err.message}`); } }
    return { outcome, gate: { status: result.status, command, exit_code: result.exit_code, ms: result.ms, tail: result.tail, attempts, repaired: attempts > 1 && result.status === 'passed', runs, total_ms: total, ...(testedTree ? { tested_tree: testedTree } : {}) } };
  }

  // ADR 0040: with `[repos.<id>] critic = true`, a fresh read-only process (a new session: never a
  // resume of the run's own) reviews a fix whose worker tests passed. It reads the run's checkout
  // with the read-only profile and the run's own environment when it has one, its spend counts
  // against the run's cap, and nothing it does changes how the run ends. Null when not enabled.
  async function reviewRun(worker, entry, h, gate) {
    const repo = ctx.config.repos[h.repo_id];
    if (!criticSettings(repo).enabled) return null;
    const spawn = (prompt, { maxTurns, maxBudgetUsd }) => {
      const run = spawnAgent({ claudePath, claudeArgs, prompt, cwd: entry.cwd, tools: selfCheckTools({ read_source: true }), env: entry.env, childEnv: (entry.spawnExtras && entry.spawnExtras.childEnv) ?? null, permissions: { read_source: true }, logPath: entry.logPath, model, maxTurns, maxBudgetUsd, permissionMode: 'dontAsk', keepCredentials: false });
      // Tracked like any turn of the run, so a cancel or a stop also stops the critic.
      Object.assign(entry, { child: run.child, kill: null, done: run.done });
      return run;
    };
    const timeLeftMs = entry.deadlineAt ? Date.parse(entry.deadlineAt) - Date.parse(worker.now()) : Infinity;
    let result;
    try {
      result = await runCritic({ run: worker.state.handoffs.get(h.id) ?? h, ticket: worker.state.tickets.get(h.ticket_id) ?? { key: '', title: '' }, repo, gate, recipe: catalogFor(worker).builtin('critic-review'), budgetUsd: remainingUsd(entry), timeLeftMs, spawn, kill: killTree });
    } catch (err) { result = { status: 'failed', reason: `the critic step failed: ${err.message}`, findings: [], ms: null, outcome: null }; }
    addUsage(entry, result.outcome);
    return result;
  }

  async function dispatch(worker, h) {
    // How long the run waited for a slot (worker clock), then each setup step that actually ran.
    // A run that fails before it starts keeps whatever was measured (ADR 0022).
    const timings = { queue_wait_ms: Math.max(0, Date.parse(worker.now()) - Date.parse(h.requested_at)) };
    // A run that fails here is cleaned up when dispatch resolves (see tick): its slot is released first.
    const fail = (w, run, code, message) => failRun(w, run, code, message, { timings: { ...timings } });
    const ticket = worker.state.tickets.get(h.ticket_id);
    if (!ticket) return fail(worker, h, 'ticket-missing', 'ticket no longer exists');
    // The ticket's previous run records its terminal state just before its memory filing and Run
    // note land (cite reads are asynchronous): wait for them, bounded, before anything starts, so
    // this run's Memory section does not miss that note (spec §6.3).
    await settledWithin([...(filings.get(ticket.id) ?? [])], FINISH_WAIT_MS);
    // The run is still `queued` in the state during that wait: the owner may have cancelled it, or
    // the worker paused or began to stop. Such a run never starts and nothing is recorded for it;
    // a paused or stopped one stays queued for the next dispatch (review I3).
    if (!stillQueued(worker, h.id) || paused || stopping) return undefined;
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
    // A queued run keeps the access it was queued with.
    const access = h.access ?? 'standard';
    try {
      validateHandoffRequest({ mode: h.mode, note: h.note, permissions: h.permissions, branch: h.branch, access, scopes: h.scopes ?? null, ...(h.recipe ? { recipe: h.recipe.name } : {}) }, { repo: repoCfg, recipe: h.recipe ? recipe : null, actionPins: h.action_pins ?? null });
    } catch (err) {
      return fail(worker, h, err.code ?? 'permission-invalid', err.message);
    }
    const available = runtimeAvailable ?? detectRuntime(claudePath);
    if (!available) return fail(worker, h, 'runtime-missing', `Claude Code runtime (${claudePath}) is not installed or not on PATH; install and authenticate it, then retry as a new run`);
    // Autonomous runs rely on the guard hook failing closed, so the runtime must be new enough;
    // this is checked before any checkout or process exists (ADR 0026). Write scopes resolve here.
    let scopes = [];
    if (access === 'autonomous') {
      try { assertRuntime(await probeVersion()); } catch (err) { return fail(worker, h, err.code ?? 'runtime-too-old', err.message); }
      try { scopes = resolveScopes([...(h.scopes ?? [])], ctx.config, worker.env) ?? []; } catch (err) { return fail(worker, h, err.code ?? 'unknown-scope', err.message); }
      // An approved critical change (ADR 0028) runs only with the scopes exactly as approved: the
      // grant frozen below must hold the tables whose fingerprints the approval checked.
      const changed = scopeChanged(h, scopes);
      if (changed) return fail(worker, h, 'scope-changed', changed);
    }
    const needsSource = h.permissions && h.permissions.read_source;
    let cwd;
    let baseCommit = null;
    let base = null;
    let worktreePath = null;
    if (needsSource) {
      if (!repoCfg || !repoCfg.canonical_path || !fs.existsSync(repoCfg.canonical_path)) return fail(worker, h, 'repo-unavailable', 'source access requires the registered repository on this owner machine; it is not available');
      try {
        // The ticket's own branch when it can be found, else HEAD (spec §10).
        base = await worktreeBase(ticket, repoCfg);
        baseCommit = base.ref === 'HEAD' ? await headCommit(repoCfg.canonical_path) : base.ref;
        worktreePath = path.join(handoffsDir(worker.env), 'worktrees', h.id);
        const worktreeStarted = performance.now();
        try {
          await createWorktree({ repoPath: repoCfg.canonical_path, baseCommit, dir: worktreePath });
          updateHandoff(worker, h.id, { worktree_path: worktreePath });
        } finally { timings.worktree_ms = Math.round(performance.now() - worktreeStarted); }
      } catch (err) {
        return fail(worker, h, err.code === 'worktree-failed' ? 'worktree-failed' : 'source-failed', err.message);
      }
      cwd = worktreePath;
      await takeSnapshot(worker, h.id, 'start');
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
    const budget = budgetFor(recipe, ctx.config, access, h.mode, h);
    const timeoutMs = deadlineMs === null ? budget.timeoutMs : Math.min(deadlineMs, budget.timeoutMs);
    const deadlineAt = addMs(started, timeoutMs);
    const env = { ...spawnEnv, QUILL_HANDOFF_ID: h.id, QUILL_HANDOFF_TICKET_ID: ticket.id, QUILL_HANDOFF_TICKET_KEY: ticket.key };
    if (ctx.env && ctx.env.QUILL_HOME) env.QUILL_HOME = ctx.env.QUILL_HOME;
    // Spec §6.3: no run, whatever its access, writes into the owner's Claude Code memory.
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    let auto = null;
    let observe = null;
    if (access === 'autonomous') {
      try { auto = prepareAutonomous({ storeEnv: worker.env, config: ctx.config, handoff: h, cwd, checkout: worktreePath, repoCfg, scopes, env, startedAt: started }); } catch (err) { return fail(worker, h, err.code ?? 'grant-failed', `could not prepare the autonomous run: ${err.message}`); }
    } else if (access === 'full' && await observerSupported()) {
      // Full access is observed, never refused (spec §3, §7): the guard records what it would have
      // refused, and the run's prod_effects come from that ledger when it finishes. A Claude Code
      // older than the guard needs runs unobserved (review M6): its record then has no prod_effects.
      try { observe = prepareObserve({ storeEnv: worker.env, config: ctx.config, handoff: h, cwd, checkout: worktreePath, repoCfg, env }); } catch (err) { return fail(worker, h, err.code ?? 'grant-failed', `could not prepare the full-access observer: ${err.message}`); }
      Object.assign(env, observe.vars);
    }
    // A cancel, a pause or a stop can also land during the setup awaits above (version probe,
    // checkout): the run is still queued until the next line, so check once more (final review M7).
    // Its checkout and run files go with the run's cleanup; a paused or stopped run stays queued.
    if (!stillQueued(worker, h.id) || paused || stopping) return undefined;
    // The credential report is what the Run dialog's warnings rest on (Task 9): which systems got a
    // read-only profile, a stub or a scope, and what no redirect can close.
    // A scoped run records the fingerprints its grant was frozen with, so a resume of it (Task 19)
    // gets the scopes exactly as granted or is refused with scope-changed.
    const prints = access === 'autonomous' && scopes.length && !h.scope_fingerprints ? grantedFingerprints(scopes) : null;
    updateHandoff(worker, h.id, { state: 'running', started_at: started, deadline_at: deadlineAt, base_commit: baseCommit, worktree_path: worktreePath, log_path: logPath, timings, ...(auto ? { cred_report: auto.report } : {}), ...(prints ? { scope_fingerprints: prints } : {}) });
    const current = worker.state.handoffs.get(h.id);
    if (!current || current.state !== 'running') return undefined;
    // ADR 0041: memory learned in another run environment goes stale before this run's Memory is gathered.
    if (auto) staleRunEnv(worker, auto.report.env_fingerprint);
    const url = (ticket.external && ticket.external.url) || (ticket.jira && ticket.jira.url) || null;
    const environments = worker.environmentsFor ? worker.environmentsFor(ticket.repo_id) : repoCfg ? repoCfg.deployment_environments ?? [] : [];
    const render = (r) => renderRecipe(r, { ticket, url, note: h.note, prs: ticket.prs ?? [], deployments: ticket.deployments ?? [], environments });
    const context = gatherContext(worker.state, ticket, { env: worker.env, currentId: h.id, now: worker.now() });
    const inputs = !recipe || recipe.legacy ? null : new Set(recipe.inputs);
    // The diff is read from the run's own checkout, so it exists only with source access.
    if (worktreePath && (!inputs || inputs.has('work'))) context.diff = await gatherDiff(worktreePath, context.commits);
    if (staged) context.staged_files = staged;
    // The docs map is part of every run's Memory section (spec §6.3); a recipe's `docs` input only
    // decides whether a prompt without memory shows it on its own.
    let docsMap = null;
    if (worktreePath) {
      context.base_label = base ? base.label : null;
      try { docsMap = renderDocsMap(buildDocsMap(worktreePath)) || null; } catch { docsMap = null; }
      if (!inputs || inputs.has('docs')) context.docs = docsMap;
      if (docsMap && h.repo_id) await cacheDocsMap(worker, h.repo_id, worktreePath, docsMap);
    }
    // Spec §6.3: the ranked Memory section inline, and the full projections (minus quarantine) and
    // Run notes copied to <run-dir>/context/, which every run reads through --add-dir. Removed with
    // the run (cleanupRun). Delivery never fails a run.
    const contextDir = path.join(handoffRunDir(worker.env, h.id), 'context');
    let memoryDirs = [];
    try {
      // Bring the projections up to date with the state first (a no-op when nothing changed).
      if (typeof worker.publishMemory === 'function') worker.publishMemory();
      const mem = await gatherMemory(worker.state, worker.state.tickets.get(ticket.id) ?? ticket, { repoCfg, budgetBytes: inlineBudget(ctx.config), anchorRatio: anchorStaleRatio(ctx.config), checkout: worktreePath, commit: baseCommit, home: quillHome(worker.env), now: worker.now(), run: current, docs: docsMap, contextDir, log: (line) => worker.log(`${line} (run ${h.id})`) });
      writeContext({ state: worker.state, home: quillHome(worker.env), paths: mem.paths, contextDir, runNotes: mem.runNotes });
      memoryDirs = [contextDir];
      context.memory = mem.inline || null;
      context.guide = mem.guide;
    } catch (err) { worker.log(`memory not delivered to ${h.id}: ${err.stack ?? err.message}`); }
    // A resumed run (Task 19) continues the interrupted run's session: the session already holds the
    // task, so its first turn only says what changed. Everything else is set up as for any run.
    const resumeId = typeof h.resume_session_id === 'string' && h.resume_session_id ? h.resume_session_id : null;
    const prompt = resumeId ? resumePrompt({ contextDir: memoryDirs.length ? contextDir : null, checkout: !!worktreePath }) : buildPrompt(current, ticket, { repo: repoCfg, recipe, render, context });
    // Standard access keeps the recipe's own tool narrowing; settings and full access hand the
    // decision to Claude Code itself (ADR 0017).
    // Under autonomous access the guard decides, and a recipe's `tools` still narrows the built-in
    // tool families (R8).
    const rt = access === 'standard' ? { permissionMode: 'dontAsk', ...(recipe ? recipeTools(recipe, h.permissions ?? {}) : allowedToolsFor({ mode: h.mode, permissions: h.permissions })), keepCredentials: false } : runtimeAccess({ access, mode: h.mode, permissions: h.permissions ?? {}, tools: access === 'autonomous' && recipe ? recipe.tools : null });
    const tools = { allowed: rt.allowed, disallowed: rt.disallowed };
    const spawnExtras = auto ? { childEnv: auto.childEnv, settingsPath: auto.settingsPath, addDirs: [...new Set([...auto.addDirs, ...memoryDirs])], permissionPrompts: auto.permissionPrompts, mcpServersPath: auto.mcpServersPath } : observe ? { settingsPath: observe.settingsPath, mcpServersPath: observe.mcpServersPath, addDirs: memoryDirs } : { addDirs: memoryDirs };
    // The run's own directory holds its tool ledger (spec §5.4); every turn appends to it.
    const ledgerPath = path.join(handoffRunDir(worker.env, h.id), 'ledger.jsonl');
    const onInit = onInitFor(worker, h.id);
    // A run that may edit source always self-checks, whatever its recipe says (ADR 0022).
    const selfCheck = !!(recipe && recipe.self_check) || !!(h.permissions && h.permissions.edit_source);
    // R54: Claude Code finds a session only under the project folder of the cwd it was started in.
    // The interrupted run's transcript is copied to this run's cwd under the config root this child
    // sees; without it the run fails here, before anything is spawned.
    if (resumeId) {
      const orig = h.retry_of ? worker.state.handoffs.get(h.retry_of) : null;
      const fromCwd = orig ? orig.worktree_path || path.join(handoffsDir(worker.env), 'sandbox', orig.id) : null;
      try {
        carrySession({ configRoot: claudeConfigRoot(spawnExtras.childEnv ?? childEnvFor(h.permissions ?? {}, process.env, env, { keepCredentials: rt.keepCredentials })), sessionId: resumeId, fromCwd, toCwd: cwd });
      } catch (err) {
        return fail(worker, h, err.code ?? 'resume-session-missing', err.message);
      }
    }
    // The entry exists before the process does, so the init event always finds it.
    const entry = { child: null, done: null, reason: null, observed: !!observe, fix: isFix(h), deadlineAt, cwd, env, tools, logPath, ledgerPath, onInit, permissions: h.permissions ?? {}, selfCheck, sessionId: resumeId, outputs: recipe ? recipe.outputs : null, budget, timeoutMs, staged, permissionMode: rt.permissionMode, keepCredentials: rt.keepCredentials, access, spawnExtras };
    running.set(h.id, entry);
    let run;
    try {
      run = spawnAgent({ claudePath, claudeArgs, prompt, cwd, tools, env, permissions: h.permissions ?? {}, logPath, ledgerPath, onInit, model, resume: resumeId, maxTurns: budget.maxTurns, maxBudgetUsd: budget.maxBudgetUsd, permissionMode: rt.permissionMode, keepCredentials: rt.keepCredentials, ...spawnExtras });
    } catch (err) {
      running.delete(h.id);
      return fail(worker, h, 'spawn-failed', err.message);
    }
    Object.assign(entry, { child: run.child, done: run.done, spawnedAt: performance.now() });
    entry.finished = run.done.then((outcome) => finish(worker, current, run, outcome)).catch((err) => worker.log(`handoff finish failed: ${err.stack ?? err.message}`));
    const finished = entry.finished;
    finishing.add(finished);
    // By ticket too, so the ticket's next run can wait for this run's filing and Run note.
    const ofTicket = filings.get(ticket.id) ?? new Set();
    ofTicket.add(finished);
    filings.set(ticket.id, ofTicket);
    finished.then(() => {
      finishing.delete(finished);
      ofTicket.delete(finished);
      if (!ofTicket.size && filings.get(ticket.id) === ofTicket) filings.delete(ticket.id);
    });
  }

  // Whether this Claude Code takes the observer's hook (the guard's runtime floor).
  async function observerSupported() {
    try { assertRuntime(await probeVersion()); return true; } catch { return false; }
  }

  // Spec §5.2: a bulk batch starts no new member once its recorded spend reaches the budget; the
  // rest stay queued (the owner may cancel them). A member whose process has ended but whose cost
  // is not recorded yet (it is still finishing) holds the next one back, so spend is never missed.
  function batchMayStart(worker, batchId, budget) {
    const members = [...worker.state.handoffs.values()].filter((x) => x.batch_id === batchId);
    if (members.some((x) => x.state === 'running' && !running.has(x.id))) return false;
    return !batchBudgetReached(members, batchId, budget);
  }

  // ADR 0032: anchored memory against each registered repository's HEAD. Only when HEAD or the set
  // of anchored entries (their ids and anchor blobs) changed since the last check; an anchored region that changed by at least
  // `[memory] anchor_stale_ratio` is journaled as a `staled` memory-tx (deterministic source
  // identity, so a repeated check never journals twice). Pinned and owner entries are never
  // candidates (R27); a git failure stales nothing.
  async function checkAnchors(worker) {
    const ratio = anchorStaleRatio(ctx.config);
    for (const [repoId, cfg] of Object.entries(ctx.config.repos ?? {})) {
      if (stopping || !cfg || !cfg.canonical_path || !fs.existsSync(cfg.canonical_path)) continue;
      const entries = anchorCandidates(worker.state, repoId);
      if (!entries.length) continue;
      let head;
      try { head = await headCommit(cfg.canonical_path); } catch { continue; }
      const seen = anchorCheckKey(head, entries);
      if (anchorSeen.get(repoId) === seen) continue;
      const verdicts = await anchorVerdicts(entries, { checkout: cfg.canonical_path, commit: head, ratio, log: (line) => worker.log(`${line} (anchor check of ${repoId})`) });
      if (stopping) return;
      for (const [id, v] of verdicts) {
        const live = worker.state.memory.entries.get(id);
        if (v.verdict !== 'stale' || !v.anchor || !live || live.state !== 'active' || live.pinned === true || live.trust === 'owner') continue;
        const e = staledEvent(id, v.anchor);
        if (!(worker.journal && worker.journal.hasSource(e.source_identity))) worker.emit(e.kind, e.payload, { source_identity: e.source_identity });
      }
      anchorSeen.set(repoId, seen);
    }
  }

  // ADR 0041: at an autonomous dispatch, each live entry anchored to another run environment is
  // journaled stale (deterministic source identity, so one environment stales an entry once).
  function staleRunEnv(worker, fingerprint) {
    try {
      for (const e of runEnvStaleEvents(worker.state, fingerprint)) if (!(worker.journal && worker.journal.hasSource(e.source_identity))) worker.emit(e.kind, e.payload, { source_identity: e.source_identity });
    } catch (err) { worker.log(`run environment check failed: ${err.message}`); }
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
    pruneOldWorktrees,
    pruneRetention,
    cleanupRun: (id) => cleanupRun(currentWorker, id),
    sweepTicketWorktrees: () => ticketWorktrees.run(currentWorker, ctx.config),
    // The anchor check now, unthrottled (tests and embedders); tick runs it every ANCHOR_CHECK_MS.
    checkAnchors: () => checkAnchors(currentWorker),
    async onStart(worker) {
      // Each recipe carries its time cap per access level, from the same budget dispatch uses.
      worker.recipeInfo = () => catalogFor(worker).list().map((r) => (r.error ? r : { ...r, caps: recipeCaps(r, ctx.config) }));
      // The batch budget travels with the slot caps, so a held batch member's row can say why.
      worker.handoffLimits = () => ({ ...limits, batch_budget_usd: batchBudgetUsd(ctx.config) });
      worker.autonomyInfo = () => autonomyInfo(worker.state, ctx.config);
      currentWorker = worker;
      stopping = false;
      for (const h of [...worker.state.handoffs.values()]) {
        if (h.state !== 'running') continue;
        // The recorded session id and the partial ledger stay (spec §5.4): the owner may resume the
        // run as a new one, and its allowed writes are listed as possibly run (owner only, R55).
        const effects = mayHaveRun(worker, h.id);
        recordResult(worker, h.id, { summary: null }, { state: 'failed', error: { code: 'interrupted', message: 'worker restarted while the run was in progress; no automatic rerun' }, extra: effects.length ? { possible_writes: effects } : {} });
      }
      try { await refileMissing(worker); } catch (err) { worker.log(`memory refiling failed: ${err.message}`); }
      // A stop between a done run's handoff-tx and its critical-proposal events (spec §7.2, R47 M2).
      try { reemitMissingCriticalProposals(worker); } catch (err) { worker.log(`critical proposals not re-emitted: ${err.message}`); }
      // Housekeeping at start: checkouts past their keep time, stale registrations, old ledgers and logs.
      try { await pruneOldWorktrees(); pruneRetention(); } catch (err) { worker.log(`handoff housekeeping failed: ${err.message}`); }
      // Not awaited (ADR 0030 fast start): the sweep runs `git status` per due worktree. It logs and
      // records its own failure; a stop waits for it.
      ticketWorktrees.run(worker, ctx.config);
    },
    tick(worker) {
      if (paused) return;
      ticketWorktrees.tick(worker, ctx.config);
      const now = worker.now();
      for (const h of worker.state.handoffs.values()) {
        if (h.cancel_requested && h.state === 'running' && running.has(h.id) && running.get(h.id).reason === null) killWithReason(h.id, 'cancel');
      }
      for (const [id, entry] of running) {
        if (entry.reason === null && entry.deadlineAt && now >= entry.deadlineAt) killWithReason(id, 'timeout');
      }
      if (!anchorCheck && (anchorCheckAt === null || Date.parse(now) - anchorCheckAt >= ANCHOR_CHECK_MS)) {
        anchorCheckAt = Date.parse(now);
        anchorCheck = checkAnchors(worker).catch((err) => worker.log(`anchor check failed: ${err.message}`)).finally(() => { anchorCheck = null; });
      }
      const batchBudget = batchBudgetUsd(ctx.config);
      for (const h of nextDispatchable(worker.state, { running: new Set(running.keys()) })) {
        const fix = isFix(h);
        if (inUse(fix) >= (fix ? limits.fix : limits.readonly)) continue;
        if (h.batch_id && !batchMayStart(worker, h.batch_id, batchBudget)) continue;
        running.set(h.id, { child: null, done: null, reason: null, deadlineAt: null, fix });
        const p = dispatch(worker, h).then(() => { if (running.has(h.id) && !running.get(h.id).child) running.delete(h.id); return cleanupRun(worker, h.id); }).catch((err) => { running.delete(h.id); worker.log(`dispatch failed: ${err.stack ?? err.message}`); failRun(worker, h, 'dispatch-failed', err.message); cleanupRun(worker, h.id).catch(() => {}); });
        dispatches.set(h.id, p);
        p.finally(() => { if (dispatches.get(h.id) === p) dispatches.delete(h.id); });
      }
    },
    async onStop(worker, { abandonRuns = false } = {}) {
      // A run still waiting in dispatch for an earlier filing must not start once a stop began.
      stopping = true;
      await ticketWorktrees.idle();
      if (abandonRuns) { running.clear(); return; }
      // M7: a dispatch still setting up (no process yet) returns once it sees `stopping`, or has just
      // spawned: wait for it, bounded, so no run starts after the stop and a fresh child is stopped below.
      const setting = [...dispatches.entries()].filter(([id]) => !(running.get(id) && running.get(id).child)).map(([, p]) => p);
      if (setting.length) {
        let timer;
        await Promise.race([Promise.allSettled(setting), new Promise((r) => { timer = setTimeout(r, FINISH_WAIT_MS); })]);
        clearTimeout(timer);
      }
      const pending = [];
      for (const [id, entry] of running) {
        // Wait for the whole finish, not just the process: it may be in a follow-up turn or the
        // test gate, and its outcome must reach the journal before the worker stops.
        if (entry.child) { killWithReason(id, 'stopped'); pending.push(entry.done, entry.finished); }
      }
      await Promise.all(pending);
      if (anchorCheck) await settledWithin([anchorCheck], FINISH_WAIT_MS);
      // Runs that already left `running` may still be filing their memory: wait for them, bounded.
      if (finishing.size) {
        let timer;
        await Promise.race([Promise.allSettled([...finishing]), new Promise((r) => { timer = setTimeout(r, FINISH_WAIT_MS); })]);
        clearTimeout(timer);
      }
      // give finish() handlers a tick to journal their outcomes
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}
