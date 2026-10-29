// Isolated Git worktrees for attempt-fix runs: a clean detached checkout at the recorded base
// commit that never incorporates the live session's dirty changes (TRD §Handoff execution).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { TrackerError } from '../lib/errors.js';
import { branchNameOk } from '../lib/git-ref.js';
import { isProtectedBranch } from './permissions.js';

export function git(cwd, args, { timeoutMs = 60_000, raw = false, env = undefined } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
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

export async function removeWorktree({ repoPath, dir, under = path.dirname(dir) }) {
  try {
    await git(repoPath, ['worktree', 'remove', '--force', dir]);
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    // A bare `git worktree prune` here would also deregister the owner's own missing worktrees;
    // the scoped pruneWorktrees(repo, { under }) sweep drops only this folder's stale entries.
    if (under) await pruneWorktrees(repoPath, { under });
  }
}

// Drops registrations of worktrees whose directory no longer exists (a crash, a manual delete).
// With `under`, only registrations inside that directory are dropped: the owner's own worktrees
// (even ones whose directory is temporarily missing) are never deregistered.
const norm = (p) => path.resolve(p).replace(/[\/]+$/, '').split(path.sep).join('/').toLowerCase();
export async function pruneWorktrees(repoPath, { under = null } = {}) {
  if (!under) {
    try { await git(repoPath, ['worktree', 'prune']); } catch { /* not a repository, or git unavailable */ }
    return;
  }
  try {
    const listing = await git(repoPath, ['worktree', 'list', '--porcelain'], { raw: true });
    const root = norm(under);
    const stale = listing.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => norm(p).startsWith(`${root}/`) && !fs.existsSync(p));
    if (!stale.length) return;
    const common = path.resolve(repoPath, await git(repoPath, ['rev-parse', '--git-common-dir']));
    const admin = path.join(common, 'worktrees');
    for (const name of fs.readdirSync(admin)) {
      let target = '';
      try { target = fs.readFileSync(path.join(admin, name, 'gitdir'), 'utf8').trim(); } catch { continue; }
      if (stale.some((p) => norm(path.join(p, '.git')) === norm(target))) fs.rmSync(path.join(admin, name), { recursive: true, force: true });
    }
  } catch { /* not a repository, or git unavailable */ }
}

// True when `dir` is strictly inside `root` (case-insensitive on Windows).
export function isUnder(root, dir) {
  const a = path.resolve(root);
  const b = path.resolve(dir);
  const cmp = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = path.relative(cmp(a), cmp(b));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Letters, digits and . _ / - @ + only, not starting with "-" and without "..": a name safe to hand to git.
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/@+-]{0,200}$/;

async function commitOf(repoPath, ref) {
  try { return await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { return null; }
}

// What a run's checkout starts from: the ticket's own branch (the one its work was recorded on)
// when it exists here or on origin, else the repository's HEAD. `ref` is a commit id or "HEAD";
// `label` is the honest sentence the prompt gives the agent.
// A CI fix (ADR 0039) passes `ci`: { branch, commit } and starts from exactly the commit CI failed
// on, which must still be the branch's tip on origin (else `ci-head-changed`: nothing changes, and
// the next CI observation of the new commit decides again). A branch origin does not have, or that
// cannot be fetched, is refused (`ci-branch-missing`), never based on a stale tracking ref. The run's push then fast-forwards the
// same branch or is rejected. A protected branch is refused (`branch-protected`).
export async function worktreeBase(ticket, repoCfg, { ci = null } = {}) {
  if (ci) return ciFixBase(repoCfg, ci);
  const fallback = { ref: 'HEAD', label: 'checkout is on HEAD; ticket branch unknown' };
  const repoPath = repoCfg && repoCfg.canonical_path;
  const branches = [...((ticket && ticket.branches) ?? [])].filter((b) => b && typeof b.name === 'string').sort((a, b) => String(b.last_seen ?? '').localeCompare(String(a.last_seen ?? '')));
  const branch = branches.length ? branches[0].name : null;
  if (!repoPath || !branch || !SAFE_BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) return fallback;
  const local = await commitOf(repoPath, `refs/heads/${branch}`);
  let hasOrigin = false;
  try { await git(repoPath, ['remote', 'get-url', 'origin']); hasOrigin = true; } catch { /* no origin */ }
  if (hasOrigin) {
    // Writes refs/remotes/origin/<branch> in the owner's repository (the pushed tip is what we base on).
    // Never prompts: a credential prompt on an https origin must not stall dispatch.
    try { await git(repoPath, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }); } catch { /* offline or branch not on origin */ }
    const remote = await commitOf(repoPath, `refs/remotes/origin/${branch}`);
    // The branch as the team last pushed it wins when the local copy is only behind it.
    if (remote && (!local || (await git(repoPath, ['merge-base', '--is-ancestor', local, remote]).then(() => true, () => false)))) return { ref: remote, label: `checkout based on branch ${branch} (origin)` };
  }
  if (local) return { ref: local, label: `checkout based on branch ${branch}` };
  return fallback;
}

