// Nudge-mode bookkeeping (ADR 0005): PostToolUse marks a session that changed files while unbound,
// and Stop asks Claude once per session to find out which ticket the work belongs to.
import path from 'node:path';
import { stateDir } from '../lib/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';
import { snapshotFileName } from './binding-snapshot.js';
import { keyExample } from '../core/external-keys.js';

export function nudgePath(sessionKey, env = process.env) {
  return path.join(stateDir(env), 'nudge', snapshotFileName(sessionKey));
}

function readNudge(sessionKey, env) {
  try { return readJsonIfExists(nudgePath(sessionKey, env)); } catch { return null; }
}

export function markUnboundWork(sessionKey, env, at) {
  const prior = readNudge(sessionKey, env);
  if (prior && (prior.pending || prior.nudged_at)) return;
  writeJsonAtomic(nudgePath(sessionKey, env), { schema_version: 1, session_key: sessionKey, pending: true, first_at: at, nudged_at: null });
}

export function shouldNudge(sessionKey, env) {
  const marker = readNudge(sessionKey, env);
  return !!(marker && marker.pending === true && !marker.nudged_at);
}

export function markNudged(sessionKey, env, at) {
  const prior = readNudge(sessionKey, env) ?? {};
  writeJsonAtomic(nudgePath(sessionKey, env), { ...prior, schema_version: 1, session_key: sessionKey, pending: false, nudged_at: at });
}

export function nudgeReason(tracker) {
  const how = tracker
    ? `tell them that mentioning its key (for example ${keyExample(tracker)}) in their next message links this session`
    : 'tell them they can link it with /session-quill:ticket bind <KEY> or /session-quill:ticket create "<title>"';
  return `Session Quill: this turn changed files but the session is not linked to a ticket. Before finishing, ask the user which ticket this work belongs to and ${how}. If the work has no ticket, say so. Do not ask again.`;
}
