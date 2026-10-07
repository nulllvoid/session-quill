// Durable, revision-checked mutation requests (DATA-CONTRACT §Mutation request).
import { createHash } from 'node:crypto';
import { isUuid, uuid } from '../lib/ids.js';
import { addMs, isIsoZ } from '../lib/time.js';
import { TrackerError } from '../lib/errors.js';
import { TICKET_STATUSES, repoFor, hasUnboundWork } from '../core/state.js';
import { outstandingObligations } from '../core/transitions.js';
import { validateHandoffRequest } from '../handoff/permissions.js';
import { validateKey } from '../core/keys.js';
import { renderUrl, isSafeExternalUrl, externalTicketId, TRACKER_SYSTEMS } from '../core/external-keys.js';
import { scopeFor } from '../hooks/scope.js';
import { catalogFor } from '../agents/recipes.js';
import { EVIDENCE_KINDS } from '../deploy/environments.js';
import { suggestionMutation } from '../agents/suggestions.js';

export const EDIT_DELAY_MS = 10_000;
export const KINDS = ['set-next-action', 'set-status', 'record-deployment', 'handoff', 'handoff-cancel', 'refresh', 'attach-unbound', 'dismiss-unbound', 'link-external', 'run-job', 'accept-suggestion', 'dismiss-suggestion', 'publish'];
// Run by the scheduler extension rather than by applyDueRequests (ADR 0007).
const SCHEDULER_KINDS = new Set(['refresh', 'run-job', 'publish']);
const TICKET_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment', 'handoff', 'handoff-cancel', 'link-external', 'accept-suggestion', 'dismiss-suggestion']);
// Inbox actions target a session and are revision-checked against its unlinked work (ADR 0006).
const SESSION_KINDS = new Set(['attach-unbound', 'dismiss-unbound']);
const REVISION_OPTIONAL = new Set(['handoff-cancel', 'dismiss-suggestion']);
const DELAYED_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment', 'attach-unbound', 'dismiss-unbound', 'link-external', 'accept-suggestion', 'dismiss-suggestion']);
const EXTERNAL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

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

function findSuggestion(state, ticket, payload) {
  const h = typeof payload.handoff_id === 'string' ? state.handoffs.get(payload.handoff_id) : null;
  if (!h || h.ticket_id !== ticket.id) throw new TrackerError('handoff-unknown', 'handoff_id must name a handoff of the target ticket');
  const sug = (h.suggestions ?? []).find((x) => x.id === payload.suggestion_id);
  if (!sug) throw new TrackerError('suggestion-unknown', 'suggestion_id must name a suggestion of that handoff');
  if (sug.state !== 'proposed') throw new TrackerError('suggestion-resolved', `this suggestion was already ${sug.state}`);
  return { h, sug };
}

