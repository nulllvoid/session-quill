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

// Done-when check (ADR 0016): a ticket without a repository has no PR evidence to move its status,
// so after a turn that worked on it, Claude is asked whether its Done when items are met. A turn
// that only read is not work; the check repeats only after new work and a quiet period.
export const DONE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead']);

export function doneCheckPath(sessionKey, env = process.env) {
  return path.join(stateDir(env), 'done-check', snapshotFileName(sessionKey));
}

function readDoneCheck(sessionKey, env) {
  try { return readJsonIfExists(doneCheckPath(sessionKey, env)); } catch { return null; }
}

export function isWorkTool(toolName) {
  return typeof toolName === 'string' && !READ_ONLY_TOOLS.has(toolName);
}

export function markTicketWork(sessionKey, env, ticketId, at) {
  const prior = readDoneCheck(sessionKey, env);
  const same = prior && prior.ticket_id === ticketId;
  if (same && prior.pending) return;
  writeJsonAtomic(doneCheckPath(sessionKey, env), { schema_version: 1, session_key: sessionKey, ticket_id: ticketId, pending: true, checked_at: same ? prior.checked_at ?? null : null });
}

export function shouldCheckDone(sessionKey, env, ticketId, nowIso) {
  const marker = readDoneCheck(sessionKey, env);
  if (!marker || marker.ticket_id !== ticketId || marker.pending !== true) return false;
  return !marker.checked_at || Date.parse(nowIso) - Date.parse(marker.checked_at) >= DONE_CHECK_INTERVAL_MS;
}

export function markDoneChecked(sessionKey, env, ticketId, at) {
  writeJsonAtomic(doneCheckPath(sessionKey, env), { schema_version: 1, session_key: sessionKey, ticket_id: ticketId, pending: false, checked_at: at });
}

export function doneCheckReason({ key, doneWhen }, cli) {
  const items = doneWhen.map((d) => `- ${d}`).join('\n');
  return `Session Quill: ${key} has no repository, so its status only moves when someone sets it. Check its Done when items against what has actually been done:\n${items}\nIf every item is met, set it to review with node ${JSON.stringify(cli)} ticket set ${key} --status review and tell the user in one line (use --status done instead only if the user has already confirmed the work). If not, say in one line which items remain. Do not change anything else and do not ask the user to run commands.`;
}
