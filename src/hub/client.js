// The member side of the team hub (ADR 0044): the owner's worker pushes a sanitized, read-only copy
// of the board to a hub the team hosts itself. It is the read-only mirror (ADR 0019) sent over
// HTTPS instead of into a synced folder: same sanitizer, same project and field filters, no
// checkpoint text, and nothing comes back.
//
//   [hub]                              # user config only; a repository's .quill.toml cannot set it
//   url = "https://quill.example.org"
//   enabled = true
//   confirmed_url = "https://quill.example.org"   # written by `quill hub join --confirm`
//   token_env = "QUILL_HUB_TOKEN"      # the variable that holds the member token, never the token
//   interval_seconds = 300             # at most one push per interval (floor 60)
//   projects = ["payments"]            # optional: only these projects leave the machine
//   fields = ["key", "title", …]       # optional: export fields (default: the shared-snapshot set)
//   include_links = false
//   accept_edits = false               # true: teammates' status and next-action edits from the hub
//                                      # become revision-checked requests here (ADR 0045)
import path from 'node:path';
import { sanitizeSnapshot, isExportableTicket, SELECTABLE_FIELDS } from '../export/sanitize.js';
import { readJsonIfExists, writeJsonAtomic, ensureDir } from '../lib/atomic-fs.js';
import { stateDir } from '../lib/paths.js';
import { TrackerError } from '../lib/errors.js';
import { createHash } from 'node:crypto';
import { writeIngress } from '../core/ingress.js';
import { makeEvent } from '../core/events.js';
import { bodyHash, EDIT_DELAY_MS } from '../server/requests.js';
import { addMs } from '../lib/time.js';

export const DEFAULT_TOKEN_ENV = 'QUILL_HUB_TOKEN';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_INTERVAL_MS = 60_000;
const PUSH_TIMEOUT_MS = 15_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A hub address as stored: origin plus an optional path prefix, no trailing slash; or a reason. */
export function normalizeHubUrl(raw, { allowHttp = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return { url: null, problem: 'no hub address' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { url: null, problem: 'the hub address is not a URL' }; }
  if (u.username || u.password) return { url: null, problem: 'the hub address must not contain a user name or password' };
  if (u.search || u.hash) return { url: null, problem: 'the hub address must not contain a query or fragment' };
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (allowHttp || LOOPBACK.has(u.hostname)))) {
    return { url: null, problem: 'the hub address must use https (http is accepted for localhost, or with allow_http = true on a network you trust)' };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, problem: null };
}

export function hubSettings(config = {}, env = {}) {
  const h = config.hub && typeof config.hub === 'object' && !Array.isArray(config.hub) ? config.hub : {};
  const { url, problem } = normalizeHubUrl(h.url, { allowHttp: h.allow_http === true });
  const tokenEnv = typeof h.token_env === 'string' && ENV_NAME.test(h.token_env) ? h.token_env : DEFAULT_TOKEN_ENV;
  const token = typeof env[tokenEnv] === 'string' && env[tokenEnv].trim() ? env[tokenEnv].trim() : null;
  const confirmed = !!url && typeof h.confirmed_url === 'string' && h.confirmed_url === url;
  const seconds = Number.isFinite(h.interval_seconds) ? h.interval_seconds : 300;
  const fields = Array.isArray(h.fields) ? h.fields.filter((f) => SELECTABLE_FIELDS.includes(f)) : [];
  const problems = [];
  if (h.url !== undefined && problem) problems.push(problem);
  if (url && !confirmed) problems.push('this hub address has not been confirmed; run `quill hub join <url> --confirm`');
  if (url && !token) problems.push(`no token: set the ${tokenEnv} environment variable for the worker`);
  return {
    configured: h.url !== undefined,
    url,
    confirmed,
    // Pushing needs all of: switched on, a valid address the owner confirmed, and a token.
    enabled: h.enabled === true && confirmed && !!token,
    switched_on: h.enabled === true,
    token_env: tokenEnv,
    token,
    interval_ms: Math.max(MIN_INTERVAL_MS, seconds * 1000),
    projects: Array.isArray(h.projects) && h.projects.length ? h.projects.filter((p) => typeof p === 'string') : null,
    fields: fields.length ? fields : null,
    include_links: h.include_links === true,
    accept_edits: h.accept_edits === true,
    problems,
  };
}

export function exportOptions(settings, now) {
  const o = { exportedAt: now, projects: settings.projects, includeLinks: settings.include_links, includeCheckpoints: false };
  if (settings.fields) o.fields = settings.fields;
  return o;
}

export function buildPayload(snapshot, settings, { now, storeId, machineName = null }) {
  return { schema_version: 1, store_id: storeId, machine_name: machineName, accepts_edits: settings.accept_edits === true, snapshot: sanitizeSnapshot(snapshot, exportOptions(settings, now)) };
}

export function shareableTicketCount(snapshot, settings) {
  return snapshot.tickets.filter((t) => isExportableTicket(t) && (!settings.projects || settings.projects.includes(t.project_id))).length;
}

