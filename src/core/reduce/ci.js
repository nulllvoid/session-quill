// CI watch (ADR 0039, FR-4.4): the worker polls the checks of pull requests Quill runs opened and
// journals what it saw (`ci-observation`), and for a failing commit it may stage one fix proposal
// (`ci-proposal`). Both kinds are worker-only (R59). The reducer checks only what replay can check
// the same way forever: the producer, the payload's structure and caps, the deterministic id, the
// observation sequence, and that the run and its recorded CI state match. It never reads a log,
// calls a provider or decides whether a branch is protected (the worker did that when it emitted
// the event, and the approval and dispatch check it again).
// Everything here is local only: the run's `ci` record and the proposal never reach an export.
import { deterministicId } from '../../lib/ids.js';
import { timelineEntry } from './common.js';
import { pruneProposals } from './integrations.js';
import { branchNameOk } from '../../lib/git-ref.js';

export const CI_STATES = ['failing', 'pending', 'passing', 'none'];
export const CI_PR_STATES = ['open', 'draft', 'merged', 'closed', 'unknown'];
export const CI_CHECK_STATES = ['failed', 'pending', 'passed', 'skipped'];
export const CI_LOG_MAX = 4096;
export const CI_PROPOSALS_PER_PR = 2;
export const CI_RECIPE = Object.freeze({ name: 'attempt-fix', source: 'builtin' });
// What an approved CI fix may do: edit, commit and push to the PR's own branch. Never a new PR.
export const CI_PERMISSIONS = Object.freeze({ read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: false, edit_files: false, delete_files: false });
const LIMITS = Object.freeze({ id: 64, checks: 30, checkName: 120, failing: 10 });
const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const oneLine = (v, max) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// Any branch git accepts (git's ref-format rules, at most 255 characters): GitHub allows `fix/#123`.
const branchOk = branchNameOk;

/** A check name as the run's record keeps it: one line of at most 120 characters. */
export const ciCheckName = (name) => oneLine(name, LIMITS.checkName);

/** The id of a run's fix proposal for one head commit: at most one per commit. */
export const ciProposalId = (handoffId, headSha) => deterministicId(`${handoffId}:ci:${headSha}`);

/** The run's CI fix proposals, ever (still in state), oldest first. */
export function ciProposalsOf(state, handoffId) {
  return [...(state.runProposals ?? new Map()).values()].filter((p) => p.origin === 'ci' && p.from_handoff_id === handoffId).sort((a, b) => (a.proposed_at < b.proposed_at ? -1 : a.proposed_at > b.proposed_at ? 1 : 0));
}

function validChecks(list) {
  if (!Array.isArray(list) || list.length > LIMITS.checks) return null;
  const out = [];
  for (const c of list) {
    if (!isPlainObject(c) || !text(c.name, 1000) || !CI_CHECK_STATES.includes(c.state)) return null;
    out.push({ name: oneLine(c.name, LIMITS.checkName), state: c.state });
  }
  return out;
}

// Why an open proposal lapses after this observation, or null while it still stands.
function lapseReason(p, obs) {
  if (obs.pr_state === 'merged') return 'pr-merged';
  if (obs.pr_state === 'closed') return 'pr-closed';
  if (p.ci.head_sha !== obs.head_sha) return 'head-changed';
  if (obs.state === 'passing') return 'ci-passed';
  return null;
}

/**
 * How the run's pull request is recorded ended, or null while it is not: 'merged' or 'closed', from
 * the CI watch's latest observation, the reconciler's observation of the run's own PR
 * (`pr_observed`) or the ticket's PR record of the same URL. Pure; the approval checks it too.
 */
export function ciPrEnded(state, h) {
  if (!h) return null;
  const t = state.tickets.get(h.ticket_id);
  const pr = t && typeof h.pr_url === 'string' ? (t.prs ?? []).find((x) => x && x.url === h.pr_url) : null;
  for (const s of [isPlainObject(h.ci) ? h.ci.pr_state : null, isPlainObject(h.pr_observed) ? h.pr_observed.state : null, pr ? pr.state : null]) {
    if (s === 'merged' || s === 'closed') return s;
  }
  return null;
}

/**
 * After a reconcile: each open CI fix proposal whose run's pull request is now recorded merged or
 * closed lapses (`pr-merged`, `pr-closed`), even when the CI watch no longer polls that PR.
 */
export function lapseCiProposalsOnEndedPr(state, ev, result) {
  for (const x of (state.runProposals ?? new Map()).values()) {
    if (x.origin !== 'ci' || x.state !== 'proposed' || x.lapsed_at) continue;
    const ended = ciPrEnded(state, state.handoffs.get(x.from_handoff_id));
    if (!ended) continue;
    x.lapsed_at = ev.occurred_at;
    x.lapse_reason = ended === 'merged' ? 'pr-merged' : 'pr-closed';
    result.handoffsChanged.add(x.from_handoff_id);
  }
}

