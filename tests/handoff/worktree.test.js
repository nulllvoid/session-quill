import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorktree, removeWorktree, headCommit, changedFiles, diffPatch, isProtectedTarget } from '../../src/handoff/worktree.js';
import { makeRepo, git } from './helpers.js';

test('createWorktree checks out the recorded base commit detached and never includes the live dirty changes', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, 'src.js'), 'export const a = 2; // dirty, uncommitted\n');
  fs.writeFileSync(path.join(repo.dir, 'untracked.txt'), 'x');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-wt-')), 'wt');
  const wt = await createWorktree({ repoPath: repo.dir, baseCommit: repo.head, dir });
  assert.equal(wt.dir, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'src.js'), 'utf8'), 'export const a = 1;\n');
  assert.equal(fs.existsSync(path.join(dir, 'untracked.txt')), false);
  assert.equal(await headCommit(dir), repo.head);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
  // live checkout untouched
  assert.equal(fs.readFileSync(path.join(repo.dir, 'src.js'), 'utf8'), 'export const a = 2; // dirty, uncommitted\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const a = 3;\n');
  assert.deepEqual(await changedFiles(dir), ['src.js']);
  assert.match(await diffPatch(dir), /\+export const a = 3;/);
  assert.equal(fs.readFileSync(path.join(repo.dir, 'src.js'), 'utf8'), 'export const a = 2; // dirty, uncommitted\n', 'edits in the worktree do not touch the live checkout');
  await removeWorktree({ repoPath: repo.dir, dir });
  assert.equal(fs.existsSync(dir), false);
});

test('createWorktree fails with a reason when the base commit or repo is invalid', async () => {
  const repo = makeRepo();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-wt-')), 'wt');
  await assert.rejects(() => createWorktree({ repoPath: repo.dir, baseCommit: 'deadbeef', dir }), (e) => e.code === 'worktree-failed');
  await assert.rejects(() => createWorktree({ repoPath: path.join(os.tmpdir(), 'not-a-repo-xyz'), baseCommit: repo.head, dir }), (e) => e.code === 'worktree-failed');
});

test('protected branch targets are refused', () => {
  assert.equal(isProtectedTarget('main', { default_branch: 'main' }), true);
  assert.equal(isProtectedTarget('release/1.0', { default_branch: 'main' }), true);
  assert.equal(isProtectedTarget('feat/handoff-x', { default_branch: 'main' }), false);
});

import { worktreeBase, pruneWorktrees } from '../../src/handoff/worktree.js';
import { attachExtensions, extensionOptions } from '../../src/cli/commands/worker.js';

const ticketOn = (...names) => ({ branches: names.map((name, i) => ({ name, first_seen: `2026-10-0${i + 1}T00:00:00Z`, last_seen: `2026-10-0${i + 1}T00:00:00Z` })) });

test('worktreeBase uses the ticket branch when it exists locally, else HEAD with an honest label', async () => {
  const repo = makeRepo();
  git(repo.dir, 'branch', 'feat/x');
  fs.writeFileSync(path.join(repo.dir, 'x.txt'), 'x');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'on main');
  const onBranch = await worktreeBase(ticketOn('feat/x'), { canonical_path: repo.dir });
  assert.equal(onBranch.ref, git(repo.dir, 'rev-parse', 'feat/x'));
  assert.match(onBranch.label, /checkout based on branch feat\/x/);
  const missing = await worktreeBase(ticketOn('feat/gone'), { canonical_path: repo.dir });
  assert.equal(missing.ref, 'HEAD');
  assert.match(missing.label, /on HEAD; ticket branch unknown/);
  assert.equal((await worktreeBase({ branches: [] }, { canonical_path: repo.dir })).ref, 'HEAD');
  assert.equal((await worktreeBase(ticketOn('--upload-pack=evil'), { canonical_path: repo.dir })).ref, 'HEAD', 'an unsafe branch name is never passed to git');
});