async function ciFixBase(repoCfg, { branch, commit }) {
  const repoPath = repoCfg && repoCfg.canonical_path;
  if (!repoPath) throw new TrackerError('worktree-failed', 'a CI fix needs the registered repository on this machine');
  if (!branchNameOk(branch)) throw new TrackerError('worktree-failed', `not a branch name git accepts: ${branch}`);
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new TrackerError('worktree-failed', 'a CI fix needs the full commit id CI failed on');
  if (isProtectedBranch(branch, repoCfg)) throw new TrackerError('branch-protected', `refusing a CI fix on protected branch ${branch}`);
  // The branch's tip as origin has it now. A failed fetch (the branch deleted, or origin unreachable)
  // refuses: the remote-tracking ref may be stale, so it is never used in its place.
  const missing = (why) => new TrackerError('ci-branch-missing', `branch ${branch} ${why}, so this CI fix did not start and nothing changed`);
  try { await git(repoPath, ['remote', 'get-url', 'origin']); } catch { throw missing('has no origin to push to'); }
  try { await git(repoPath, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }); } catch { throw missing('could not be fetched from origin (deleted there, or origin is unreachable)'); }
  const remote = await commitOf(repoPath, `refs/remotes/origin/${branch}`);
  if (!remote) throw missing('is not on origin');
  if (remote !== commit) throw new TrackerError('ci-head-changed', `branch ${branch} is at ${remote.slice(0, 7)} on origin, not at ${commit.slice(0, 7)} where CI failed, so this CI fix did not start and nothing changed`);
  if (!(await commitOf(repoPath, commit))) throw new TrackerError('worktree-failed', `commit ${commit.slice(0, 7)}, where CI failed, is not in the repository`);
  return { ref: commit, label: `checkout at commit ${commit.slice(0, 7)} of branch ${branch}, where CI failed` };
}

export async function changedFiles(dir, { baseCommit = null } = {}) {
  // Treat renames as deletion/addition so both affected paths reach the test gate.
  const out = await git(dir, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], { raw: true });
  const files = out.split('\0').filter(Boolean).map((entry) => entry.slice(3));
  if (baseCommit) {
    const committed = await git(dir, ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', baseCommit, 'HEAD', '--'], { raw: true });
    files.push(...committed.split('\0').filter(Boolean));
  }
  return [...new Set(files)].sort();
}

export async function diffPatch(dir, { baseCommit = null } = {}) {
  const tree = await workingTree(dir);
  return git(dir, ['diff', '--binary', '--end-of-options', baseCommit ?? 'HEAD', tree, '--']);
}

