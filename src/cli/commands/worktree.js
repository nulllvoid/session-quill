// Ticket worktrees (ADR 0036, FR-1.1): `ticket work|bind --worktree` mounts one; `quill worktree
// list` shows them and `quill worktree remove <KEY>` removes a clean one. A ticket worktree is a
// named branch `quill/<KEY>` checked out under `<quillHome>/worktrees/<repo>/<KEY>`, outside the
// repository. Worker runs never use it: they keep their own detached checkouts.
import fs from 'node:fs';
import { loadContext, cliEvent, submitAndWait, latestSnapshot, latestTicketDetail, findTicketByKey, commandName } from '../context.js';
import { worktreeConfig } from '../../config/config.js';
import { validateKey } from '../../core/keys.js';
import { uuid } from '../../lib/ids.js';
import { TrackerError } from '../../lib/errors.js';
import { currentBranch } from '../../lib/git-head.js';
import { activeWorktrees, isInsideOrSame, ticketBranch, ticketWorktreeDir, worktreeIdentity } from '../../core/worktrees.js';
import { createBranchWorktree, copyIgnoredFiles, git, isWorktreeOf, removeCleanWorktree, worktreeBase, worktreeLoss } from '../../handoff/worktree.js';
import { ticketWorktreesRoot } from '../../handoff/ticket-worktrees.js';

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const short = (sha) => String(sha ?? '').slice(0, 8);
const timeout = (flags) => (flags.timeout ? Number(flags.timeout) : 10_000);

async function record(ctx, payload, { session = null, flags = {} } = {}) {
  const ev = cliEvent(ctx, { kind: 'worktree', payload, session, ticket_id: payload.ticket_id, source_identity: worktreeIdentity(payload) });
  const ack = await submitAndWait(ctx, ev, { timeoutMs: timeout(flags) });
  if (ack.rejected) throw new TrackerError(ack.rejected, `worktree ${payload.op} rejected: ${ack.rejected}`);
  return ack;
}

/** Whether `ticket work|bind` should mount a worktree: `--worktree`, `--no-worktree`, else `[worktree] auto`. */
export function worktreeWanted(ctx, flags) {
  if (flags['no-worktree']) return null;
  if (flags.worktree) return 'explicit';
  return worktreeConfig(ctx.config).auto ? 'auto' : null;
}

/**
 * Mounts (or reuses) the ticket worktree for `ticket` and records it. Prints the path and tells
 * Claude to switch into it. Returns { path, branch, base_sha, reused, copied }.
 */
export async function mountTicketWorktree(ctx, io, ticket, { session = null, flags = {} } = {}) {
  const repoId = ticket.repo_id;
  if (!repoId) throw new TrackerError('worktree-no-repo', `${ticket.key} has no repository; link one with ${commandName('ticket')} set ${ticket.key} --repo <id>`);
  const repo = (ctx.config.repos ?? {})[repoId];
  const repoPath = repo && repo.canonical_path;
  if (!repoPath || !fs.existsSync(repoPath)) throw new TrackerError('worktree-no-repo', `repository ${repoId} has no local checkout registered on this machine (see quill repo list)`);
  let dir;
  try { dir = ticketWorktreeDir(ticketWorktreesRoot(ctx.env), repoId, ticket.key); } catch (err) { throw new TrackerError('worktree-failed', err.message); }
  const branch = ticketBranch(ticket.key);
  const detail = latestTicketDetail(ctx, ticket.id) ?? findTicketByKey(ctx, ticket.key) ?? ticket;
  const known = activeWorktrees(detail).find((w) => samePath(w.path, dir));
  let info;
  if (fs.existsSync(dir)) {
    // Only our own worktree on its own branch is reused; anything else at that path is left alone.
    if (!(await isWorktreeOf(repoPath, dir))) throw new TrackerError('worktree-exists', `${dir} exists but is not a worktree of ${repoId}; move it away and run the command again`);
    const head = currentBranch(dir);
    if (head !== branch) throw new TrackerError('worktree-exists', `${dir} is checked out on ${head ?? 'a detached HEAD'}, not ${branch}; switch it back or remove it with quill worktree remove ${ticket.key}`);
    info = { path: dir, branch, base_sha: known ? known.base_sha : await git(dir, ['rev-parse', 'HEAD']), reused: true, copied: [], label: null };
    if (!known) info.mount_id = uuid();
  } else {
    const base = await worktreeBase(detail, repo);
    const made = await createBranchWorktree({ repoPath, dir, branch, base: base.ref, repo });
    const copies = await copyIgnoredFiles({ repoPath, dir, entries: worktreeConfig(ctx.config).copy });
    info = { path: dir, branch, base_sha: made.base_sha, reused: false, created_branch: made.created_branch, copied: copies.copied, skipped: copies.skipped.filter((s) => s.reason !== 'missing'), label: base.ref === 'HEAD' ? "the repository's HEAD" : base.label.replace(/^checkout based on /, ''), mount_id: uuid() };
  }
  if (info.mount_id) await record(ctx, { op: 'mounted', mount_id: info.mount_id, ticket_id: ticket.id, repo_id: repoId, path: dir, branch, base_sha: info.base_sha }, { session, flags });
  if (info.reused) io.println(`Worktree for ${ticket.key} already exists on branch ${branch} (${short(info.base_sha)}).`);
  else if (info.created_branch) io.println(`Created branch ${branch} from ${info.label} (${short(info.base_sha)}) in a new worktree for ${ticket.key}.`);
  else io.println(`Checked out the existing branch ${branch} (${short(info.base_sha)}) in a new worktree for ${ticket.key}.`);
  if (info.copied.length) io.println(`Copied ignored files: ${info.copied.join(', ')}`);
  for (const s of info.skipped ?? []) io.println(`Not copied: ${s.path} (${s.reason})`);
  io.println(`Worktree path: ${dir}`);
  io.println(`Switch into it before editing: cd "${dir}" (or open that folder with your worktree tool). The checkout at ${repoPath} is unchanged.`);
  return { path: dir, branch, base_sha: info.base_sha, reused: info.reused, copied: info.copied };
}