export function applyCiObservation(state, ev, result) {
  if (ev.producer !== 'worker') return { rejected: 'ci-observation-source' };
  const p = ev.payload;
  if (!isPlainObject(p) || !text(p.handoff_id, LIMITS.id) || !Number.isInteger(p.n) || p.n < 1 || !text(p.pr_url, 300) || !PR_URL_RE.test(p.pr_url)
    || typeof p.head_sha !== 'string' || !SHA_RE.test(p.head_sha) || !branchOk(p.head_branch) || !CI_PR_STATES.includes(p.pr_state) || !CI_STATES.includes(p.state)) return { rejected: 'ci-observation-invalid' };
  const checks = validChecks(p.checks ?? []);
  if (!checks) return { rejected: 'ci-observation-invalid' };
  const h = state.handoffs.get(p.handoff_id);
  if (!h) return { rejected: 'handoff-unknown' };
  if (h.pr_url !== p.pr_url) return { rejected: 'ci-pr-mismatch' };
  // Observations of one run apply in order: each names the next number.
  const prev = isPlainObject(h.ci) ? h.ci : null;
  if (p.n !== (prev ? prev.n : 0) + 1) return { rejected: 'ci-observation-out-of-order' };
  const same = prev && prev.head_sha === p.head_sha && prev.state === p.state;
  h.ci = {
    n: p.n, pr_url: p.pr_url, head_sha: p.head_sha, head_branch: p.head_branch, pr_state: p.pr_state, state: p.state, checks,
    failing: checks.filter((c) => c.state === 'failed').map((c) => c.name),
    observed_at: ev.occurred_at, since: same ? prev.since : ev.occurred_at,
  };
  for (const x of ciProposalsOf(state, h.id)) {
    if (x.state !== 'proposed' || x.lapsed_at) continue;
    const why = lapseReason(x, h.ci);
    if (why) { x.lapsed_at = ev.occurred_at; x.lapse_reason = why; }
  }
  result.handoffsChanged.add(h.id);
  return {};
}

export function applyCiProposal(state, ev, result) {
  if (ev.producer !== 'worker') return { rejected: 'ci-proposal-source' };
  const p = ev.payload;
  if (!isPlainObject(p) || !text(p.id, LIMITS.id) || !text(p.handoff_id, LIMITS.id) || typeof p.head_sha !== 'string' || !SHA_RE.test(p.head_sha)
    || !branchOk(p.head_branch) || !text(p.pr_url, 300) || !PR_URL_RE.test(p.pr_url)) return { rejected: 'ci-proposal-invalid' };
  if (p.log_tail !== null && p.log_tail !== undefined && !text(p.log_tail, CI_LOG_MAX, 0)) return { rejected: 'ci-proposal-invalid' };
  if (p.log_withheld !== undefined && !(Number.isInteger(p.log_withheld) && p.log_withheld >= 0)) return { rejected: 'ci-proposal-invalid' };
  if (!Array.isArray(p.failing ?? []) || (p.failing ?? []).length > LIMITS.failing || (p.failing ?? []).some((n) => !text(n, 1000))) return { rejected: 'ci-proposal-invalid' };
  if (p.id !== ciProposalId(p.handoff_id, p.head_sha)) return { rejected: 'ci-id-mismatch' };
  if (state.runProposals.has(p.id)) return { duplicate: true };
  const h = state.handoffs.get(p.handoff_id);
  if (!h) return { rejected: 'handoff-unknown' };
  const ci = isPlainObject(h.ci) ? h.ci : null;
  // Proposed only for the commit the latest observation recorded failing, on the branch the run pushed.
  if (!ci || ci.state !== 'failing' || ci.head_sha !== p.head_sha || ci.pr_url !== p.pr_url || h.pr_url !== p.pr_url) return { rejected: 'ci-not-failing' };
  if (ci.head_branch !== p.head_branch || h.pushed_branch !== p.head_branch) return { rejected: 'ci-branch-mismatch' };
  if (ciProposalsOf(state, h.id).length >= CI_PROPOSALS_PER_PR) return { rejected: 'ci-proposal-limit' };
  const t = state.tickets.get(h.ticket_id);
  if (!t) return { rejected: 'ticket-unknown' };
  if (t.status === 'done') return { rejected: 'ticket-done' };
  pruneProposals(state, ev.occurred_at);
  state.runProposals.set(p.id, {
    id: p.id, ticket_id: t.id, origin: 'ci', from_handoff_id: h.id, publisher: null, editor: null, edited_at: null,
    recipe: { ...CI_RECIPE, hash: null }, mode: 'attempt-fix', permissions: { ...CI_PERMISSIONS },
    // Never wider than the run that opened the PR: autonomous stays autonomous (without its scopes), anything else is standard.
    access: h.access === 'autonomous' ? 'autonomous' : 'standard', read_only: false,
    ci: {
      pr_url: p.pr_url, head_sha: p.head_sha, head_branch: p.head_branch, observation_n: ci.n,
      failing: (p.failing ?? []).map((n) => oneLine(n, LIMITS.checkName)),
      log_tail: typeof p.log_tail === 'string' && p.log_tail ? p.log_tail : null,
      log_withheld: Number.isInteger(p.log_withheld) ? p.log_withheld : 0,
    },
    expected_revision: null, proposed_at: ev.occurred_at, lapsed_at: null, lapse_reason: null, state: 'proposed', resolved_at: null, resolved_by: null, request_id: null, handoff_id: null,
  });
  // Like a page proposal: on the timeline without a revision bump. No check names or log text here,
  // since the timeline reaches prompts. `local_only`: the line stays on the owner's dashboard, never
  // in an export, the mirror or a vault note (exports gain nothing from the CI watch).
  t.timeline.push({ ...timelineEntry(ev, 'proposal', `CI failed on commit ${p.head_sha.slice(0, 7)} of the pull request run ${String(h.id).slice(0, 8)} opened; a fix run is proposed and waits for your approval`), local_only: true });
  result.changed.add(t.id);
  return {};
}
