// CI watch (ADR 0039, FR-4.4): the worker polls the CI checks of pull requests Quill runs opened on
// GitHub in the last 7 days, journals each change it sees as a worker-only `ci-observation`, and for
// a failing commit stages at most one worker-only `ci-proposal` (two per pull request): an
// attempt-fix run on the same branch that only the owner can approve, on the dashboard. Nothing
// here queues, approves or pushes anything. It runs from the handoff extension's tick, at most once
// per `[ci] interval_minutes`, one sweep at a time, and only journals when something changed.
//
// The failing log tail is untrusted tool output that may hold secrets: it is redacted with the run
// ledger's redaction, every instruction-like line is withheld, and it is cut to 4096 characters
// before it reaches the journal. It stays local (the proposal and the fix run's record) and reaches
// the fix run's prompt only as labelled data inside the data fence.
import { createHash } from 'node:crypto';
import { MINUTE } from '../lib/time.js';
import { repoFor } from '../core/state.js';
import { ciSettings } from '../config/config.js';
import { defaultProviders } from '../reconcile/providers/index.js';
import { ciProposalId, ciProposalsOf, ciCheckName, CI_LOG_MAX, CI_PROPOSALS_PER_PR } from '../core/reduce/ci.js';
import { isProtectedBranch } from './permissions.js';
import { redactLog } from './stream.js';
import { instructionLike } from '../memory/instructions.js';

export const CI_WATCH_WINDOW_MS = 7 * 24 * 60 * MINUTE;
export const CI_WATCH_MAX_PRS = 50;
export const WITHHELD_LINE = '[line withheld: instruction-like text]';
// A check name reaches the fix run's prompt too, so it passes the same filter.
export const WITHHELD_NAME = '[name withheld: instruction-like text]';
const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const PRE_CUT = 16 * 1024;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const TERMINAL_PR = new Set(['merged', 'closed']);

/**
 * The redacted, filtered last part of a CI log: `{ text, withheld }`, text at most `max` characters
 * (null when nothing is left), withheld the number of instruction-like lines replaced by a marker.
 * Cuts fall on line boundaries, so no cut splits a secret the redaction would have recognised.
 */
export function ciLogTail(raw, max = CI_LOG_MAX) {
  let s = String(raw ?? '').replace(/\r\n?/g, '\n').replace(ANSI, '');
  if (s.length > PRE_CUT) { s = s.slice(-PRE_CUT); const i = s.indexOf('\n'); s = i >= 0 ? s.slice(i + 1) : ''; }
  s = redactLog(s);
  s = s.split('\n').map((line) => (instructionLike(line) ? WITHHELD_LINE : line.replace(CONTROL, ''))).join('\n').replace(/^\n+|\s+$/g, '');
  if (s.length > max) { s = s.slice(-max); const i = s.indexOf('\n'); s = i >= 0 ? s.slice(i + 1) : ''; }
  const withheld = s.split('\n').filter((l) => l === WITHHELD_LINE).length;
  return { text: s || null, withheld };
}

const prRecord = (state, h) => {
  const t = state.tickets.get(h.ticket_id);
  return t ? (t.prs ?? []).find((p) => p.url === h.pr_url) ?? null : null;
};

/**
 * Runs whose pull request the watch polls: done, opened a GitHub PR, finished in the last 7 days,
 * not themselves a CI fix, on an open ticket, and whose PR is not known to be merged or closed.
 * Newest first, at most CI_WATCH_MAX_PRS.
 */
export function watchedRuns(state, nowIso) {
  const now = Date.parse(nowIso);
  const out = [];
  for (const h of state.handoffs.values()) {
    if (h.state !== 'done' || h.origin === 'ci' || typeof h.pr_url !== 'string' || !GITHUB_PR_URL.test(h.pr_url)) continue;
    const at = Date.parse(h.finished_at ?? h.requested_at);
    if (!Number.isFinite(at) || now - at > CI_WATCH_WINDOW_MS) continue;
    const t = state.tickets.get(h.ticket_id);
    if (!t || t.status === 'done') continue;
    if (h.ci && TERMINAL_PR.has(h.ci.pr_state)) continue;
    const pr = prRecord(state, h);
    if (pr && TERMINAL_PR.has(pr.state)) continue;
    out.push(h);
  }
  return out.sort((a, b) => String(b.finished_at ?? '').localeCompare(String(a.finished_at ?? ''))).slice(0, CI_WATCH_MAX_PRS);
}

// 16 hex of the observation's facts (never a log: the payload holds only states and check names).
const observationDigest = (payload) => createHash('sha256').update(JSON.stringify([payload.pr_url, payload.head_sha, payload.head_branch, payload.pr_state, payload.state, payload.checks])).digest('hex').slice(0, 16);

const failingNames = (checks) => checks.filter((c) => c.state === 'failed').map((c) => c.name);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function changed(prev, seen) {
  if (!prev) return true;
  return prev.head_sha !== seen.head_sha || prev.state !== seen.state || prev.pr_state !== seen.pr_state || prev.head_branch !== seen.head_branch || !same(prev.failing ?? [], failingNames(seen.checks));
}

// Why the watch stages no fix for this failing commit, or null when it may.
export function proposalBlocker(state, h, repo) {
  const ci = h.ci;
  if (!ci || ci.state !== 'failing' || TERMINAL_PR.has(ci.pr_state)) return 'not-failing';
  if (state.runProposals.has(ciProposalId(h.id, ci.head_sha))) return 'already-proposed';
  if (ciProposalsOf(state, h.id).length >= CI_PROPOSALS_PER_PR) return 'limit';
  if (!h.pushed_branch || ci.head_branch !== h.pushed_branch) return 'branch-mismatch';
  if (isProtectedBranch(ci.head_branch, repo)) return 'branch-protected';
  const t = state.tickets.get(h.ticket_id);
  if (!t || t.status === 'done') return 'ticket-done';
  return null;
}