export function validateRequestBody(body, state, nowIso, { scheduleNames = null, recipes = null, publisherNames = null } = {}) {
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
      normalized = validateHandoffRequest(payload, { repo: repoFor(state, target.repo_id), recipe: resolveRecipe(recipes, payload, target.repo_id) });
      break;
    case 'accept-suggestion':
    case 'dismiss-suggestion': {
      const { h, sug } = findSuggestion(state, target, payload);
      normalized = { handoff_id: h.id, suggestion_id: sug.id };
      break;
    }
    case 'handoff-cancel': {
      const h = typeof payload.handoff_id === 'string' ? state.handoffs.get(payload.handoff_id) : null;
      if (!h || h.ticket_id !== target.id) throw new TrackerError('handoff-unknown', 'handoff_id must name a handoff of the target ticket');
      normalized = { handoff_id: h.id };
      break;
    }
    case 'refresh':
      normalized = {};
      break;
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
    target_id: target ? target.id : (session ? session.id : null),
    expected_revision: session ? body.expected_revision : (target && !REVISION_OPTIONAL.has(body.kind) ? body.expected_revision : (Number.isInteger(body.expected_revision) ? body.expected_revision : null)),
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
  const request = validateRequestBody(body, worker.state, now, { scheduleNames: worker.scheduleInfo ? worker.scheduleInfo().map((s) => s.name) : null, recipes: catalogFor(worker), publisherNames: worker.publishInfo ? worker.publishInfo().map((p) => p.name) : null });
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

const REVALIDATED_KINDS = new Set(['set-next-action', 'set-status', 'record-deployment']);

export function evaluateRequest(worker, req) {
  if (SESSION_KINDS.has(req.kind)) return evaluateSessionRequest(worker, req);
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
    case 'handoff': {
      // Re-checked here because CLI requests arrive through ingress without submit validation, and
      // the recipe file may have changed during the request's lifetime.
      let recipe;
      let checked;
      try {
        recipe = resolveRecipe(catalogFor(worker), req.payload, ticket.repo_id);
        checked = validateHandoffRequest({ ...req.payload, recipe: req.payload.recipe ? req.payload.recipe.name ?? req.payload.recipe : undefined }, { repo: repoFor(state, ticket.repo_id), recipe });
      } catch (err) {
        return { outcome: 'failed', error: { code: err.code ?? 'request-invalid', message: err.message, retryable: false, current_revision: ticket.revision } };
      }
      if (req.payload.recipe && req.payload.recipe.hash && req.payload.recipe.hash !== recipe.hash) {
        return { outcome: 'failed', error: { code: 'recipe-changed', message: `recipe ${recipe.name} changed after the request was made; review it and queue it again`, retryable: true, current_revision: ticket.revision } };
      }
      const existing = [...state.handoffs.values()].find((h) => h.ticket_id === ticket.id && ['queued', 'running'].includes(h.state));
      if (existing) return { outcome: 'failed', error: { code: 'handoff-reserved', message: `handoff ${existing.id} is already ${existing.state} for this ticket`, retryable: true, current_revision: ticket.revision }, result: { existing_handoff_id: existing.id } };
      const handoff = {
        schema_version: 1, store_id: state.meta.store_id, id: uuid(), revision: 1, created_at: worker.now(), updated_at: worker.now(),
        ticket_id: ticket.id, request_id: req.id, mode: checked.mode, note: checked.note, permissions: checked.permissions,
        // The next action as queued: a run's own suggestion conflicts only if someone changed it since.
        base_ticket_revision: ticket.revision, base_next_action: ticket.next_action ?? '', repo_id: ticket.repo_id ?? null, base_commit: null, branch: checked.branch ?? null, state: 'queued',
        requested_at: worker.now(), started_at: null, finished_at: null, deadline_at: null, error: null, result_ref: null, result_summary: null,
        children_ids: [], worktree_path: null, changed_files: [], test_results: [], commit_sha: null, pr_url: null, uncertain_effects: [], retry_of: req.retry_of ?? null,
        recipe: { name: recipe.name, source: recipe.source, hash: recipe.hash }, legacy: recipe.legacy && checked.suggest !== true, outputs: recipe.outputs, deadline_ms: recipe.timeout_min * 60_000, suggestions: [],
      };
      return { outcome: 'applied', mutation: { type: 'handoff-create', handoff }, result: { handoff_id: handoff.id } };
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
      return { outcome: 'applied', mutation, result: { handoff_id: found.h.id, suggestion_id: found.sug.id, state: mutation.state } };
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
  const payload = { request_id: req.id, outcome: evaluation.outcome, error: evaluation.error ?? null, result: evaluation.result ?? null, mutation: evaluation.mutation ?? null };
  // Session-targeted requests carry the session identity so the worker re-renders that session.
  worker.emit('request-tx', payload, { source_identity: `request-tx:${req.id}:${evaluation.outcome}`, ...(evaluation.session ?? {}) });
  worker.publishRequest(req.id);
}

// Serialized application of due requests; refresh requests are owned by the reconciliation extension.
export function applyDueRequests(worker, nowIso) {
  let applied = 0;
  for (const req of [...worker.state.requests.values()]) {
    if (req.state !== 'pending' || SCHEDULER_KINDS.has(req.kind)) continue;
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
    if (req.state !== 'applying' || SCHEDULER_KINDS.has(req.kind)) continue;
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
