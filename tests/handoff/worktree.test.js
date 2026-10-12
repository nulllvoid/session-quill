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