export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=Session Quill handoff', '-c', 'user.email=quill@localhost', 'commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// The tree of the checkout as `commitAll` would commit it, written with a temporary index so the
// checkout's own index and HEAD are untouched (ADR 0033: the tested tree).
export async function workingTree(dir) {
  const index = path.join(os.tmpdir(), `quill-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ['read-tree', 'HEAD'], { env });
    await git(dir, ['add', '-A'], { env });
    return await git(dir, ['write-tree'], { env });
  } finally {
    try { fs.rmSync(index, { force: true }); } catch { /* ignore */ }
  }
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

// ---- Ticket worktrees (ADR 0036): a named branch checked out outside the repository for an
// interactive session. Never used for worker runs, which keep their detached checkouts above.

const refOk = (b) => typeof b === 'string' && SAFE_BRANCH.test(b) && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.') && !b.endsWith('.lock') && !b.includes('@{');

/** Whether `branch` may be a ticket worktree's branch: a safe name git accepts that is not protected. */
export async function checkWorktreeBranch(repoPath, branch, repo) {
  if (!refOk(branch)) throw new TrackerError('branch-invalid', `not a safe branch name: ${branch}`);
  if (isProtectedBranch(branch, repo)) throw new TrackerError('branch-protected', `refusing a worktree on protected branch ${branch}`);
  try { await git(repoPath, ['check-ref-format', '--branch', branch]); } catch { throw new TrackerError('branch-invalid', `git does not accept the branch name ${branch}`); }
  return branch;
}

/**
 * `git worktree add` of `branch` at `dir`. An existing branch is checked out as it is (its commits are
 * the ticket's earlier work); a new one starts at `base` (a commit id or HEAD). Returns
 * { dir, branch, base_sha, created_branch }. Never forces, never resets a branch.
 */
export async function createBranchWorktree({ repoPath, dir, branch, base = 'HEAD', repo = null }) {
  if (!repoPath || !fs.existsSync(repoPath)) throw new TrackerError('worktree-failed', `repository path is missing: ${repoPath}`);
  await checkWorktreeBranch(repoPath, branch, repo);
  if (fs.existsSync(dir)) throw new TrackerError('worktree-exists', `${dir} already exists`);
  const existing = await commitOf(repoPath, `refs/heads/${branch}`);
  let baseSha = existing;
  if (!existing) {
    if (typeof base !== 'string' || !(base === 'HEAD' || /^[0-9a-f]{7,64}$/.test(base))) throw new TrackerError('worktree-failed', `invalid base ${base}`);
    baseSha = await commitOf(repoPath, base);
    if (!baseSha) throw new TrackerError('worktree-failed', `base ${base} is not a commit in ${repoPath}`);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    await git(repoPath, existing ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, baseSha]);
  } catch (err) {
    throw new TrackerError('worktree-failed', `git worktree add failed: ${err.message}`);
  }
  return { dir, branch, base_sha: baseSha, created_branch: !existing };
}

const isAbsoluteAnywhere = (p) => path.isAbsolute(p) || path.win32.isAbsolute(p) || path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p);
const realOrNull = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

// A `[worktree] copy` entry as path segments, or null when it is absolute in any spelling or has a
// `..`, `.git` or empty segment.
function copyEntryParts(raw) {
  const entry = typeof raw === 'string' ? raw.trim() : '';
  const rel = entry.replace(/\\/g, '/');
  const parts = rel.split('/');
  if (!rel || rel.includes('\0') || isAbsoluteAnywhere(entry) || parts.some((s) => s === '..' || s === '' || s.toLowerCase() === '.git')) return null;
  return parts;
}

/**
 * Copies `[worktree] copy` entries from the repository into a new worktree. An entry is a
 * repository-relative path without `..`, `.git` or an absolute form; it is copied only when the source is a
 * regular file (lstat: no links) that git ignores, its real path stays inside the repository, and
 * the destination does not exist and resolves inside the worktree. Files are copied, never linked.
 * Returns { copied: [rel], skipped: [{ path, reason }] }.
 */
export async function copyIgnoredFiles({ repoPath, dir, entries = [] }) {
  const copied = [];
  const skipped = [];
  const repoReal = realOrNull(repoPath);
  const dirReal = realOrNull(dir);
  for (const raw of Array.isArray(entries) ? entries : []) {
    const parts = copyEntryParts(raw);
    if (!parts) { skipped.push({ path: String(raw).slice(0, 200), reason: 'invalid-path' }); continue; }
    const rel = parts.join('/');
    const src = path.join(repoPath, ...parts);
    let st = null;
    try { st = fs.lstatSync(src); } catch { st = null; }
    if (!st) { skipped.push({ path: rel, reason: 'missing' }); continue; }
    if (!st.isFile()) { skipped.push({ path: rel, reason: 'not-a-file' }); continue; }
    const srcReal = realOrNull(src);
    if (!repoReal || !srcReal || !isUnder(repoReal, srcReal)) { skipped.push({ path: rel, reason: 'outside-repository' }); continue; }
    // Exit 0 only for a path an ignore rule matches; tracked files are never reported ignored.
    const ignored = await git(repoPath, ['check-ignore', '-q', '--', rel]).then(() => true, () => false);
    if (!ignored) { skipped.push({ path: rel, reason: 'not-ignored' }); continue; }
    const dest = path.join(dir, ...parts);
    let destSt = null;
    try { destSt = fs.lstatSync(dest); } catch { destSt = null; }
    if (destSt) { skipped.push({ path: rel, reason: 'exists' }); continue; }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const parentReal = realOrNull(path.dirname(dest));
      // A tracked symlinked folder in the checkout must not carry the copy outside the worktree.
      if (!dirReal || !parentReal || !(parentReal === dirReal || isUnder(dirReal, parentReal))) { skipped.push({ path: rel, reason: 'outside-worktree' }); continue; }
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch (err) {
      skipped.push({ path: rel, reason: err.code === 'EEXIST' ? 'exists' : 'copy-failed' });
    }
  }
  return { copied, skipped };
}

/** Whether `dir` is a registered worktree of `repoPath` (git's own listing). */
export async function isWorktreeOf(repoPath, dir) {
  try {
    const listing = await git(repoPath, ['worktree', 'list', '--porcelain'], { raw: true });
    const target = norm(realOrNull(dir) ?? dir);
    return listing.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).some((p) => norm(realOrNull(p) ?? p) === target);
  } catch { return false; }
}

/** What removing the worktree at `dir` would lose: null when nothing, else the kept reason. */
export async function worktreeLoss(dir) {
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=all'], { raw: true });
  if (status.trim()) return 'uncommitted-changes';
  // A detached HEAD whose commit no branch contains would leave its commits unreferenced.
  const onBranch = await git(dir, ['symbolic-ref', '-q', 'HEAD']).then(() => true, () => false);
  if (!onBranch) {
    const containing = await git(dir, ['for-each-ref', '--count=1', '--contains', 'HEAD', 'refs/heads', 'refs/remotes']).catch(() => '');
    if (!containing) return 'detached-head';
  }
  return null;
}

const sameBytes = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };

/**
 * Whether removing the worktree at `dir` would lose a `[worktree] copy` file (ADR 0036): git status
 * never lists ignored files and `git worktree remove` deletes them, so an ignored entry present in
 * the worktree must match the repository's own copy byte for byte. One that differs, one whose
 * original is gone, and an ignored non-file at the entry's path count; a tracked path never does
 * (git status covers it), nor does a symlink (removing it loses only the link).
 */
// `git check-ignore -q`: exit 0 ignored, exit 1 not ignored, anything else unknown.
function ignoreState(cwd, rel) {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', '--', rel], { cwd, timeout: 60_000, windowsHide: true }, (err) => resolve(!err ? 'ignored' : err.code === 1 ? 'not-ignored' : 'unknown'));
  });
}

export async function copiedFilesChanged({ repoPath, dir, entries = [] }) {
  for (const raw of Array.isArray(entries) ? entries : []) {
    const parts = copyEntryParts(raw);
    if (!parts) continue;
    const dest = path.join(dir, ...parts);
    let st = null;
    try { st = fs.lstatSync(dest); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) {
      const src = path.join(repoPath, ...parts);
      let srcSt = null;
      try { srcSt = fs.lstatSync(src); } catch { srcSt = null; }
      if (srcSt && srcSt.isFile() && srcSt.size === st.size && sameBytes(src, dest)) continue;
    }
    // Exit 0 only for a path an ignore rule matches; a tracked file is never reported ignored (exit 1).
    // Any other outcome (git failed, timed out) keeps the worktree: nothing is removed on a guess.
    if ((await ignoreState(dir, parts.join('/'))) !== 'not-ignored') return true;
  }
  return false;
}

/**
 * Removes a ticket worktree only when nothing would be lost (ADR 0036): `dir` must be inside `root`
 * and a registered worktree of the repository, `git status --porcelain` must be empty, and the
 * removal is `git worktree remove` without `--force` (git itself refuses a dirty or locked
 * worktree). The branch is kept. Returns { removed: true, missing? } or { removed: false, reason }.
 */
export async function removeCleanWorktree({ repoPath, dir, root, copy = [] }) {
  if (!root || !isUnder(root, dir)) return { removed: false, reason: 'outside-worktrees-root' };
  if (!fs.existsSync(dir)) {
    if (repoPath && fs.existsSync(repoPath)) await pruneWorktrees(repoPath, { under: root });
    return { removed: true, missing: true };
  }
  if (!repoPath || !fs.existsSync(repoPath)) return { removed: false, reason: 'repository-missing' };
  if (!(await isWorktreeOf(repoPath, dir))) return { removed: false, reason: 'not-a-worktree' };
  let loss;
  try { loss = await worktreeLoss(dir); } catch (err) { return { removed: false, reason: 'status-failed', message: err.message }; }
  if (loss) return { removed: false, reason: loss };
  try {
    if (await copiedFilesChanged({ repoPath, dir, entries: copy })) return { removed: false, reason: 'ignored-files-changed' };
  } catch (err) { return { removed: false, reason: 'status-failed', message: err.message }; }
  try {
    await git(repoPath, ['worktree', 'remove', dir]);
  } catch (err) {
    return { removed: false, reason: 'remove-failed', message: err.message };
  }
  return fs.existsSync(dir) ? { removed: false, reason: 'remove-failed', message: 'the folder is still there' } : { removed: true };
}