test('worktreeBase fetches the branch from origin when it is not local', async () => {
  const origin = makeRepo();
  git(origin.dir, 'branch', 'feat/remote');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'st-clone-'));
  git(parent, 'clone', '-q', origin.dir, 'c');
  const dir = path.join(parent, 'c');
  git(origin.dir, 'checkout', '-q', 'feat/remote');
  fs.writeFileSync(path.join(origin.dir, 'r.txt'), 'r');
  git(origin.dir, 'add', '.');
  git(origin.dir, 'commit', '-q', '-m', 'remote work');
  const base = await worktreeBase(ticketOn('feat/remote'), { canonical_path: dir });
  assert.equal(base.ref, git(origin.dir, 'rev-parse', 'feat/remote'), 'the fetched tip, not the stale clone state');
  assert.match(base.label, /feat\/remote/);
});

test('pruneWorktrees drops registrations whose directory is gone', async () => {
  const repo = makeRepo();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-wt-')), 'wt');
  await createWorktree({ repoPath: repo.dir, baseCommit: repo.head, dir });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(git(repo.dir, 'worktree', 'list'), /st-wt-/);
  await pruneWorktrees(repo.dir);
  assert.doesNotMatch(git(repo.dir, 'worktree', 'list'), /st-wt-/);
});

