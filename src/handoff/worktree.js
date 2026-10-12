// Isolated Git worktrees for attempt-fix runs: a clean detached checkout at the recorded base
// commit that never incorporates the live session's dirty changes (TRD §Handoff execution).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TrackerError } from '../lib/errors.js';
import { isProtectedBranch } from './permissions.js';

export function git(cwd, args, { timeoutMs = 60_000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new TrackerError('git-failed', (stderr || err.message || 'git failed').trim().split('\n')[0], { args }));
      else resolve(raw ? stdout : stdout.trim());
    });
  });
}

export async function headCommit(repoPath) {
  return git(repoPath, ['rev-parse', 'HEAD']);
}

export async function createWorktree({ repoPath, baseCommit, dir }) {
  if (!repoPath || !fs.existsSync(repoPath)) throw new TrackerError('worktree-failed', `repository path is missing: ${repoPath}`);
  try {
    await git(repoPath, ['cat-file', '-e', `${baseCommit}^{commit}`]);
  } catch (err) {
    throw new TrackerError('worktree-failed', `base commit ${baseCommit} is not available in ${repoPath}: ${err.message}`);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    await git(repoPath, ['worktree', 'add', '--detach', dir, baseCommit]);
  } catch (err) {
    throw new TrackerError('worktree-failed', `git worktree add failed: ${err.message}`);
  }
  return { dir, baseCommit };
}

export async function removeWorktree({ repoPath, dir }) {
  try {
    await git(repoPath, ['worktree', 'remove', '--force', dir]);
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await git(repoPath, ['worktree', 'prune']); } catch { /* ignore */ }
  }
}

// Drops registrations of worktrees whose directory no longer exists (a crash, a manual delete).
export async function pruneWorktrees(repoPath) {
  try { await git(repoPath, ['worktree', 'prune']); } catch { /* not a repository, or git unavailable */ }
}

// Letters, digits and . _ / - @ + only, not starting with "-" and without "..": a name safe to hand to git.
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/@+-]{0,200}$/;

async function commitOf(repoPath, ref) {
  try { return await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { return null; }
}

// What a run's checkout starts from: the ticket's own branch (the one its work was recorded on)
// when it exists here or on origin, else the repository's HEAD. `ref` is a commit id or "HEAD";
// `label` is the honest sentence the prompt gives the agent.
export async function worktreeBase(ticket, repoCfg) {
  const fallback = { ref: 'HEAD', label: 'checkout is on HEAD; ticket branch unknown' };
  const repoPath = repoCfg && repoCfg.canonical_path;
  const branches = [...((ticket && ticket.branches) ?? [])].filter((b) => b && typeof b.name === 'string').sort((a, b) => String(b.last_seen ?? '').localeCompare(String(a.last_seen ?? '')));
  const branch = branches.length ? branches[0].name : null;
  if (!repoPath || !branch || !SAFE_BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) return fallback;
  const local = await commitOf(repoPath, `refs/heads/${branch}`);
  let hasOrigin = false;
  try { await git(repoPath, ['remote', 'get-url', 'origin']); hasOrigin = true; } catch { /* no origin */ }
  if (hasOrigin) {
    try { await git(repoPath, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeoutMs: 30_000 }); } catch { /* offline or branch not on origin */ }
    const remote = await commitOf(repoPath, `refs/remotes/origin/${branch}`);
    // The branch as the team last pushed it wins when the local copy is only behind it.
    if (remote && (!local || (await git(repoPath, ['merge-base', '--is-ancestor', local, remote]).then(() => true, () => false)))) return { ref: remote, label: `checkout based on branch ${branch} (origin)` };
  }
  if (local) return { ref: local, label: `checkout based on branch ${branch}` };
  return fallback;
}

export async function changedFiles(dir) {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all'], { raw: true });
  // Porcelain v1: two status columns, a space, then the path (leading spaces are significant).
  return out.split(/\r?\n/).filter((l) => l.length > 3).map((line) => line.slice(3).replace(/^"|"$/g, '')).map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p)).sort();
}

export async function diffPatch(dir) {
  await git(dir, ['add', '-A']);
  try {
    return await git(dir, ['diff', '--cached', '--binary']);
  } finally {
    try { await git(dir, ['reset', '-q']); } catch { /* ignore */ }
  }
}

export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=Session Quill handoff', '-c', 'user.email=quill@localhost', 'commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

export function isProtectedTarget(branch, repo) {
  return isProtectedBranch(branch, repo);
}

export async function pushBranch(dir, branch, repo) {
  if (isProtectedTarget(branch, repo)) throw new TrackerError('branch-protected', `refusing to push to ${branch}`);
  await git(dir, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], { timeoutMs: 120_000 });
  return branch;
}

export function openDraftPr(dir, { branch, base, title, body }) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'create', '--draft', '--head', branch, '--base', base, '--title', title, '--body', body], { cwd: dir, timeout: 120_000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new TrackerError('pr-failed', (stderr || err.message).trim().split('\n')[0]));
      const m = /(https:\/\/[^\s]+\/pull\/\d+)/.exec(stdout);
      resolve(m ? m[1] : stdout.trim());
    });
  });
}
