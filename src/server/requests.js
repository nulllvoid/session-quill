// Durable, revision-checked mutation requests (DATA-CONTRACT §Mutation request).
import { createHash } from 'node:crypto';
import { isUuid, uuid, deterministicId } from '../lib/ids.js';
import { addMs, isIsoZ } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';
import { TICKET_STATUSES, repoFor, hasUnboundWork } from '../core/state.js';
import { outstandingObligations } from '../core/transitions.js';
import { validateHandoffRequest } from '../handoff/permissions.js';
import { budgetFor } from '../handoff/runner.js';
import { scopeValidator, loadScopeCatalog, resolveScopes, leaseMinutes } from '../handoff/scopes.js';
import { attachedFiles, undoFileEffect } from '../handoff/files.js';
import { validateKey } from '../core/keys.js';
import { renderUrl, isSafeExternalUrl, externalTicketId, TRACKER_SYSTEMS } from '../core/external-keys.js';
import { scopeFor } from '../hooks/scope.js';
import { catalogFor } from '../agents/recipes.js';
import { EVIDENCE_KINDS } from '../deploy/environments.js';
import { suggestionMutation } from '../agents/suggestions.js';
import { DISMISS_REASON_CHARS } from '../core/reduce/requests.js';
import { parseRemote } from '../onboard/remotes.js';
import { onboardSettings } from '../onboard/settings.js';
import { proposalState, proposalProvenance, shadowProblem } from '../publish/run-proposals.js';
import { resumeProblem, resumeFields } from '../handoff/resume.js';
import { restoreTarget, evaluateRestore } from '../handoff/snapshots.js';

export const EDIT_DELAY_MS = 10_000;
export const KINDS = ['set-next-action', 'set-status', 'record-deployment', 'handoff', 'handoff-cancel', 'refresh', 'attach-unbound', 'dismiss-unbound', 'link-external', 'run-job', 'accept-suggestion', 'dismiss-suggestion', 'publish', 'repo-clone', 'approve-run', 'dismiss-run', 'memory-approve', 'memory-edit', 'memory-forget', 'memory-pin', 'memory-note', 'resume-run'];
// Owner review of memory (spec §6.4, ADR 0027). Entry kinds target a memory entry by id and are
// revision-checked against it; memory-note adds an owner entry. Approve and edit belong to the
// dashboard alone; forget, pin and note may also come from the owner's CLI; nothing else qualifies.
export const MEMORY_KINDS = new Set(['memory-approve', 'memory-edit', 'memory-forget', 'memory-pin', 'memory-note']);
const MEMORY_ENTRY_KINDS = new Set(['memory-approve', 'memory-edit', 'memory-forget', 'memory-pin']);
const DASHBOARD_ONLY = { 'memory-approve': 'memory-approve-dashboard-only', 'memory-edit': 'memory-edit-dashboard-only' };
const MEMORY_TEXT_MAX = 2000;
const QUARANTINED_PIN = 'a quarantined learning is not delivered to runs, so it cannot be pinned; approve it first';
// Run by the scheduler extension rather than by applyDueRequests (ADR 0007).
const SCHEDULER_KINDS = new Set(['refresh', 'run-job', 'publish']);
// Long-running requests owned by an extension: the scheduler's, and repo-clone (ADR 0024).
const EXTENSION_KINDS = new Set([...SCHEDULER_KINDS, 'repo-clone']);
const TICKET_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment', 'handoff', 'handoff-cancel', 'link-external', 'accept-suggestion', 'dismiss-suggestion', 'undo-file-effect', 'repo-clone', 'approve-run', 'dismiss-run', 'resume-run']);
// Inbox actions target a session and are revision-checked against its unlinked work (ADR 0006).
const SESSION_KINDS = new Set(['attach-unbound', 'dismiss-unbound']);
const REVISION_OPTIONAL = new Set(['handoff-cancel', 'dismiss-suggestion', 'undo-file-effect', 'repo-clone', 'approve-run', 'dismiss-run', 'resume-run']);
const DELAYED_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment', 'attach-unbound', 'dismiss-unbound', 'link-external', 'accept-suggestion', 'dismiss-suggestion', 'dismiss-run', 'memory-forget']);
const EXTERNAL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
// Run snapshots (ADR 0035): restore one into the run's checkout. A ticket request without a
// revision check, with the 10 s undo; applied on the owner's dashboard only (evaluateRestore).
KINDS.push('restore-snapshot');
for (const set of [TICKET_KINDS, REVISION_OPTIONAL, DELAYED_KINDS]) set.add('restore-snapshot');

// Tracker keys are uppercase (PROJ-123). Requests normalize them, and lookups also match legacy
// keys that differ only in case, so "proj-42" can never become a second ticket beside PROJ-42.
function keyOwner(state, key) {
  const exact = state.keyIndex.get(key);
  if (exact) return exact;
  const upper = key.toUpperCase();
  for (const [k, id] of state.keyIndex) if (k.toUpperCase() === upper) return id;
  return null;
}
const TERMINAL = new Set(['applied', 'conflict', 'failed', 'cancelled']);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function bodyHash(body) {
  return createHash('sha256').update(stableStringify({ kind: body.kind, target_id: body.target_id ?? null, expected_revision: body.expected_revision ?? null, payload: body.payload ?? {} })).digest('hex');
}

function normalizeDeploymentItems(items, ticket, { requireChoice } = {}) {
  if (!Array.isArray(items) || !items.length) throw new TrackerError('request-invalid', 'deployment items must be a non-empty array');
  return items.map((item) => {
    if (!item || typeof item !== 'object') throw new TrackerError('request-invalid', 'deployment item must be an object');
    const obligation = ticket.deployments.find((d) => d.pr_id === item.pr_id && d.environment === item.environment);
    if (!obligation) throw new TrackerError('obligation-missing', `no deployment obligation for ${item.pr_id}/${item.environment}`);
    if (item.waiver_reason !== undefined && item.waiver_reason !== null) {
      if (!String(item.waiver_reason).trim()) throw new TrackerError('waiver-reason-required', 'a waived deployment requires a reason');
      return { pr_id: item.pr_id, environment: item.environment, state: 'waived', waiver_reason: String(item.waiver_reason).trim() };
    }
    if (requireChoice === 'waive') throw new TrackerError('waiver-reason-required', 'a waived deployment requires a reason');
    if (!item.deployed_at || !isIsoZ(item.deployed_at)) throw new TrackerError('deployed-at-required', 'mark deployed requires deployed_at (RFC 3339 UTC)');
    const kind = item.evidence_kind ?? 'manual';
    if (!EVIDENCE_KINDS.includes(kind)) throw new TrackerError('request-invalid', `evidence_kind must be one of ${EVIDENCE_KINDS.join(', ')}`);
    return { pr_id: item.pr_id, environment: item.environment, state: 'deployed', deployed_at: item.deployed_at, evidence: item.evidence ? String(item.evidence).slice(0, 500) : null, evidence_kind: kind };
  });
}

// Resolves the recipe a handoff request names (or its legacy mode) for the ticket's repository.
// A request that names no recipe (the handoff form, `quill handoff --mode`) always means the
// built-in recipe of that mode, whatever a repository or personal file of the same name says.
export function resolveRecipe(recipes, payload, repoId) {
  if (!recipes) return null;
  const ref = typeof payload.recipe === 'object' && payload.recipe ? payload.recipe : null;
  const named = typeof payload.recipe === 'string' && payload.recipe ? payload.recipe : ref ? ref.name : null;
  const name = named || payload.mode || 'analyse-followups';
  const builtinOnly = !named || (ref && ref.source === 'builtin');
  const recipe = builtinOnly ? recipes.builtin(name) : recipes.get(name, repoId ?? null, { fresh: true });
  if (!recipe) throw new TrackerError('recipe-unknown', `no recipe named ${name}`);
  if (recipe.error) throw new TrackerError('recipe-invalid', `recipe ${name} is invalid: ${recipe.error}`);
  return recipe;
}