test('the worker hands the configured claude_path to the handoff extension', async () => {
  assert.deepEqual(extensionOptions('../../handoff/extension.js', { config: { claude_path: 'C:/tools/claude.cmd' } }), { claudePath: 'C:/tools/claude.cmd' });
  assert.deepEqual(extensionOptions('../../handoff/extension.js', { config: {} }), {}, 'unset keeps the extension default');
  assert.equal(extensionOptions('../../server/extension.js', { config: { claude_path: 'x' } }), undefined);
  const seen = [];
  const fake = { use: (e) => seen.push(e.name) };
  await attachExtensions(fake, { config: { claude_path: 'claude', repos: {} }, env: { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-h-')) }, storeMeta: {} }, { only: ['../../handoff/extension.js'] });
  assert.deepEqual(seen, ['handoff']);
});

test('a failed removeWorktree never deregisters the owner\'s own missing worktrees', async () => {
  const repo = makeRepo();
  const ownerWt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-owner-')), 'wt');
  await createWorktree({ repoPath: repo.dir, baseCommit: repo.head, dir: ownerWt });
  fs.rmSync(ownerWt, { recursive: true, force: true }); // the owner's drive is unplugged
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-root-'));
  const plain = path.join(root, 'not-a-worktree');
  fs.mkdirSync(plain);
  await removeWorktree({ repoPath: repo.dir, dir: plain });
  assert.equal(fs.existsSync(plain), false, 'the fallback still deletes the directory');
  assert.ok(git(repo.dir, 'worktree', 'list').includes(path.basename(path.dirname(ownerWt))), 'the owner registration survives');
});

// ---- Ticket worktrees (ADR 0036)
import { createBranchWorktree, copyIgnoredFiles, removeCleanWorktree } from '../../src/handoff/worktree.js';

function ticketRepo() {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, '.gitignore'), '.env\n.env.local\nsecrets/\n');
  git(repo.dir, 'add', '.gitignore');
  git(repo.dir, 'commit', '-q', '-m', 'ignore env');
  fs.writeFileSync(path.join(repo.dir, '.env'), 'TOKEN=local\n');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-qh-')), 'worktrees');
  return { ...repo, head: git(repo.dir, 'rev-parse', 'HEAD'), root, dir: repo.dir, wt: path.join(root, 'demo', 'FEAT-1') };
}

test('createBranchWorktree checks out quill/<KEY> from the base, reuses an existing branch and refuses unsafe ones', async () => {
  const r = ticketRepo();
  const made = await createBranchWorktree({ repoPath: r.dir, dir: r.wt, branch: 'quill/FEAT-1', base: 'HEAD', repo: { default_branch: 'main' } });
  assert.deepEqual([made.branch, made.base_sha, made.created_branch], ['quill/FEAT-1', r.head, true]);
  assert.equal(git(r.wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'quill/FEAT-1');
  assert.equal(git(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the repository checkout stays on its branch');
  await assert.rejects(() => createBranchWorktree({ repoPath: r.dir, dir: r.wt, branch: 'quill/FEAT-1' }), (e) => e.code === 'worktree-exists');
  // The branch outlives its worktree; mounting again checks it out as it is.
  fs.writeFileSync(path.join(r.wt, 'work.txt'), 'w');
  git(r.wt, 'add', '.');
  git(r.wt, 'commit', '-q', '-m', 'ticket work');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  git(r.dir, 'worktree', 'remove', r.wt);
  const again = await createBranchWorktree({ repoPath: r.dir, dir: r.wt, branch: 'quill/FEAT-1', base: r.head });
  assert.deepEqual([again.base_sha, again.created_branch], [tip, false]);
  for (const branch of ['main', 'release/1.0', 'develop', '--upload-pack=x', 'quill/a..b', 'quill/x.lock', 'quill/x.']) {
    await assert.rejects(() => createBranchWorktree({ repoPath: r.dir, dir: path.join(r.root, 'x', 'y'), branch, repo: { default_branch: 'main' } }), (e) => ['branch-protected', 'branch-invalid'].includes(e.code), branch);
  }
  assert.equal(fs.existsSync(path.join(r.root, 'x')), false, 'nothing is created for a refused branch');
});

test('copyIgnoredFiles copies only ignored regular files inside the repository, never links or overwrites', async () => {
  const r = ticketRepo();
  await createBranchWorktree({ repoPath: r.dir, dir: r.wt, branch: 'quill/FEAT-1' });
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'dev.key'), 'k');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-out-')), 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(r.dir, '.env.local')); linked = true; } catch { /* no symlink privilege on this machine */ }
  const res = await copyIgnoredFiles({ repoPath: r.dir, dir: r.wt, entries: ['.env', '.env.local', 'secrets/dev.key', 'README.md', '../x', outside, 'C:\\x\\.env', '/etc/passwd', '.git/config', 'missing.env', 'secrets'] });
  assert.deepEqual(res.copied, ['.env', 'secrets/dev.key']);
  assert.equal(fs.readFileSync(path.join(r.wt, '.env'), 'utf8'), 'TOKEN=local\n');
  assert.equal(fs.lstatSync(path.join(r.wt, '.env')).isSymbolicLink(), false, 'a copy, not a link');
  const reason = (p) => res.skipped.find((s) => s.path === p)?.reason;
  assert.equal(reason('README.md'), 'not-ignored', 'a tracked file is never copied');
  for (const p of ['../x', '.git/config', '/etc/passwd']) assert.equal(reason(p), 'invalid-path', p);
  assert.equal(res.skipped.filter((s) => s.reason === 'invalid-path').length, 5, 'absolute paths in any spelling are refused');
  assert.equal(reason('missing.env'), 'missing');
  assert.equal(reason('secrets'), 'not-a-file');
  if (linked) assert.equal(reason('.env.local'), 'not-a-file', 'a symlink is never followed');
  assert.equal(fs.existsSync(path.join(r.wt, '.env.local')), false);
  // A second copy never overwrites what the worktree already has.
  fs.writeFileSync(path.join(r.wt, '.env'), 'EDITED\n');
  const again = await copyIgnoredFiles({ repoPath: r.dir, dir: r.wt, entries: ['.env'] });
  assert.deepEqual([again.copied, again.skipped[0].reason], [[], 'exists']);
  assert.equal(fs.readFileSync(path.join(r.wt, '.env'), 'utf8'), 'EDITED\n');
});

test('removeCleanWorktree removes only a clean registered worktree under the root, without --force, and keeps the branch', async () => {
  assert.equal(removeCleanWorktree.toString().includes('--force'), false);
  const r = ticketRepo();
  await createBranchWorktree({ repoPath: r.dir, dir: r.wt, branch: 'quill/FEAT-1' });
  await copyIgnoredFiles({ repoPath: r.dir, dir: r.wt, entries: ['.env'] });
  // Untracked work and edits to tracked files are both uncommitted work.
  fs.writeFileSync(path.join(r.wt, 'notes.txt'), 'draft');
  assert.deepEqual(await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root }), { removed: false, reason: 'uncommitted-changes' });
  assert.equal(fs.readFileSync(path.join(r.wt, 'notes.txt'), 'utf8'), 'draft');
  fs.rmSync(path.join(r.wt, 'notes.txt'));
  fs.writeFileSync(path.join(r.wt, 'src.js'), 'export const a = 9;\n');
  assert.equal((await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root })).reason, 'uncommitted-changes');
  git(r.wt, 'checkout', '--', 'src.js');
  // Outside the root, or a plain folder inside it: never touched.
  assert.equal((await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: path.join(r.root, 'other') })).reason, 'outside-worktrees-root');
  const plain = path.join(r.root, 'demo', 'PLAIN-1');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'keep.txt'), 'k');
  assert.equal((await removeCleanWorktree({ repoPath: r.dir, dir: plain, root: r.root })).reason, 'not-a-worktree');
  assert.equal(fs.existsSync(path.join(plain, 'keep.txt')), true);
  // Clean apart from the ignored .env copy: removed; the branch and its commits stay.
  assert.deepEqual(await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root }), { removed: true });
  assert.equal(fs.existsSync(r.wt), false);
  assert.equal(git(r.dir, 'rev-parse', '--verify', 'refs/heads/quill/FEAT-1'), r.head);
  assert.deepEqual(await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root }), { removed: true, missing: true });
});

