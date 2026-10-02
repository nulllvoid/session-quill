import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { currentBranch } from '../../src/lib/git-head.js';

test('currentBranch reads HEAD from the nearest .git directory or worktree file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-head-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/PMLA-12-retry\n');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(currentBranch(path.join(repo, 'src', 'deep')), 'feat/PMLA-12-retry');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wt-'));
  const gitdir = path.join(repo, '.git', 'worktrees', 'wt');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/fix/PC-3\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  assert.equal(currentBranch(wt), 'fix/PC-3');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n');
  assert.equal(currentBranch(repo), null, 'detached HEAD has no branch');
  assert.equal(currentBranch(undefined), null);
});
