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
