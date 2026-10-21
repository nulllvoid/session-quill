// Ticket worktrees (ADR 0036): pure selectors and validation shared by the reducer, the CLI and the
// worker's teardown sweep. No git, no file IO, no clock reads beyond the times passed in.
import path from 'node:path';
import { sessionState } from '../reconcile/lifecycle.js';

export const WORKTREE_OPS = ['mounted', 'pruned', 'kept'];
export const WORKTREE_STATES = ['mounted', 'kept', 'pruned'];
// Why the sweep left a worktree in place (the `kept` op). The branch is always kept.
export const KEPT_REASONS = ['uncommitted-changes', 'detached-head'];
export const WORKTREES_MAX = 10;
export const DEFAULT_KEEP_DAYS = 7;
export const DEFAULT_COPY = Object.freeze(['.env', '.env.local']);

const DAY_MS = 86_400_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MOUNT_ID = /^[0-9a-f-]{8,64}$/;
// A repository id used as one folder name: the characters `repoIdFromPath` produces, never "..".
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function isSafeRepoId(id) {
  return typeof id === 'string' && REPO_ID.test(id) && !id.includes('..');
}

/** The branch a ticket worktree checks out: `quill/<KEY>`. */
export function ticketBranch(key) {
  return `quill/${key}`;
}

/** `<root>/<repo_id>/<KEY>`, where root is `<quillHome>/worktrees`. Throws on an unsafe segment. */
export function ticketWorktreeDir(root, repoId, key) {
  if (!isSafeRepoId(repoId)) throw new Error(`unsafe repository id for a worktree folder: ${repoId}`);
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(key) || key.includes('..') || key.endsWith('.')) throw new Error(`unsafe ticket key for a worktree folder: ${key}`);
  return path.join(root, repoId, key);
}

/** Source identity of a worktree event; `mount_id` makes a remount at the same path a new record. */
export function worktreeIdentity({ ticket_id, op, path: p, mount_id }) {
  return `worktree:${ticket_id}:${op}:${p}:${mount_id}`;
}

/** Problems with a worktree event payload (empty when it is well formed). */
export function worktreePayloadProblems(p) {
  const out = [];
  if (!p || typeof p !== 'object') return ['payload'];
  if (!WORKTREE_OPS.includes(p.op)) out.push('op');
  if (typeof p.ticket_id !== 'string' || !p.ticket_id) out.push('ticket_id');
  if (typeof p.mount_id !== 'string' || !MOUNT_ID.test(p.mount_id)) out.push('mount_id');
  if (typeof p.path !== 'string' || !path.isAbsolute(p.path) || p.path.length > 1024) out.push('path');
  if (p.op === 'mounted') {
    if (!isSafeRepoId(p.repo_id)) out.push('repo_id');
    if (typeof p.branch !== 'string' || !p.branch || p.branch.length > 255) out.push('branch');
    if (typeof p.base_sha !== 'string' || !SHA.test(p.base_sha)) out.push('base_sha');
  }
  if (p.op === 'kept' && !KEPT_REASONS.includes(p.reason)) out.push('reason');
  return out;
}

/** The ticket's worktree records still on disk as far as the journal knows (mounted or kept). */
export function activeWorktrees(ticket) {
  return (Array.isArray(ticket && ticket.worktrees) ? ticket.worktrees : []).filter((w) => w && w.state !== 'pruned');
}

const fold = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** True when `p` is `root` itself or inside it (case-insensitive on Windows). */
export function isInsideOrSame(root, p) {
  if (typeof root !== 'string' || typeof p !== 'string' || !root || !p) return false;
  const rel = path.relative(fold(root), fold(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * What the teardown sweep may do with each ticket worktree (ADR 0036). A worktree is due when its
 * ticket is done and neither the ticket nor the mount changed for `keepDays`, and no session that is
 * still live or idle started inside it or is bound to the ticket. Returns
 * `[{ ticket_id, key, record, due, hold }]` for active records; `hold` names why a done ticket's
 * worktree waits (`recent`, `session`), null when due or not done.
 */
export function teardownPlan(tickets, sessions, { nowIso, keepDays = DEFAULT_KEEP_DAYS } = {}) {
  const now = Date.parse(nowIso);
  const live = [...(sessions ?? [])].filter((s) => s && ['live', 'idle'].includes(sessionState(s, nowIso)));
  const out = [];
  for (const ticket of tickets ?? []) {
    for (const record of activeWorktrees(ticket)) {
      let hold = null;
      if (ticket.status === 'done') {
        const since = [ticket.updated_at, record.mounted_at].filter(Boolean).sort().at(-1);
        const age = now - Date.parse(since);
        if (!(Number.isFinite(age) && age >= keepDays * DAY_MS)) hold = 'recent';
        else if (live.some((s) => s.current_ticket_id === ticket.id || (s.cwd && isInsideOrSame(record.path, s.cwd)))) hold = 'session';
      }
      out.push({ ticket_id: ticket.id, key: ticket.key, record, due: ticket.status === 'done' && hold === null, hold });
    }
  }
  return out;
}