test('removeCleanWorktree keeps a worktree whose detached HEAD has commits no branch contains', async () => {
  const r = ticketRepo();
  await createBranchWorktree({ repoPath: r.dir, dir: r.wt, branch: 'quill/FEAT-1' });
  git(r.wt, 'checkout', '-q', '--detach');
  fs.writeFileSync(path.join(r.wt, 'lost.txt'), 'l');
  git(r.wt, 'add', '.');
  git(r.wt, 'commit', '-q', '-m', 'detached work');
  assert.deepEqual(await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root }), { removed: false, reason: 'detached-head' });
  git(r.wt, 'branch', 'keep-it');
  assert.deepEqual(await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root }), { removed: true });
});

test('removeCleanWorktree keeps a worktree whose copied ignored file differs from the repository\'s; a tracked one never counts', async () => {
  const r = ticketRepo();
  await createBranchWorktree({ repoPath: r.dir, dir: r.wt, branch: 'quill/FEAT-1' });
  await copyIgnoredFiles({ repoPath: r.dir, dir: r.wt, entries: ['.env'] });
  const copy = ['.env', '.env.local', 'README.md', '../escape'];
  fs.writeFileSync(path.join(r.wt, '.env'), 'TOKEN=changed\n');
  assert.deepEqual(await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root, copy }), { removed: false, reason: 'ignored-files-changed' });
  assert.equal(fs.readFileSync(path.join(r.wt, '.env'), 'utf8'), 'TOKEN=changed\n');
  // An ignored file the worktree has and the repository lacks would be lost too.
  fs.writeFileSync(path.join(r.wt, '.env'), 'TOKEN=local\n');
  fs.writeFileSync(path.join(r.wt, '.env.local'), 'only here\n');
  assert.equal((await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root, copy })).reason, 'ignored-files-changed');
  fs.rmSync(path.join(r.wt, '.env.local'));
  // README.md is tracked: git status covers it, and it differs from nothing ignored.
  assert.deepEqual(await removeCleanWorktree({ repoPath: r.dir, dir: r.wt, root: r.root, copy }), { removed: true });
});
