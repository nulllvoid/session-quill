// `worktree` events (ADR 0036): the CLI records a ticket worktree it mounted (or removed with
// `quill worktree remove`); the worker's teardown sweep records one it pruned or kept. Local-only
// state on `ticket.worktrees[]`: never part of an export, mirror, publisher payload or vault note.
// The ticket's revision is not bumped: a worktree is machine state, not a field the owner edits.
import { WORKTREES_MAX, activeWorktrees, worktreePayloadProblems } from '../worktrees.js';

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export function applyWorktree(state, ev, result) {
  const p = ev.payload;
  if (worktreePayloadProblems(p).length) return { rejected: 'worktree-invalid' };
  const ticket = state.tickets.get(p.ticket_id);
  if (!ticket) return { rejected: 'ticket-unknown' };
  if (!Array.isArray(ticket.worktrees)) ticket.worktrees = [];
  const active = activeWorktrees(ticket);
  if (p.op === 'mounted') {
    // The same folder mounted again (a retried command) is one record.
    if (active.some((w) => w.id === p.mount_id || samePath(w.path, p.path))) return {};
    ticket.worktrees.push({ id: p.mount_id, repo_id: p.repo_id, path: p.path, branch: p.branch, base_sha: p.base_sha, state: 'mounted', mounted_at: ev.occurred_at, kept_at: null, kept_reason: null, pruned_at: null });
    // Oldest pruned records go first; active ones are never dropped.
    while (ticket.worktrees.length > WORKTREES_MAX) {
      const i = ticket.worktrees.findIndex((w) => w.state === 'pruned');
      if (i === -1) break;
      ticket.worktrees.splice(i, 1);
    }
  } else {
    const record = active.find((w) => w.id === p.mount_id && samePath(w.path, p.path));
    if (!record) return { rejected: 'worktree-unknown' };
    if (p.op === 'kept') {
      if (record.state === 'kept') return {};
      Object.assign(record, { state: 'kept', kept_at: ev.occurred_at, kept_reason: p.reason });
    } else {
      Object.assign(record, { state: 'pruned', pruned_at: ev.occurred_at });
    }
  }
  result.changed.add(ticket.id);
  return {};
}