async function state(dir) {
  if (!fs.existsSync(dir)) return 'missing';
  try {
    const loss = await worktreeLoss(dir);
    return loss === 'uncommitted-changes' ? 'uncommitted changes' : loss === 'detached-head' ? 'detached HEAD' : 'clean';
  } catch { return 'unreadable'; }
}

async function list(ctx, io, flags) {
  const snap = latestSnapshot(ctx);
  const rows = [];
  for (const t of snap ? snap.tickets : []) {
    const records = flags.all ? (Array.isArray(t.worktrees) ? t.worktrees : []) : activeWorktrees(t);
    for (const w of records) rows.push({ key: t.key, ticket_status: t.status, state: w.state, kept_reason: w.kept_reason ?? null, branch: w.branch, path: w.path, repo_id: w.repo_id, base_sha: w.base_sha, mounted_at: w.mounted_at, pruned_at: w.pruned_at ?? null, disk: w.state === 'pruned' ? null : await state(w.path) });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (flags.json) { io.json(rows); return 0; }
  if (!rows.length) { io.println(`No ticket worktrees. Mount one with ${commandName('ticket')} work|bind ... --worktree.`); return 0; }
  for (const r of rows) io.println(`${r.key.padEnd(24)} ${r.ticket_status.padEnd(15)} ${r.branch}  ${r.state === 'pruned' ? `removed ${r.pruned_at}` : r.disk}${r.state === 'kept' ? ` (kept: ${r.kept_reason})` : ''}\n  ${r.path}`);
  io.println(`${rows.length} worktree(s)`);
  return 0;
}

const REFUSALS = {
  'uncommitted-changes': 'it has uncommitted changes; commit, stash or discard them first (there is no force option)',
  'detached-head': 'its HEAD is detached on commits no branch contains; put them on a branch first',
  'not-a-worktree': 'git does not list it as a worktree of the repository',
  'outside-worktrees-root': 'it is outside the Quill worktrees folder',
  'repository-missing': 'its repository has no local checkout registered',
};

async function remove(ctx, io, args, flags) {
  const [key] = args;
  if (!key) throw new TrackerError('key-required', 'usage: worktree remove <KEY>');
  validateKey(key);
  const ticket = findTicketByKey(ctx, key);
  if (!ticket) throw new TrackerError('ticket-unknown', `unknown ticket key ${key}`);
  const records = activeWorktrees(ticket);
  if (!records.length) throw new TrackerError('worktree-unknown', `${ticket.key} has no ticket worktree (see quill worktree list)`);
  const root = ticketWorktreesRoot(ctx.env);
  for (const w of records) {
    if (isInsideOrSame(w.path, process.cwd())) throw new TrackerError('worktree-in-use', `this command runs inside ${w.path}; run it from another folder`);
    const repo = (ctx.config.repos ?? {})[w.repo_id];
    const r = await removeCleanWorktree({ repoPath: repo && repo.canonical_path, dir: w.path, root });
    if (!r.removed) throw new TrackerError(r.reason === 'uncommitted-changes' ? 'worktree-dirty' : 'worktree-not-removed', `not removing ${w.path}: ${REFUSALS[r.reason] ?? `${r.reason}${r.message ? ` (${r.message})` : ''}`}`);
    await record(ctx, { op: 'pruned', mount_id: w.id, ticket_id: ticket.id, repo_id: w.repo_id, path: w.path, branch: w.branch, base_sha: w.base_sha, ...(r.missing ? { reason: 'missing' } : {}) }, { flags });
    io.println(`${r.missing ? 'Recorded the already-deleted worktree' : 'Removed the worktree'} for ${ticket.key} at ${w.path}; branch ${w.branch} kept.`);
  }
  return 0;
}

export async function run({ args, flags, io, env }) {
  const [verb, ...rest] = args;
  const ctx = loadContext(env);
  switch (verb) {
    case 'list': return list(ctx, io, flags);
    case 'remove': return remove(ctx, io, rest, flags);
    default:
      throw new TrackerError('usage', 'usage: worktree list [--all] [--json] | worktree remove <KEY>');
  }
}