// A change a file run made (ADR 0015), named by run and effect id, that has not been undone.
function findFileEffect(state, ticket, payload) {
  const h = typeof payload.handoff_id === 'string' ? state.handoffs.get(payload.handoff_id) : null;
  if (!h || h.ticket_id !== ticket.id) throw new TrackerError('handoff-unknown', 'handoff_id must name a run of the target ticket');
  const effect = (h.file_effects ?? []).find((x) => x.id === payload.effect_id);
  if (!effect) throw new TrackerError('effect-unknown', 'effect_id must name a file change of that run');
  if (effect.undone_at) throw new TrackerError('effect-undone', 'this change was already undone');
  return { h, effect };
}

function findSuggestion(state, ticket, payload) {
  const h = typeof payload.handoff_id === 'string' ? state.handoffs.get(payload.handoff_id) : null;
  if (!h || h.ticket_id !== ticket.id) throw new TrackerError('handoff-unknown', 'handoff_id must name a handoff of the target ticket');
  const sug = (h.suggestions ?? []).find((x) => x.id === payload.suggestion_id);
  if (!sug) throw new TrackerError('suggestion-unknown', 'suggestion_id must name a suggestion of that handoff');
  if (sug.state !== 'proposed') throw new TrackerError('suggestion-resolved', `this suggestion was already ${sug.state}`);
  return { h, sug };
}

// A run proposed from a shared page (ADR 0025), still open: not approved, dismissed or lapsed.
function findProposal(state, ticket, payload, now) {
  const p = typeof payload.proposal_id === 'string' && state.runProposals ? state.runProposals.get(payload.proposal_id) : null;
  if (!p || p.ticket_id !== ticket.id) throw new TrackerError('proposal-unknown', 'proposal_id must name a proposed run of the target ticket');
  const st = proposalState(p, ticket, now);
  if (st === 'expired') throw new TrackerError('proposal-expired', ticket.status === 'done' ? `${ticket.key} is done, so this proposed run lapsed` : 'this proposed run is more than 7 days old and lapsed; ask for it again on the page');
  if (st !== 'proposed') throw new TrackerError('proposal-resolved', `this proposed run was already ${st}`);
  return p;
}

// R59 (final review I2): the one check for owner-dashboard-only requests (memory approve and edit,
// approve-run of a run-origin proposal, resume-run of a scoped or pinned run). Only the authenticated
// dashboard server journals a request as the worker (submitRequest, actor owner); ingress can never
// claim the worker (it is quarantined there), so an ingress request is refused whatever actor it
// claims, and a schedule or publisher (also through the worker) is refused by its own actor.
export function fromOwnerDashboard(req) {
  return !!req && req.producer === 'worker' && (req.actor_id ?? 'owner') === 'owner';
}

// Only the owner approves or dismisses: the dashboard (actor owner) or the CLI. There is no
// auto-approval (ADR 0025); page edits, schedules and anything else acting for them are refused.
// A run's critical-change proposal (ADR 0028) is approved on the dashboard alone: the owner actor
// on a request the worker journaled itself (submitted over the dashboard's authenticated API). The
// CLI, an ingress request claiming the owner, a schedule or a page never approve one.
function approvalRefusal(req, p, kind) {
  const actor = req.actor_id ?? 'owner';
  // ADR 0039: a CI fix proposal is approved and dismissed on the dashboard alone, like a scope grant.
  if (p.origin === 'ci') {
    if (fromOwnerDashboard(req)) return null;
    return { code: 'ci-fix-dashboard-only', message: `${kind === 'approve-run' ? 'approving' : 'dismissing'} a CI fix proposal is a dashboard action by the owner: open Runs → Needs you with quill ui` };
  }
  if (kind === 'approve-run' && p.origin === 'run') {
    if (fromOwnerDashboard(req)) return null;
    return { code: 'critical-approve-dashboard-only', message: 'approving a critical change is a dashboard action by the owner: open Runs → Needs you with quill ui' };
  }
  if (actor === 'owner' || actor === 'cli') return null;
  return { code: 'approval-refused', message: `${kind === 'approve-run' ? 'approving' : 'dismissing'} a proposed run needs the owner, on the dashboard or with quill approve --run` };
}

// Approval of a run's critical-change proposal (spec §7.5, ADR 0028). Each scope must still resolve
// in the current catalog to the fingerprint the proposal recorded (else scope-changed: what the
// scope allows or the credentials it switches to changed since, Review Focus 4). The built-in
// recipe is pinned by name and source; a newer text is noted, not refused. The run it queues is
// autonomous, holds exactly the proposal's scopes, and every scope carries the action pin (the
// pin object's guard string, ruling R43), so the guard allows only that action (R48).
function approveCritical(worker, req, ticket, p) {
  const fail = (code, message) => ({ outcome: 'failed', error: { code, message, retryable: false, current_revision: ticket.revision } });
  // ADR 0031: checked again here, since a request may reach the worker without submit validation.
  let lease;
  try { lease = leaseMinutes((req.payload ?? {}).ttl_minutes); } catch (err) { return fail(err.code, err.message); }
  const id8 = String(p.from_handoff_id ?? '').slice(0, 8);
  const pin = p.action_pin && typeof p.action_pin.guard === 'string' && p.action_pin.guard.trim() ? p.action_pin.guard : null;
  const listed = Array.isArray(p.scopes) ? p.scopes : [];
  if (!pin || !listed.length) return fail('proposal-invalid', 'this critical change has no pinned action or scope, so it cannot be approved');
  const specs = [];
  const fingerprints = {};
  let catalog;
  try { catalog = loadScopeCatalog(worker.config ?? {}, { env: worker.env }); } catch (err) { return fail('scope-changed', `the scope catalog cannot be read (${err.message}); fix config.toml and approve again`); }
  for (const s of listed) {
    const spec = s.target ? `${s.name}:${s.target}` : s.name;
    let fingerprint;
    try { fingerprint = resolveScopes([spec], catalog)[0].fingerprint; } catch (err) { return fail('scope-changed', `scope ${spec} no longer resolves as it did when run ${id8} proposed this change (${err.message}); dismiss the proposal, or put the scope back as it was`); }
    if (fingerprint !== s.fingerprint) return fail('scope-changed', `scope ${spec} changed in config.toml since run ${id8} proposed this change (what it allows or the credentials it switches to); dismiss the proposal, or put the scope back as it was`);
    specs.push(spec);
    fingerprints[spec] = fingerprint;
  }
  const builtin = catalogFor(worker).builtin(p.recipe.name);
  const recipeNote = builtin && p.recipe.hash && builtin.hash !== p.recipe.hash ? 'recipe updated since proposed' : null;
  const actionPins = specs.map((scope) => ({ scope, pin }));
  return evaluateHandoff(worker, req, ticket, { recipe: { name: p.recipe.name, source: 'builtin', hash: null }, note: '', permissions: p.permissions, access: 'autonomous', scopes: specs, suggest: true }, { actionPins, scopeFingerprints: fingerprints, originProposalId: p.id, recipeNote, leaseMinutes: lease });
}

