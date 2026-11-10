// What the team hub accepts from a member (ADR 0044). A push must already be the output of the
// export sanitizer; the hub checks that, then applies its own rules again, so a modified or older
// client cannot store what a shared snapshot would never carry:
//
//   - only the snapshot keys an export has, and never a capability to change anything;
//   - no checkpoint text, agent result summaries or suggestions, whatever the client selected;
//   - absolute paths and known secret formats redacted a second time, on every string.
//
// The hub renders boards from this JSON with its own copy of the dashboard. It never stores or
// serves markup or script a member sent.
import { redactText as redactPaths } from '../export/sanitize.js';
import { redactText as redactSecrets, isIdentifierKey } from '../lib/redact.js';
import { TrackerError } from '../lib/errors.js';

export const MAX_TICKETS = 5000;
export const MAX_DEPTH = 40;
const TOP_LEVEL = ['schema_version', 'generation_id', 'generated_at', 'tickets', 'sessions', 'handoffs', 'picknext', 'blocked', 'deployments_outstanding', 'meta', 'repos', 'export'];
const LIST_KEYS = ['tickets', 'sessions', 'handoffs', 'picknext', 'blocked', 'deployments_outstanding', 'repos'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const READ_ONLY = Object.freeze({ read: true, edit_tickets: false, handoff: false, refresh: false, cancel_requests: false, export: false });

const refuse = (message) => new TrackerError('hub-snapshot', message);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function scrub(value, key, depth) {
  if (depth > MAX_DEPTH) throw refuse(`the snapshot nests deeper than ${MAX_DEPTH} levels`);
  if (typeof value === 'string') {
    const noPaths = redactPaths(value);
    return key !== null && isIdentifierKey(key) ? noPaths : redactSecrets(noPaths);
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, depth + 1));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!UNSAFE_KEYS.has(k)) out[k] = scrub(v, k, depth + 1);
    return out;
  }
  return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
}

function cleanHandoff(h) {
  const { result_summary, result_confidence, result_sources, result_ref, ...rest } = h;
  return { ...rest, suggestions: [] };
}

function cleanTicket(t) {
  const { run_notes, critical_spec, user_notes, ...rest } = t;
  return rest;
}

/** A stored copy of a pushed snapshot, or a `hub-snapshot` error that says what was wrong. */
export function acceptSnapshot(raw) {
  if (!isObject(raw)) throw refuse('the snapshot must be a JSON object');
  if (!isObject(raw.export) || raw.export.coverage !== 'shared-tasks-only') throw refuse('not a sanitized snapshot: push with `quill hub push`, which runs the export sanitizer first');
  if (raw.export.include_checkpoints === true) throw refuse('the hub does not store checkpoint text; push without checkpoints');
  if (!isObject(raw.meta)) throw refuse('the snapshot has no meta');
  for (const k of LIST_KEYS) if (raw[k] !== undefined && !Array.isArray(raw[k])) throw refuse(`${k} must be a list`);
  if (!Array.isArray(raw.tickets)) throw refuse('the snapshot has no tickets list');
  if (raw.tickets.length > MAX_TICKETS) throw refuse(`the hub stores at most ${MAX_TICKETS} tickets per board`);
  if (typeof raw.generation_id !== 'string' || !raw.generation_id || raw.generation_id.length > 100) throw refuse('the snapshot has no generation id');
  for (const t of raw.tickets) if (!isObject(t) || typeof t.id !== 'string' || !t.id) throw refuse('every ticket needs an id');
  if (raw.tickets.some((t) => t.local_only === true)) throw refuse('local-only tickets never leave the owner machine');

  const picked = {};
  for (const k of TOP_LEVEL) if (raw[k] !== undefined) picked[k] = raw[k];
  const s = scrub(picked, null, 0);
  s.schema_version = Number.isInteger(s.schema_version) ? s.schema_version : 1;
  s.capabilities = { ...READ_ONLY };
  s.tickets = s.tickets.map(cleanTicket);
  s.sessions = (s.sessions ?? []).filter(isObject).map(({ last_checkpoint_preview, ...rest }) => rest);
  s.handoffs = (s.handoffs ?? []).filter(isObject).map(cleanHandoff);
  s.checkpoints = [];
  s.requests = [];
  s.unresolved = [];
  for (const k of ['picknext', 'blocked', 'deployments_outstanding', 'repos']) s[k] = (s[k] ?? []).filter(isObject);
  s.meta = { ...s.meta, owner_machine_id: null, onboarding: null, autonomy: null, active_sync_request_id: null, oldest_pending_event_at: null };
  if (typeof s.meta.exported_at !== 'string' || !Number.isFinite(Date.parse(s.meta.exported_at))) throw refuse('the snapshot has no export time');
  s.export = { ...s.export, include_checkpoints: false };
  return s;
}
