// branchNameOk follows `git check-ref-format --branch` and is never wider than git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { branchNameOk } from '../../src/lib/git-ref.js';

const gitAccepts = (name) => { try { execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };

test('branch names git accepts, and the ones it refuses', () => {
  const ok = ['main', 'fix/#123', 'quill/pmo-7', 'feature/a.b', 'user@host', 'a+b', 'déjà-vu', 'x/y/z', 'v1.2'];
  const bad = ['', '-x', 'HEAD', '@', 'a..b', 'a/', '/a', 'a//b', 'a.', '.a', 'a/.b', 'a.lock', 'a/b.lock/c', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a@{1}', 'a\u0001', 'a‮b', 'x'.repeat(256)];
  for (const n of ok) assert.equal(branchNameOk(n), true, n);
  for (const n of bad) assert.equal(branchNameOk(n), false, JSON.stringify(n));
  // Never wider than git: every name accepted here git accepts too.
  for (const n of [...ok, ...bad]) if (branchNameOk(n)) assert.equal(gitAccepts(n), true, n);
  for (const n of ['a..b', 'a.lock', 'a~1', 'a:b', 'a@{1}', '-x']) assert.equal(gitAccepts(n), false, n);
  assert.equal(branchNameOk(null), false);
});