// Approval of a CI fix proposal (ADR 0039). The run that opened the pull request must still record
// CI failing on the very commit the proposal names, on the branch it pushed; otherwise the proposal
// is stale (it lapses in state at the next observation anyway). The queued run is an ordinary
// attempt-fix of the built-in recipe with the proposal's permissions (edit, commit, push to that
// branch; never a new pull request) and access (never wider than the original run's, never scopes),
// through the same validation and reservation as any run; validateHandoffRequest refuses a
// protected branch. The failing log tail travels on the run as `ci_fix`, local only.
function approveCi(worker, req, ticket, p) {
  const fail = (code, message) => ({ outcome: 'failed', error: { code, message, retryable: false, current_revision: ticket.revision } });
  const ci = p.ci && typeof p.ci === 'object' ? p.ci : {};
  const h = worker.state.handoffs.get(p.from_handoff_id);
  if (!h || !h.ci || h.ci.state !== 'failing' || h.ci.head_sha !== ci.head_sha || h.ci.pr_url !== ci.pr_url) return fail('ci-proposal-stale', 'CI on this pull request changed since the fix was proposed (a new commit, a pass or a merge), so nothing was queued');
  if (!h.pushed_branch || h.pushed_branch !== ci.head_branch || h.ci.head_branch !== ci.head_branch) return fail('ci-branch-mismatch', `the pull request's branch is not the branch run ${String(h.id).slice(0, 8)} pushed, so a CI fix is not queued`);
  const evaluation = evaluateHandoff(worker, req, ticket, { recipe: { name: p.recipe.name, source: 'builtin', hash: null }, note: '', permissions: p.permissions, access: p.access === 'autonomous' ? 'autonomous' : 'standard', branch: ci.head_branch, suggest: true });
  if (evaluation.outcome !== 'applied') return evaluation;
  Object.assign(evaluation.mutation.handoff, {
    origin: 'ci',
    ci_fix: { proposal_id: p.id, root_handoff_id: h.id, pr_url: ci.pr_url, head_sha: ci.head_sha, head_branch: ci.head_branch, failing: Array.isArray(ci.failing) ? [...ci.failing] : [], log_tail: typeof ci.log_tail === 'string' ? ci.log_tail : null, log_withheld: Number.isInteger(ci.log_withheld) ? ci.log_withheld : 0 },
  });
  return evaluation;
}

// The interrupted run a resume-run request names (spec §5.4, Task 19): a run of the target ticket
// that was interrupted with a recorded session, and that no later run on the ticket superseded
// (the run detail's rule: once resumed or retried, the later run is the one to act on).
function resumeTarget(state, ticket, payload) {
  const h = typeof payload.handoff_id === 'string' ? state.handoffs.get(payload.handoff_id) : null;
  if (!h || h.ticket_id !== ticket.id) throw new TrackerError('handoff-unknown', 'handoff_id must name a run of the target ticket');
  const problem = resumeProblem(h);
  if (problem) throw new TrackerError(problem.code, problem.message);
  const later = [...state.handoffs.values()].find((x) => x.id !== h.id && x.ticket_id === ticket.id && x.requested_at > h.requested_at);
  if (later) throw new TrackerError('run-superseded', `a later run (${later.id.slice(0, 8)}) on ${ticket.key} superseded this one, so it is not resumed`);
  return h;
}

// Resume as new run (spec §5.4, Task 19): the owner (dashboard) or the CLI, never a page, schedule
// or any other actor; the CLI sends nothing from inside a run (cli-in-run). The new run is a
// fresh, ordinary run of the same recipe with exactly what the interrupted one was granted (see
// resumeFields): no wider access, the same scopes whose fingerprints must not have changed, and
// an approved critical change keeps its action pins or is refused. It starts with --resume.
function evaluateResume(worker, req, ticket) {
  const { state } = worker;
  const fail = (code, message) => ({ outcome: 'failed', error: { code, message, retryable: false, current_revision: ticket.revision } });
  const actor = req.actor_id ?? 'owner';
  if (actor !== 'owner' && actor !== 'cli') return fail('resume-refused', 'resuming a run needs the owner, on the dashboard or with quill agent resume');
  let orig;
  let fields;
  try {
    orig = resumeTarget(state, ticket, req.payload ?? {});
    fields = resumeFields(orig);
  } catch (err) { return fail(err.code ?? 'resume-refused', err.message); }
  // R56: a run with write scopes or action pins gets its production write access again, so it is
  // resumed exactly as a run-origin proposal is approved: the owner on the dashboard alone.
  if ((fields.scopes && fields.scopes.length) || fields.action_pins) {
    if (!fromOwnerDashboard(req)) return fail('resume-dashboard-only', 'resuming a run with write scopes grants production write access again, so it is a dashboard action by the owner: open the run in Runs with quill ui');
  }
  const id8 = orig.id.slice(0, 8);
  if (fields.scope_fingerprints) {
    let catalog;
    try { catalog = loadScopeCatalog(worker.config ?? {}, { env: worker.env }); } catch (err) { return fail('scope-changed', `the scope catalog cannot be read (${err.message}); fix config.toml and resume again`); }
    for (const [spec, want] of Object.entries(fields.scope_fingerprints)) {
      let got;
      try { got = resolveScopes([spec], catalog)[0].fingerprint; } catch (err) { return fail('scope-changed', `scope ${spec} no longer resolves as it did when run ${id8} started (${err.message}); a resumed run gets only the scope exactly as it was granted`); }
      if (got !== want) return fail('scope-changed', `scope ${spec} changed in config.toml since run ${id8} started (what it allows or the credentials it switches to); a resumed run gets only the scope exactly as it was granted: put the scope back as it was, or queue a new run`);
    }
  }
  // A built-in is pinned by name and source (an upgrade may change its text); any other recipe
  // must still have the reviewed hash.
  const ref = fields.recipe ? { name: fields.recipe.name, source: fields.recipe.source, hash: fields.recipe.source === 'builtin' ? null : fields.recipe.hash } : undefined;
  const payload = { ...(ref ? { recipe: ref } : {}), mode: fields.mode, note: fields.note, permissions: fields.permissions, access: fields.access, branch: fields.branch, ...(fields.scopes ? { scopes: fields.scopes } : {}), ...(fields.max_turns !== undefined ? { max_turns: fields.max_turns } : {}), ...(fields.max_budget_usd !== undefined ? { max_budget_usd: fields.max_budget_usd } : {}), ...(fields.planned_paths ? { planned_paths: fields.planned_paths } : {}), ...(fields.legacy === false ? { suggest: true } : {}) };
  const critical = fields.action_pins ? { actionPins: fields.action_pins, scopeFingerprints: fields.scope_fingerprints, originProposalId: fields.origin_proposal_id, leaseMinutes: fields.lease_minutes ?? null } : null;
  const evaluation = evaluateHandoff(worker, req, ticket, payload, critical);
  if (evaluation.outcome !== 'applied') return evaluation;
  const h = evaluation.mutation.handoff;
  Object.assign(h, { retry_of: orig.id, resume_session_id: orig.session_id, batch_id: null });
  if (fields.scope_fingerprints) h.scope_fingerprints = { ...fields.scope_fingerprints };
  if (fields.proposal_id) h.proposal_id = fields.proposal_id;
  if (fields.proposal) h.proposal = fields.proposal;
  evaluation.result.resumed = orig.id;
  return evaluation;
}

// The owner's wording for an entry: trimmed, non-empty and at most MEMORY_TEXT_MAX characters.
function memoryText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TrackerError('request-invalid', 'memory text must be a non-empty string');
  if (text.trim().length > MEMORY_TEXT_MAX) throw new TrackerError('request-invalid', `memory text is limited to ${MEMORY_TEXT_MAX} characters`);
  return text.trim();
}

const SECTION_RE = /^[a-z][a-z0-9-]{0,39}$/;