/** One pass over the watched pull requests; returns what it did, for logs and tests. */
export async function sweepCi(worker, config, { providerFor = null, refused = new Map() } = {}) {
  const out = { polled: 0, observed: 0, proposed: 0, errors: [] };
  if (!ciSettings(config).watch) return out;
  const providers = providerFor ? { for: providerFor } : defaultProviders(config, worker.env);
  for (const run of watchedRuns(worker.state, worker.now())) {
    const repo = repoFor(worker.state, run.repo_id);
    const provider = providers.for(repo);
    // GitHub only; Bitbucket CI is deferred (ADR 0039).
    if (!provider || provider.name !== 'github' || typeof provider.fetchChecks !== 'function') continue;
    let seen;
    try {
      out.polled += 1;
      seen = await provider.fetchChecks(run.pr_url);
    } catch (err) {
      out.errors.push({ handoff_id: run.id, error: err.message });
      continue;
    }
    const h = worker.state.handoffs.get(run.id);
    if (!h || h.state !== 'done') continue;
    if (!seen || typeof seen.head_branch !== 'string' || !Array.isArray(seen.checks)) { out.errors.push({ handoff_id: h.id, error: 'no head branch' }); continue; }
    // As the record keeps them, so an unchanged check list is never journaled again.
    seen = { ...seen, checks: seen.checks.slice(0, 30).map((c) => ({ ...c, name: ciCheckName(c.name) })) };
    if (changed(h.ci, seen)) {
      const n = (h.ci ? h.ci.n : 0) + 1;
      const payload = { handoff_id: h.id, n, pr_url: h.pr_url, head_sha: seen.head_sha, head_branch: seen.head_branch, pr_state: seen.pr_state, state: seen.state, checks: seen.checks.map((c) => ({ name: c.name, state: c.state })) };
      // The source identity names the observed facts too: a refused observation is journaled once
      // and never re-sent while the facts stay the same, and a later, different one is not taken
      // for a duplicate of it (the reducer marks a refused event's identity applied as well).
      const sourceIdentity = `ci-observation:${h.id}:${n}:${observationDigest(payload)}`;
      if (refused.get(h.id) === sourceIdentity) continue;
      if (worker.journal && worker.journal.hasSource(sourceIdentity)) {
        refused.set(h.id, sourceIdentity);
        out.errors.push({ handoff_id: h.id, error: 'ci-observation-refused-before' });
        continue;
      }
      try {
        const { result } = worker.emit('ci-observation', payload, { ticket_id: h.ticket_id, source_identity: sourceIdentity });
        if (result.rejected || result.duplicate) { refused.set(h.id, sourceIdentity); out.errors.push({ handoff_id: h.id, error: result.rejected ?? 'ci-observation-duplicate' }); continue; }
        refused.delete(h.id);
        out.observed += 1;
      } catch (err) { out.errors.push({ handoff_id: h.id, error: err.message }); continue; }
    }
    const current = worker.state.handoffs.get(h.id);
    if (proposalBlocker(worker.state, current, repo)) continue;
    const ci = current.ci;
    const failedChecks = seen.checks.filter((c) => c.state === 'failed');
    let log = { text: null, withheld: 0 };
    const withLog = failedChecks.find((c) => c.run_id);
    if (withLog && typeof provider.fetchFailedLog === 'function') {
      try { log = ciLogTail(await provider.fetchFailedLog(h.pr_url, withLog)); } catch (err) { worker.log(`CI log of ${h.pr_url} not read: ${err.message}`); }
    }
    const id = ciProposalId(h.id, ci.head_sha);
    try {
      const { result } = worker.emit('ci-proposal', { id, handoff_id: h.id, pr_url: h.pr_url, head_sha: ci.head_sha, head_branch: ci.head_branch, failing: ci.failing.slice(0, 10).map((n) => (instructionLike(n) ? WITHHELD_NAME : n)), log_tail: log.text, log_withheld: log.withheld }, { ticket_id: h.ticket_id, source_identity: `ci-proposal:${id}` });
      if (result.rejected) out.errors.push({ handoff_id: h.id, error: result.rejected });
      else if (!result.duplicate) out.proposed += 1;
    } catch (err) { out.errors.push({ handoff_id: h.id, error: err.message }); }
  }
  return out;
}

/** A watch that sweeps at most once per `[ci] interval_minutes` from the tick, one sweep at a time. */
export function createCiWatch({ providerFor = null } = {}) {
  let last = -Infinity;
  let inFlight = null;
  // handoff id -> the source identity of the observation the reducer last refused for it: skipped,
  // without a journal line or a log, until what the watch sees changes.
  const refused = new Map();
  const run = (worker, config) => {
    if (inFlight) return inFlight;
    last = Date.parse(worker.now());
    inFlight = sweepCi(worker, config, { providerFor, refused })
      .then((r) => { if (r.errors.length) worker.log(`CI watch: ${r.errors.length} pull request(s) not observed (${r.errors[0].error})`); return r; })
      .catch((err) => { worker.log(`CI watch failed: ${err.message}`); return null; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    run,
    tick(worker, config) {
      const settings = ciSettings(config);
      if (!settings.watch || inFlight || Date.parse(worker.now()) - last < settings.intervalMinutes * MINUTE) return;
      run(worker, config);
    },
    async idle() { if (inFlight) await inFlight; },
  };
}