// Errors name the hub and the status, never the token.
function pushError(status, body) {
  const detail = body && body.error && typeof body.error.message === 'string' ? body.error.message.slice(0, 300) : null;
  if (status === 401) return new TrackerError('hub-unauthorized', 'the hub did not accept the token; ask whoever runs the hub whether it was revoked');
  if (status === 403) return new TrackerError('hub-forbidden', detail ?? 'the hub refused the push');
  if (status === 409) return new TrackerError('hub-board-limit', detail ?? 'the hub holds too many boards for this token');
  if (status === 413) return new TrackerError('hub-too-large', detail ?? 'the board is larger than the hub accepts; narrow [hub] projects or fields');
  if (status === 422) return new TrackerError('hub-rejected', detail ?? 'the hub rejected the snapshot');
  if (status === 429) return new TrackerError('hub-rate-limited', 'the hub is refusing requests from this address for a few minutes');
  return new TrackerError('hub-error', `the hub answered ${status}${detail ? `: ${detail}` : ''}`);
}

async function request(settings, method, route, { body, fetchImpl = globalThis.fetch, auth = true } = {}) {
  if (!settings.url) throw new TrackerError('hub-not-configured', 'no hub address is configured; run `quill hub join <url>`');
  if (auth && !settings.token) throw new TrackerError('hub-no-token', `set the ${settings.token_env} environment variable to your member token`);
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${settings.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    // A redirect could carry the token to another host: refuse it.
    res = await fetchImpl(`${settings.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? `no answer within ${PUSH_TIMEOUT_MS / 1000} s` : (err && err.cause && err.cause.code) || (err && err.message) || 'request failed';
    throw new TrackerError('hub-unreachable', `could not reach the hub at ${settings.url}: ${why}`);
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw pushError(res.status, parsed);
  return parsed;
}

export function pingHub(settings, opts = {}) {
  return request(settings, 'GET', '/healthz', { ...opts, auth: false }).then((b) => {
    if (!b || b.service !== 'quill-hub') throw new TrackerError('hub-not-a-hub', `${settings.url} answered, but not as a Session Quill hub`);
    return b;
  });
}

export const pushPayload = (settings, payload, opts = {}) => request(settings, 'PUT', '/v1/snapshot', { ...opts, body: payload });
export const removeRemoteBoard = (settings, storeId, opts = {}) => request(settings, 'DELETE', `/v1/snapshot/${encodeURIComponent(storeId)}`, opts);

export const pullEdits = (settings, storeId, opts = {}) => request(settings, 'GET', `/v1/edits?store_id=${encodeURIComponent(storeId)}`, opts).then((b) => (b && Array.isArray(b.edits) ? b.edits : []));
export const ackEdits = (settings, storeId, ids, opts = {}) => request(settings, 'POST', '/v1/edits/ack', { ...opts, body: { store_id: storeId, ids } });

// Edits a teammate proposed on the hub (ADR 0045). Each becomes the same revision-checked request a
// two-way page edit becomes (ADR 0011): through ingress, with the undo window, refused by the
// reducer if the ticket moved on. The hub is not trusted to shape it: only these two fields, these
// statuses and a bounded text are accepted, and the request id is derived from the hub's edit id,
// so an edit collected twice is one request.
export const HUB_EDIT_STATUSES = Object.freeze(['todo', 'active', 'review', 'deploy-pending', 'done']);
const EDITOR_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function requestFromHubEdit(edit, { url, now }) {
  if (!edit || typeof edit !== 'object') return null;
  if (typeof edit.id !== 'string' || !/^[0-9a-f]{8,64}$/.test(edit.id)) return null;
  if (typeof edit.ticket_id !== 'string' || !edit.ticket_id || edit.ticket_id.length > 80) return null;
  if (!Number.isInteger(edit.expected_revision) || edit.expected_revision < 0) return null;
  if (typeof edit.by !== 'string' || !EDITOR_RE.test(edit.by)) return null;
  let kind;
  let payload;
  if (edit.field === 'status' && HUB_EDIT_STATUSES.includes(edit.value)) { kind = 'set-status'; payload = { status: edit.value }; }
  else if (edit.field === 'next_action' && typeof edit.value === 'string' && edit.value.length <= 2000) { kind = 'set-next-action'; payload = { next_action: edit.value }; }
  else return null;
  // A request id is a UUID; this one is derived, so the same hub edit always gives the same id.
  const h = createHash('sha256').update(JSON.stringify(['hub', url, edit.id])).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const body = { id, kind, target_id: edit.ticket_id, expected_revision: edit.expected_revision, payload };
  return { ...body, created_at: now, not_before: addMs(now, EDIT_DELAY_MS), actor_id: `hub:${edit.by}`, retry_of: null, body_hash: bodyHash(body) };
}

/** Collect waiting edits, journal them as requests, then tell the hub they were collected. */
export async function collectEdits(settings, { now, storeId, machineId, env, fetchImpl, log = () => {} }) {
  const edits = await pullEdits(settings, storeId, { fetchImpl });
  if (!edits.length) return { collected: 0, refused: 0 };
  let collected = 0;
  let refused = 0;
  for (const e of edits) {
    const req = requestFromHubEdit(e, { url: settings.url, now });
    if (!req) { refused += 1; log(`hub: ignored a malformed edit from the hub (${String(e && e.id).slice(0, 16)})`); continue; }
    writeIngress(makeEvent({ kind: 'request', payload: req, store_id: storeId, machine_id: machineId, producer: 'cli', session_id: null, agent_id: null, ticket_id: req.target_id, source_identity: `request:${req.id}`, occurred_at: now }), env);
    collected += 1;
    log(`hub: ${req.actor_id} proposed ${req.kind} on ${req.target_id}; it applies after the undo window unless the ticket changed`);
  }
  await ackEdits(settings, storeId, edits.map((e) => e.id).filter((i) => typeof i === 'string'), { fetchImpl });
  return { collected, refused };
}

const statePath = (env) => path.join(stateDir(env), 'hub.json');
export const readHubState = (env) => { try { return readJsonIfExists(statePath(env)); } catch { return null; } };
function writeHubState(env, patch) {
  try {
    ensureDir(stateDir(env));
    writeJsonAtomic(statePath(env), { ...(readHubState(env) ?? {}), ...patch });
  } catch { /* state is advisory */ }
}

/** One push, recorded in state/hub.json whether it worked or not. */
export async function pushSnapshot(snapshot, settings, { now, storeId, machineName = null, env, fetchImpl } = {}) {
  const payload = buildPayload(snapshot, settings, { now, storeId, machineName });
  try {
    const result = await pushPayload(settings, payload, { fetchImpl });
    if (env) writeHubState(env, { url: settings.url, last_attempt_at: now, last_success_at: now, last_error: null, generation_id: snapshot.generation_id, ticket_count: payload.snapshot.tickets.length });
    return { ...result, generation_id: snapshot.generation_id, ticket_count: payload.snapshot.tickets.length };
  } catch (err) {
    if (env) writeHubState(env, { url: settings.url, last_attempt_at: now, last_error: { code: err.code ?? 'hub-error', message: String(err.message).slice(0, 300) } });
    throw err;
  }
}

// Worker extension: push when a new generation exists, at most once per interval and never two at
// once, and once more when the worker stops so the hub's copy ends current. A failed push is
// logged and retried after the interval; it never blocks the worker.
export function createExtension(ctx, { fetchImpl } = {}) {
  let lastGeneration = null;
  let lastAt = -Infinity;
  let inFlight = null;
  let lastProblem = null;
  const start = (w, reason) => {
    const settings = hubSettings(w.config, w.env ?? ctx.env ?? {});
    if (!settings.enabled) {
      const problem = settings.switched_on ? settings.problems.join('; ') : null;
      if (problem && problem !== lastProblem) w.log(`hub: not pushing: ${problem}`);
      lastProblem = problem;
      return null;
    }
    lastProblem = null;
    const snap = w.lastSnapshot;
    if (!snap || snap.generation_id === lastGeneration) return null;
    lastAt = w.clock();
    const generation = snap.generation_id;
    inFlight = pushSnapshot(snap, settings, { now: w.now(), storeId: ctx.storeMeta.store_id, machineName: w.config.machine_name ?? null, env: w.env ?? ctx.env, fetchImpl })
      .then(() => { lastGeneration = generation; })
      .catch((err) => { w.log(`hub push (${reason}) failed: ${err.message}`); })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  // Edits are looked for once a minute, whether or not the board changed.
  let lastPullAt = -Infinity;
  let pulling = null;
  const pull = (w) => {
    const settings = hubSettings(w.config, w.env ?? ctx.env ?? {});
    if (!settings.enabled || !settings.accept_edits || pulling || w.clock() - lastPullAt < MIN_INTERVAL_MS) return;
    lastPullAt = w.clock();
    pulling = collectEdits(settings, { now: w.now(), storeId: ctx.storeMeta.store_id, machineId: ctx.machineId, env: w.env ?? ctx.env, fetchImpl, log: (m) => w.log(m) })
      .catch((err) => { w.log(`hub: collecting edits failed: ${err.message}`); })
      .finally(() => { pulling = null; });
  };
  return {
    tick(w) {
      pull(w);
      if (inFlight) return;
      const interval = hubSettings(w.config, w.env ?? ctx.env ?? {}).interval_ms;
      if (w.clock() - lastAt < interval) return;
      start(w, 'tick');
    },
    get collecting() { return pulling; },
    async onStop(w) {
      if (pulling) await pulling;
      if (inFlight) await inFlight;
      await start(w, 'stop');
    },
    // For tests: the push in progress, if any.
    get pending() { return inFlight; },
  };
}