// An owner note (quill memory note): machine scope, or repo scope for a configured repository.
function memoryNotePayload(payload, state) {
  const scope = payload.scope ?? (payload.repo_id ? 'repo' : 'machine');
  if (scope !== 'repo' && scope !== 'machine') throw new TrackerError('request-invalid', 'an owner note is repo or machine scope');
  const out = { scope, section: '', text: memoryText(payload.text) };
  if (scope === 'repo') {
    if (typeof payload.repo_id !== 'string' || !payload.repo_id) throw new TrackerError('request-invalid', 'a repo note names its repository');
    if (!Object.hasOwn(state.meta.repos ?? {}, payload.repo_id)) throw new TrackerError('repo-unknown', `no repository ${payload.repo_id} is configured`);
    out.repo_id = payload.repo_id;
  }
  if (payload.section !== undefined && payload.section !== null && payload.section !== '') {
    if (typeof payload.section !== 'string' || !SECTION_RE.test(payload.section)) throw new TrackerError('request-invalid', 'section must be a short lower-case name such as build or pitfalls');
    out.section = payload.section;
  }
  if (payload.key !== undefined && payload.key !== null && payload.key !== '') {
    if (typeof payload.key !== 'string' || !payload.key.trim() || payload.key.length > 100) throw new TrackerError('request-invalid', 'key must be a string of at most 100 characters');
    out.key = payload.key.trim();
  }
  return out;
}

export function validateRequestBody(body, state, nowIso, { scheduleNames = null, recipes = null, publisherNames = null, cloneHosts = null, scopeCheck = null } = {}) {
  if (!body || typeof body !== 'object' || !isUuid(body.id)) throw new TrackerError('request-invalid', 'request id must be a UUID');
  if (!KINDS.includes(body.kind)) throw new TrackerError('kind-invalid', `request kind must be one of ${KINDS.join(', ')}`);
  const payload = body.payload ?? {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TrackerError('request-invalid', 'payload must be an object');
  let target = null;
  if (TICKET_KINDS.has(body.kind)) {
    if (!body.target_id) throw new TrackerError('target-required', `${body.kind} requires target_id`);
    target = state.tickets.get(body.target_id);
    if (!target) throw new TrackerError('target-unknown', `unknown ticket ${body.target_id}`);
    if (!REVISION_OPTIONAL.has(body.kind) && (!Number.isInteger(body.expected_revision) || body.expected_revision < 0)) throw new TrackerError('expected-revision-required', 'ticket edits require expected_revision');
  }
  let session = null;
  if (SESSION_KINDS.has(body.kind)) {
    if (!body.target_id) throw new TrackerError('target-required', `${body.kind} requires target_id`);
    session = state.sessionsById.get(body.target_id);
    if (!session) throw new TrackerError('target-unknown', `unknown session ${body.target_id}`);
    if (!hasUnboundWork(session)) throw new TrackerError('unbound-gone', 'this session has no unlinked work to attach or dismiss');
    if (!Number.isInteger(body.expected_revision) || body.expected_revision < 0) throw new TrackerError('expected-revision-required', 'unlinked-work actions require expected_revision');
  }
  let memoryEntry = null;
  if (MEMORY_ENTRY_KINDS.has(body.kind)) {
    if (typeof body.target_id !== 'string' || !body.target_id) throw new TrackerError('target-required', `${body.kind} requires target_id, the memory entry id`);
    memoryEntry = state.memory ? state.memory.entries.get(body.target_id) ?? null : null;
    if (!memoryEntry) throw new TrackerError('memory-entry-unknown', `unknown memory entry ${body.target_id}`);
    if (!Number.isInteger(body.expected_revision) || body.expected_revision < 0) throw new TrackerError('expected-revision-required', 'memory changes require expected_revision');
  }
  let normalized = {};
  switch (body.kind) {
    case 'set-next-action': {
      if (typeof payload.next_action !== 'string') throw new TrackerError('request-invalid', 'next_action must be a string');
      if (payload.next_action.length > 2000) throw new TrackerError('request-invalid', 'next_action too long');
      normalized = { next_action: payload.next_action.trim() };
      break;
    }
    case 'set-status': {
      if (!TICKET_STATUSES.includes(payload.status)) throw new TrackerError('status-invalid', `status must be one of ${TICKET_STATUSES.join(', ')}`);
      normalized = { status: payload.status };
      if (payload.status === 'blocked') {
        if (!(typeof payload.blocker === 'string' && payload.blocker.trim())) throw new TrackerError('blocker-required', 'blocked requires blocker text');
        normalized.blocker = payload.blocker.trim().slice(0, 500);
      }
      if (payload.status === 'done' && outstandingObligations(target).length) {
        const choice = payload.deployment_choice;
        if (!['record', 'waive', 'leave'].includes(choice)) throw new TrackerError('deployment-choice-required', 'done with outstanding deployments requires deployment_choice: record, waive or leave');
        normalized.deployment_choice = choice;
        if (choice !== 'leave') normalized.deployments = normalizeDeploymentItems(payload.deployments, target, { requireChoice: choice });
      } else if (Array.isArray(payload.deployments) && payload.deployments.length) {
        normalized.deployments = normalizeDeploymentItems(payload.deployments, target);
      }
      break;
    }
    case 'record-deployment':
      normalized = { items: normalizeDeploymentItems(payload.items, target) };
      break;
    case 'handoff':
      normalized = validateHandoffRequest(payload, { repo: repoFor(state, target.repo_id), recipe: resolveRecipe(recipes, payload, target.repo_id), attachedFileCount: attachedFiles(target).length, scopeCheck });
      break;
    case 'accept-suggestion':
    case 'dismiss-suggestion': {
      const { h, sug } = findSuggestion(state, target, payload);
      normalized = { handoff_id: h.id, suggestion_id: sug.id };
      // ADR 0032: an optional reason for a dismissal, kept on the run's local Run note.
      if (body.kind === 'dismiss-suggestion' && payload.reason !== undefined && payload.reason !== null) {
        if (typeof payload.reason !== 'string') throw new TrackerError('request-invalid', 'reason must be a string');
        const reason = payload.reason.trim();
        if (reason.length > DISMISS_REASON_CHARS) throw new TrackerError('request-invalid', `reason must be at most ${DISMISS_REASON_CHARS} characters`);
        if (reason) normalized.reason = reason;
      }
      break;
    }
    case 'undo-file-effect': {
      const { h, effect } = findFileEffect(state, target, payload);
      normalized = { handoff_id: h.id, effect_id: effect.id };
      break;
    }
    case 'restore-snapshot': {
      const { h, snap } = restoreTarget(state, target, payload);
      normalized = { handoff_id: h.id, snapshot_id: snap.id };
      break;
    }
    case 'approve-run':
    case 'dismiss-run': {
      const p = findProposal(state, target, payload, nowIso);
      normalized = { proposal_id: p.id };
      // ADR 0031: a critical approval may be valid for 5, 15 or 60 minutes instead of the whole run.
      if (body.kind === 'approve-run' && payload.ttl_minutes !== undefined && payload.ttl_minutes !== null) {
        if (p.origin !== 'run') throw new TrackerError('invalid-ttl', 'only the approval of a critical change takes ttl_minutes');
        normalized.ttl_minutes = leaseMinutes(payload.ttl_minutes);
      }
      break;
    }
    case 'handoff-cancel': {
      const h = typeof payload.handoff_id === 'string' ? state.handoffs.get(payload.handoff_id) : null;
      if (!h || h.ticket_id !== target.id) throw new TrackerError('handoff-unknown', 'handoff_id must name a handoff of the target ticket');
      normalized = { handoff_id: h.id };
      break;
    }
    case 'resume-run': {
      const h = resumeTarget(state, target, payload);
      resumeFields(h);
      normalized = { handoff_id: h.id };
      break;
    }
    case 'refresh':
      normalized = {};
      break;
    case 'repo-clone': {
      // Consent covers the remote the dialog showed, so the request names it (ADR 0024).
      if (target.repo_id) throw new TrackerError('repo-linked', `${target.key} already belongs to repository ${target.repo_id}`);
      if ((target.tags ?? []).includes('quill/no-code')) throw new TrackerError('no-code', `${target.key} is marked as needing no code`);
      if (typeof payload.url !== 'string' || !payload.url.trim()) throw new TrackerError('request-invalid', 'repo-clone needs payload.url, the remote shown to the owner');
      const parsed = parseRemote(payload.url);
      if (parsed.error) throw new TrackerError(parsed.error.code, parsed.error.message);
      // A clone already on disk is only registered, so its host needs no allowance (the worker plans again).
      const onDisk = !!(target.repo_resolution && target.repo_resolution.existing_path && target.repo_resolution.remote === payload.url.trim());
      if (cloneHosts && !onDisk && !cloneHosts.includes(parsed.host)) throw new TrackerError('clone-host-refused', `${parsed.host} is not in [tracker] clone_hosts`);
      normalized = { url: payload.url.trim() };
      break;
    }
    case 'publish': {
      const name = payload.publisher ?? null;
      if (name !== null && (typeof name !== 'string' || !name)) throw new TrackerError('request-invalid', 'publish payload.publisher must be a publisher name or null for all');
      if (name !== null && publisherNames && !publisherNames.includes(name)) throw new TrackerError('publisher-unknown', `no publisher named ${name}`);
      normalized = { publisher: name, confirm: payload.confirm === true };
      break;
    }
    case 'run-job': {
      if (typeof payload.schedule !== 'string' || !payload.schedule) throw new TrackerError('request-invalid', 'run-job needs payload.schedule');
      if (scheduleNames && !scheduleNames.includes(payload.schedule)) throw new TrackerError('schedule-unknown', `no schedule named ${payload.schedule}`);
      normalized = { schedule: payload.schedule };
      break;
    }
    case 'attach-unbound': {
      const hasTicket = typeof payload.ticket_id === 'string' && payload.ticket_id !== '';
      const hasKey = typeof payload.key === 'string' && payload.key.trim() !== '';
      if (hasTicket === hasKey) throw new TrackerError('request-invalid', 'attach-unbound needs exactly one of ticket_id or key');
      const bind = payload.bind !== false;
      if (hasTicket) {
        if (!state.tickets.has(payload.ticket_id)) throw new TrackerError('target-unknown', `unknown ticket ${payload.ticket_id}`);
        normalized = { ticket_id: payload.ticket_id, bind };
      } else {
        const key = payload.key.trim().toUpperCase();
        if (!EXTERNAL_KEY_RE.test(key)) throw new TrackerError('key-invalid', 'a ticket key like PROJ-123 is required');
        validateKey(key);
        normalized = { key, title: typeof payload.title === 'string' ? payload.title.trim().slice(0, 200) : '', bind };
      }
      break;
    }
    case 'dismiss-unbound':
      normalized = {};
      break;
    case 'memory-approve':
    case 'memory-forget':
      normalized = {};
      break;
    case 'memory-edit':
      normalized = { text: memoryText(payload.text) };
      break;
    case 'memory-pin':
      if (typeof payload.pinned !== 'boolean') throw new TrackerError('request-invalid', 'memory-pin needs payload.pinned, true or false');
      if (memoryEntry.trust === 'quarantined') throw new TrackerError('memory-quarantined', QUARANTINED_PIN);
      normalized = { pinned: payload.pinned };
      break;
    case 'memory-note':
      normalized = memoryNotePayload(payload, state);
      break;
    case 'link-external': {
      const key = typeof payload.key === 'string' ? payload.key.trim().toUpperCase() : '';
      if (!EXTERNAL_KEY_RE.test(key)) throw new TrackerError('key-invalid', 'a ticket key like PROJ-123 is required');
      validateKey(key);
      if (payload.system !== undefined && payload.system !== null && !TRACKER_SYSTEMS.includes(payload.system)) throw new TrackerError('system-invalid', `system must be one of ${TRACKER_SYSTEMS.join(', ')}`);
      const url = typeof payload.url === 'string' && payload.url.trim() ? payload.url.trim() : null;
      if (url && !isSafeExternalUrl(url)) throw new TrackerError('external-url-invalid', 'the external link must be an https:// URL without spaces or quotes');
      const owner = keyOwner(state, key);
      if (owner && owner !== target.id) throw new TrackerError('key-collision', `${key} already identifies another ticket`);
      normalized = { key, system: payload.system ?? null, url };
      break;
    }
    default:
      throw new TrackerError('kind-invalid', 'unknown kind');
  }
  return {
    id: body.id,
    kind: body.kind,
    target_id: target ? target.id : (session ? session.id : (memoryEntry ? memoryEntry.id : null)),
    expected_revision: session || memoryEntry ? body.expected_revision : (target && !REVISION_OPTIONAL.has(body.kind) ? body.expected_revision : (Number.isInteger(body.expected_revision) ? body.expected_revision : null)),
    payload: normalized,
    created_at: nowIso,
    not_before: DELAYED_KINDS.has(body.kind) ? addMs(nowIso, EDIT_DELAY_MS) : nowIso,
    actor_id: 'owner',
    retry_of: typeof body.retry_of === 'string' && isUuid(body.retry_of) ? body.retry_of : null,
    body_hash: bodyHash(body),
  };
}

// Returns { status, request } where status is 202 (new or identical repost) or 409 (same id, other body).
export function submitRequest(worker, body, { actor = 'owner' } = {}) {
  const now = worker.now();
  const existing = body && body.id ? worker.state.requests.get(body.id) : null;
  if (existing) {
    if (existing.body_hash && existing.body_hash === bodyHash(body)) return { status: 202, request: existing };
    throw new TrackerError('request-mismatch', 'a request with this id already exists with different content', { status: 409 });
  }
  const request = validateRequestBody(body, worker.state, now, { scheduleNames: worker.scheduleInfo ? worker.scheduleInfo().map((s) => s.name) : null, recipes: catalogFor(worker), publisherNames: worker.publishInfo ? worker.publishInfo().map((p) => p.name) : null, cloneHosts: onboardSettings(worker.config && worker.config.tracker).clone_hosts, scopeCheck: (names) => scopeValidator(worker.config ?? {}, { env: worker.env })(names) });
  request.actor_id = actor;
  const { result } = worker.emit('request', request, { source_identity: `request:${request.id}` });
  if (result.rejected) throw new TrackerError(result.rejected, `request rejected: ${result.rejected}`, { status: 400 });
  const record = worker.state.requests.get(request.id);
  worker.publishRequest(request.id);
  return { status: 202, request: record };
}

function currentValues(ticket) {
  return { revision: ticket.revision, next_action: ticket.next_action, status: ticket.status, blocker: ticket.blocker, deployments: ticket.deployments, updated_at: ticket.updated_at };
}

function trackerFor(worker, { cwd = null, repo_id = null } = {}) {
  const identity = worker.identity;
  if (!identity) return null;
  if (repo_id) {
    const r = (identity.repos ?? []).find((x) => x.repo_id === repo_id);
    if (r) return r.tracker ?? null;
  }
  return cwd ? scopeFor(identity, cwd).tracker : identity.tracker ?? null;
}

function unboundCurrent(session) {
  const w = session && session.unbound_work;
  return { revision: w ? w.revision : null, files: w ? w.files.length : 0, commits: w ? w.commits.length : 0 };
}

function evaluateSessionRequest(worker, req) {
  const { state } = worker;
  const session = state.sessionsById.get(req.target_id);
  if (!session || !hasUnboundWork(session)) {
    return { outcome: 'failed', error: { code: 'unbound-gone', message: 'the unlinked work was already attached or dismissed', retryable: false, current_revision: session && session.unbound_work ? session.unbound_work.revision : null } };
  }
  if (session.unbound_work.revision !== req.expected_revision) {
    return { outcome: 'conflict', error: { code: 'revision-conflict', message: `more work was captured in this session after you looked (revision ${session.unbound_work.revision}, request expected ${req.expected_revision})`, retryable: false, current_revision: session.unbound_work.revision }, result: { current: unboundCurrent(session) } };
  }
  const who = { session_id: session.host_session_id, agent_id: session.agent_id ?? null };
  if (req.kind === 'dismiss-unbound') return { outcome: 'applied', mutation: { type: 'unbound-dismiss', session_id: session.id }, session: who };
  let ticketId = req.payload.ticket_id ?? null;
  let create = null;
  if (ticketId && !state.tickets.has(ticketId)) return { outcome: 'failed', error: { code: 'target-unknown', message: 'that ticket no longer exists', retryable: false, current_revision: null } };
  if (!ticketId) {
    const key = req.payload.key;
    ticketId = keyOwner(state, key);
    if (!ticketId) {
      const scope = worker.identity ? scopeFor(worker.identity, session.cwd) : { project_id: null, repo_id: null, tracker: null };
      const tracker = trackerFor(worker, { cwd: session.cwd });
      const system = tracker ? tracker.system : 'custom';
      const url = renderUrl(key, tracker);
      const project_id = session.project_ids[session.project_ids.length - 1] ?? scope.project_id ?? Object.keys(state.meta.projects)[0] ?? null;
      if (!project_id) return { outcome: 'failed', error: { code: 'project-required', message: 'no project is configured for new tickets', retryable: false, current_revision: null } };
      const external = { system, key, url, validation: 'pending', validated_at: null, error: null };
      create = {
        id: externalTicketId(state.meta.store_id, key), key, title: req.payload.title || session.title || key, project_id, category: 'research', priority: 'P2', repo_id: scope.repo_id ?? null,
        external, jira: system === 'jira' ? { key, url, validation: 'pending', validated_at: null, error: null } : null, created_via: 'inbox',
      };
      ticketId = create.id;
    }
  }
  return { outcome: 'applied', mutation: { type: 'unbound-attach', session_id: session.id, ticket_id: ticketId, create, bind: req.payload.bind !== false }, result: { ticket_id: ticketId, created: !!create }, session: who };
}

// A handoff request, or an approved proposal, becomes a queued run (TRD §Handoff execution).
// `critical` (ADR 0028) comes only from approveCritical, never from a request payload: the action
// pins, the fingerprints the scopes must still have at dispatch, and the proposal it came from.
function evaluateHandoff(worker, req, ticket, payload, critical = null) {
  const { state } = worker;
  // Re-checked here because CLI requests arrive through ingress without submit validation, and
  // the recipe file may have changed during the request's lifetime.
  let recipe;
  let checked;
  try {
    recipe = resolveRecipe(catalogFor(worker), payload, ticket.repo_id);
    // Write scopes are checked against the worker's catalog here too (spec §4.3).
    checked = validateHandoffRequest({ ...payload, recipe: payload.recipe ? payload.recipe.name ?? payload.recipe : undefined }, { repo: repoFor(state, ticket.repo_id), recipe, attachedFileCount: attachedFiles(ticket).length, scopeCheck: scopeValidator(worker.config ?? {}, { env: worker.env }), actionPins: critical ? critical.actionPins : null });
  } catch (err) {
    return { outcome: 'failed', error: { code: err.code ?? 'request-invalid', message: err.message, retryable: false, current_revision: ticket.revision } };
  }
  if (payload.recipe && payload.recipe.hash && payload.recipe.hash !== recipe.hash) {
    return { outcome: 'failed', error: { code: 'recipe-changed', message: `recipe ${recipe.name} changed after the request was made; review it and queue it again`, retryable: true, current_revision: ticket.revision } };
  }
  const existing = [...state.handoffs.values()].find((h) => h.ticket_id === ticket.id && ['queued', 'running'].includes(h.state));
  if (existing) return { outcome: 'failed', error: { code: 'handoff-reserved', message: `handoff ${existing.id} is already ${existing.state} for this ticket`, retryable: true, current_revision: ticket.revision }, result: { existing_handoff_id: existing.id } };
  const handoff = {
    schema_version: 1, store_id: state.meta.store_id, id: uuid(), revision: 1, created_at: worker.now(), updated_at: worker.now(),
    ticket_id: ticket.id, request_id: req.id, mode: checked.mode, note: checked.note, permissions: checked.permissions, access: checked.access ?? 'standard',
    // The next action as queued: a run's own suggestion conflicts only if someone changed it since.
    base_ticket_revision: ticket.revision, base_next_action: ticket.next_action ?? '', repo_id: ticket.repo_id ?? null, base_commit: null, branch: checked.branch ?? null, state: 'queued',
    requested_at: worker.now(), started_at: null, finished_at: null, deadline_at: null, error: null, result_ref: null, result_summary: null,
    children_ids: [], worktree_path: null, changed_files: [], test_results: [], commit_sha: null, pr_url: null, uncertain_effects: [], retry_of: req.retry_of ?? null,
    batch_id: checked.batch_id ?? null, recipe: { name: recipe.name, source: recipe.source, hash: recipe.hash }, legacy: recipe.legacy && checked.suggest !== true, outputs: recipe.outputs, suggestions: [],
    // The wall clock the run will get, from the same budget dispatch uses (R8): recipe, config and access.
    deadline_ms: budgetFor(recipe, worker.config, checked.access ?? 'standard', checked.mode).timeoutMs,
    // Write scopes (autonomous only) and the run's own turn and spend limits, when it asked for them.
    ...(checked.scopes ? { scopes: checked.scopes } : {}),
    ...(checked.max_turns !== undefined ? { max_turns: checked.max_turns } : {}),
    ...(checked.max_budget_usd !== undefined ? { max_budget_usd: checked.max_budget_usd } : {}),
    // Planned files (ADR 0037): frozen into the grant; writes outside them are counted, never refused. Local only.
    ...(checked.planned_paths ? { planned_paths: checked.planned_paths } : {}),
    // An approved critical change (ADR 0028): its pinned action per scope, the fingerprints dispatch
    // checks again before the grant is frozen, and the proposal. Never exported (allow-lists).
    ...(critical ? { action_pins: critical.actionPins, scope_fingerprints: critical.scopeFingerprints, origin_proposal_id: critical.originProposalId } : {}),
    // ADR 0031: the approval's "Valid for" minutes; dispatch freezes the end as the grant's notAfter.
    ...(critical && critical.leaseMinutes ? { lease_minutes: critical.leaseMinutes } : {}),
  };
  return { outcome: 'applied', mutation: { type: 'handoff-create', handoff }, result: { handoff_id: handoff.id, ...(critical && critical.recipeNote ? { note: critical.recipeNote } : {}) } };
}

const memorySource = (requestId) => `memory-tx:request:${requestId}`;
const memoryFailure = (code, message, current_revision = null) => ({ outcome: 'failed', error: { code, message, retryable: false, current_revision } });

// Who may make this memory change (spec §6.4): approve and edit only the dashboard owner; forget,
// pin and note also the owner's CLI. A page edit, a schedule or any other actor never.
function memoryRefusal(req) {
  const actor = req.actor_id ?? 'owner';
  if (DASHBOARD_ONLY[req.kind]) return fromOwnerDashboard(req) ? null : { code: DASHBOARD_ONLY[req.kind], message: `${req.kind === 'memory-approve' ? 'approving a learning' : 'editing a memory entry'} is a dashboard action: open Memory with quill ui` };
  if (actor === 'owner' || actor === 'cli') return null;
  return { code: 'memory-owner-only', message: 'only the owner changes memory, on the dashboard or with quill memory' };
}

// A memory request becomes one memory-tx event (finish() journals it before the request-tx), so the
// journal stays the single source of memory. CLI requests arrive without submit validation, so every
// check is made again here against the entry as it is now.
function evaluateMemoryRequest(worker, req) {
  const { state } = worker;
  const refusal = memoryRefusal(req);
  if (refusal) return memoryFailure(refusal.code, refusal.message);
  const payload = req.payload ?? {};
  const noteId = req.kind === 'memory-note' ? deterministicId(`${req.id}:memory-note`) : null;
  // After a crash between the two events the memory change already applied: finish the request.
  if (state.appliedSources.has(memorySource(req.id))) return { outcome: 'applied', result: { entry_id: noteId ?? req.target_id } };
  if (req.kind === 'memory-note') {
    let note;
    try { note = memoryNotePayload(payload, state); } catch (err) { return memoryFailure(err.code ?? 'request-invalid', err.message); }
    return { outcome: 'applied', memoryTx: { op: 'owner-note', entry: { id: noteId, ...note } }, result: { entry_id: noteId } };
  }
  const entry = state.memory.entries.get(req.target_id);
  if (!entry) return memoryFailure('memory-entry-unknown', 'this memory entry no longer exists');
  if (!Number.isInteger(req.expected_revision)) return memoryFailure('expected-revision-required', 'memory changes require expected_revision', entry.revision);
  if (entry.revision !== req.expected_revision) {
    // The current state without the entry's text: request records reach the owner snapshot.
    return { outcome: 'conflict', error: { code: 'revision-conflict', message: `this entry changed first (revision ${entry.revision}, request expected ${req.expected_revision})`, retryable: false, current_revision: entry.revision }, result: { current: { revision: entry.revision, trust: entry.trust, pinned: entry.pinned === true, state: entry.state } } };
  }
  const guarded = { expected_revision: entry.revision };
  const result = { entry_id: entry.id };
  switch (req.kind) {
    case 'memory-approve':
      if (entry.trust !== 'quarantined') return memoryFailure('memory-not-quarantined', 'this entry is not waiting for approval', entry.revision);
      return { outcome: 'applied', memoryTx: { op: 'approved', entry: { id: entry.id }, ...guarded }, result };
    case 'memory-edit': {
      let text;
      try { text = memoryText(payload.text); } catch (err) { return memoryFailure(err.code, err.message, entry.revision); }
      if (entry.superseded_by) return memoryFailure('memory-entry-retired', 'this entry was superseded; edit its replacement', entry.revision);
      return { outcome: 'applied', memoryTx: { op: 'edited', entry: { id: entry.id, text }, ...guarded }, result };
    }
    case 'memory-forget':
      if (entry.state === 'retired' || entry.superseded_by) return memoryFailure('memory-entry-retired', 'this entry is already retired', entry.revision);
      return { outcome: 'applied', memoryTx: { op: 'retired', entry: { id: entry.id }, ...guarded }, result };
    case 'memory-pin':
      if (typeof payload.pinned !== 'boolean') return memoryFailure('request-invalid', 'memory-pin needs payload.pinned, true or false', entry.revision);
      // A held learning is never delivered, pinned or not: approve it first (pinning would claim an effect it has not).
      if (entry.trust === 'quarantined') return memoryFailure('memory-quarantined', QUARANTINED_PIN, entry.revision);
      return { outcome: 'applied', memoryTx: { op: payload.pinned ? 'pinned' : 'unpinned', entry: { id: entry.id }, ...guarded }, result };
    default:
      return memoryFailure('kind-invalid', 'unsupported memory request kind');
  }
}

const REVALIDATED_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment']);

export function evaluateRequest(worker, req) {
  if (SESSION_KINDS.has(req.kind)) return evaluateSessionRequest(worker, req);
  if (MEMORY_KINDS.has(req.kind)) return evaluateMemoryRequest(worker, req);
  const { state } = worker;
  const ticket = req.target_id ? state.tickets.get(req.target_id) : null;
  if (req.kind !== 'refresh' && !ticket) return { outcome: 'failed', error: { code: 'target-unknown', message: 'ticket no longer exists', retryable: false, current_revision: null } };
  if (ticket && req.expected_revision !== null && ticket.revision !== req.expected_revision) {
    return { outcome: 'conflict', error: { code: 'revision-conflict', message: `ticket is at revision ${ticket.revision}, request expected ${req.expected_revision}`, retryable: false, current_revision: ticket.revision }, result: { current: currentValues(ticket) } };
  }
  if (REVALIDATED_KINDS.has(req.kind)) {
    // Field edits from ingress (the CLI, page edits a session publish brings back) skipped submit
    // validation, so they are validated here, against the ticket as it is now, before they apply.
    try {
      const checked = validateRequestBody({ id: req.id, kind: req.kind, target_id: ticket.id, expected_revision: ticket.revision, payload: req.payload }, state, worker.now());
      req = { ...req, payload: checked.payload };
    } catch (err) {
      return { outcome: 'failed', error: { code: err.code ?? 'request-invalid', message: err.message, retryable: false, current_revision: ticket.revision } };
    }
  }
  switch (req.kind) {
    case 'set-next-action':
      return { outcome: 'applied', mutation: { type: 'ticket-fields', ticket_id: ticket.id, fields: { next_action: req.payload.next_action } } };
    case 'set-status': {
      const fields = { status: req.payload.status };
      if (req.payload.blocker !== undefined) fields.blocker = req.payload.blocker;
      if (Array.isArray(req.payload.deployments)) fields.deployments = req.payload.deployments;
      return { outcome: 'applied', mutation: { type: 'ticket-fields', ticket_id: ticket.id, fields } };
    }
    case 'record-deployment':
      return { outcome: 'applied', mutation: { type: 'ticket-fields', ticket_id: ticket.id, fields: { deployments: req.payload.items } } };
    case 'handoff':
      return evaluateHandoff(worker, req, ticket, req.payload);
    case 'resume-run':
      return evaluateResume(worker, req, ticket);
    case 'restore-snapshot':
      return evaluateRestore(worker, req, ticket, { owner: fromOwnerDashboard(req) });
    case 'approve-run':
    case 'dismiss-run': {
      let p;
      try { p = findProposal(state, ticket, req.payload, worker.now()); } catch (err) {
        return { outcome: 'failed', error: { code: err.code, message: err.message, retryable: false, current_revision: ticket.revision } };
      }
      const refusal = approvalRefusal(req, p, req.kind);
      if (refusal) return { outcome: 'failed', error: { code: refusal.code, message: refusal.message, retryable: false, current_revision: ticket.revision } };
      if (req.kind === 'dismiss-run') return { outcome: 'applied', mutation: { type: 'run-proposal-dismiss', proposal_id: p.id }, result: { proposal_id: p.id } };
      const critical = p.origin === 'run';
      const ciFix = p.origin === 'ci';
      if (!critical && req.payload && req.payload.ttl_minutes !== undefined && req.payload.ttl_minutes !== null) return { outcome: 'failed', error: { code: 'invalid-ttl', message: 'only the approval of a critical change takes ttl_minutes', retryable: false, current_revision: ticket.revision } };
      // The recipe this ticket would run must still be the one the page offered (same layer and
      // text); a repository recipe of that name shadows it and is refused.
      const shadow = critical || ciFix ? null : shadowProblem(p.recipe, catalogFor(worker).get(p.recipe.name, ticket.repo_id ?? null, { fresh: true }), p.recipe.name);
      if (shadow) return { outcome: 'failed', error: { code: shadow.code, message: shadow.message, retryable: false, current_revision: ticket.revision } };
      // Approval queues an ordinary run through the same checks and reservation as the Run dialog.
      // It suggests rather than applies: whoever proposed it, the owner reviews what it found. Page
      // text never becomes the owner's note; where the run came from travels as `proposal`.
      const evaluation = critical ? approveCritical(worker, req, ticket, p) : ciFix ? approveCi(worker, req, ticket, p) : evaluateHandoff(worker, req, ticket, { recipe: p.recipe, note: '', permissions: p.permissions, access: p.access, suggest: true });
      if (evaluation.outcome !== 'applied') {
        if (evaluation.error && evaluation.error.code === 'handoff-reserved') {
          const existing = state.handoffs.get(evaluation.result.existing_handoff_id);
          evaluation.error.message = `${ticket.key} already has a ${existing ? existing.state : 'queued'} run (${String(evaluation.result.existing_handoff_id).slice(0, 8)}); approve the proposal again once it finishes`;
        }
        return evaluation;
      }
      evaluation.mutation.proposal_id = p.id;
      evaluation.mutation.handoff.proposal_id = p.id;
      evaluation.mutation.handoff.proposal = proposalProvenance(p);
      evaluation.result.proposal_id = p.id;
      return evaluation;
    }
    case 'handoff-cancel': {
      const h = state.handoffs.get(req.payload.handoff_id);
      if (!h) return { outcome: 'failed', error: { code: 'handoff-unknown', message: 'handoff no longer exists', retryable: false, current_revision: ticket.revision } };
      if (!['queued', 'running'].includes(h.state)) return { outcome: 'failed', error: { code: 'handoff-terminal', message: `handoff is already ${h.state}`, retryable: false, current_revision: ticket.revision }, result: { state: h.state } };
      return { outcome: 'applied', mutation: { type: 'handoff-cancel', handoff_id: h.id }, result: { handoff_id: h.id, was: h.state } };
    }
    case 'accept-suggestion':
    case 'dismiss-suggestion': {
      let found;
      try { found = findSuggestion(state, ticket, req.payload); } catch (err) {
        return { outcome: 'failed', error: { code: err.code, message: err.message, retryable: false, current_revision: ticket.revision } };
      }
      let mutation;
      try { mutation = suggestionMutation(state, ticket, found.h, found.sug, req.kind === 'accept-suggestion' ? 'accepted' : 'dismissed'); } catch (err) {
        return { outcome: 'failed', error: { code: err.code ?? 'suggestion-invalid', message: err.message, retryable: false, current_revision: ticket.revision } };
      }
      if (req.kind === 'dismiss-suggestion' && typeof req.payload.reason === 'string' && req.payload.reason) mutation.reason = req.payload.reason.slice(0, DISMISS_REASON_CHARS);
      return { outcome: 'applied', mutation, result: { handoff_id: found.h.id, suggestion_id: found.sug.id, state: mutation.state } };
    }
    case 'undo-file-effect': {
      // The restore happens here, once, when the request applies; the journal records its outcome.
      try {
        const { h, effect } = findFileEffect(state, ticket, req.payload);
        undoFileEffect(effect);
        return { outcome: 'applied', mutation: { type: 'file-effect-undo', handoff_id: h.id, effect_id: effect.id }, result: { path: effect.path, action: effect.action } };
      } catch (err) {
        return { outcome: 'failed', error: { code: err.code ?? 'undo-failed', message: err.message, retryable: false, current_revision: ticket.revision } };
      }
    }
    case 'link-external': {
      const owner = keyOwner(state, req.payload.key);
      if (owner && owner !== ticket.id) return { outcome: 'failed', error: { code: 'key-collision', message: `${req.payload.key} already identifies another ticket`, retryable: false, current_revision: ticket.revision } };
      const tracker = trackerFor(worker, { repo_id: ticket.repo_id });
      const system = req.payload.system ?? (tracker ? tracker.system : 'custom');
      const url = req.payload.url ?? (tracker && tracker.system === system ? renderUrl(req.payload.key, tracker) : null);
      const pending = { validation: 'pending', validated_at: null, error: 'no tracker provider configured; remote validation pending' };
      const mutation = { type: 'relink', ticket_id: ticket.id, new_key: req.payload.key, external: { system, key: req.payload.key, url, ...pending } };
      if (system === 'jira') mutation.jira = { key: req.payload.key, url, ...pending };
      return { outcome: 'applied', mutation, result: { key: req.payload.key, url } };
    }
    default:
      return { outcome: 'failed', error: { code: 'kind-invalid', message: 'unsupported request kind', retryable: false, current_revision: null } };
  }
}

function finish(worker, req, evaluation) {
  if (evaluation.memoryTx) {
    const { memoryTx, ...rest } = evaluation;
    const { result } = worker.emit('memory-tx', memoryTx, { source_identity: memorySource(req.id) });
    evaluation = result.rejected
      ? { outcome: result.rejected === 'revision-conflict' ? 'conflict' : 'failed', error: { code: result.rejected, message: `the memory change was not applied (${result.rejected})`, retryable: false, current_revision: null } }
      : rest;
  }
  const payload = { request_id: req.id, outcome: evaluation.outcome, error: evaluation.error ?? null, result: evaluation.result ?? null, mutation: evaluation.mutation ?? null };
  // Session-targeted requests carry the session identity so the worker re-renders that session.
  worker.emit('request-tx', payload, { source_identity: `request-tx:${req.id}:${evaluation.outcome}`, ...(evaluation.session ?? {}) });
  worker.publishRequest(req.id);
}

// Serialized application of due requests; refresh requests are owned by the reconciliation extension.
export function applyDueRequests(worker, nowIso) {
  let applied = 0;
  for (const req of [...worker.state.requests.values()]) {
    if (req.state !== 'pending' || EXTENSION_KINDS.has(req.kind)) continue;
    if (req.not_before > nowIso) continue;
    worker.emit('request-tx', { request_id: req.id, outcome: 'applying' }, { source_identity: `request-tx:${req.id}:applying` });
    finish(worker, req, evaluateRequest(worker, req));
    applied += 1;
  }
  return applied;
}

// After a crash an `applying` request has no terminal transaction: re-evaluate it safely.
export function recoverApplying(worker) {
  for (const req of [...worker.state.requests.values()]) {
    if (req.state !== 'applying' || EXTENSION_KINDS.has(req.kind)) continue;
    finish(worker, req, evaluateRequest(worker, req));
  }
}

export function cancelRequest(worker, id) {
  const req = worker.state.requests.get(id);
  if (!req) return { outcome: 'unknown', request: null };
  if (req.state === 'pending') {
    worker.emit('request-tx', { request_id: id, outcome: 'cancelled' }, { source_identity: `request-tx:${id}:cancelled` });
    worker.publishRequest(id);
    return { outcome: 'cancelled', request: worker.state.requests.get(id) };
  }
  if (req.state === 'applying') return { outcome: 'applying', request: req };
  if (req.state === 'applied') return { outcome: 'already-applied', request: req };
  return { outcome: 'already-terminal', request: req };
}

export function isTerminal(req) {
  return TERMINAL.has(req.state);
}
