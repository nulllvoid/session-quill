// Registering from a linked worktree registers the repository itself, and an id from a parent
// folder's .quill.toml never takes over a repository registered elsewhere (0.7.0 regression).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli, seedSpawnConfig, stopSpawnedWorker } from './helpers.js';
import { loadUserConfig } from '../../src/config/config.js';
import { mainWorkTree, samePath } from '../../src/config/repos.js';
import { mainWorkTreeOf } from '../../src/lib/git-head.js';
import { scopeFor } from '../../src/hooks/scope.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });

// A repository with one commit and two linked worktrees: one inside it (as Claude Code makes them,
// under .claude/worktrees) and one beside it.
function repoWithWorktrees() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-wt-')));
  const repo = path.join(root, 'app');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init');
  const inside = path.join(repo, '.claude', 'worktrees', 'feature');
  const beside = path.join(root, 'app-feature-2');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', inside);
  git(repo, 'worktree', 'add', '-q', '-b', 'feature-2', beside);
  const env = { QUILL_HOME: path.join(root, 'home') };
  seedSpawnConfig(env);
  return { root, repo, inside, beside, env };
}

test('a linked worktree resolves to its repository, with and without git', () => {
  const fx = repoWithWorktrees();
  for (const dir of [fx.repo, fx.inside, fx.beside, path.join(fx.inside, 'sub')]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    assert.ok(samePath(mainWorkTree(dir), fx.repo), `${dir} → repository`);
  }
  assert.equal(mainWorkTreeOf(fx.repo), null, 'the main working tree is not a linked worktree');
  assert.ok(samePath(mainWorkTreeOf(fx.beside), fx.repo));
  assert.ok(samePath(mainWorkTreeOf(fx.inside), fx.repo));
});

test('start from a worktree registers the repository, and keeps an existing registration', async (t) => {
  const fx = repoWithWorktrees(); t.after(() => stopSpawnedWorker(fx.env));
  const first = await cli(['start', '--repo', fx.inside], fx.env);
  assert.equal(first.code, 0, first.err);
  const repos = Object.values(loadUserConfig(fx.env).repos);
  assert.equal(repos.length, 1);
  assert.ok(samePath(repos[0].canonical_path, fx.repo), 'registered at the repository, not the worktree');
  assert.equal(repos[0].display_name, 'app');
  const again = await cli(['start', '--repo', fx.beside], fx.env);
  assert.equal(again.code, 0, again.err);
  const after = Object.values(loadUserConfig(fx.env).repos);
  assert.equal(after.length, 1);
  assert.ok(samePath(after[0].canonical_path, fx.repo));
});

test('an id from a parent .quill.toml does not take over a repository registered elsewhere', async (t) => {
  const fx = repoWithWorktrees(); t.after(() => stopSpawnedWorker(fx.env));
  assert.equal((await cli(['start', '--repo', fx.repo], fx.env)).code, 0);
  const [id] = Object.keys(loadUserConfig(fx.env).repos);
  fs.writeFileSync(path.join(fx.repo, '.quill.toml'), `repo_id = "${id}"\nproject_id = "app"\n`);
  // A separate clone nested in the first repository's folder: its walk up finds that .quill.toml.
  const nested = path.join(fx.repo, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q', '-b', 'main');
  const r = await cli(['start', '--repo', nested], fx.env);
  assert.equal(r.code, 0, r.err);
  const repos = loadUserConfig(fx.env).repos;
  assert.ok(samePath(repos[id].canonical_path, fx.repo), 'the first registration is untouched');
  assert.ok(Object.values(repos).some((x) => samePath(x.canonical_path, nested)), 'the nested clone gets its own entry');
});

test('repo add on a worktree registers the repository and says so', async (t) => {
  const fx = repoWithWorktrees(); t.after(() => stopSpawnedWorker(fx.env));
  assert.equal((await cli(['init', '--repo', fx.repo, '--store', path.join(fx.root, 'store'), '--project', 'app', '--project-name', 'App', '--yes'], fx.env)).code, 0);
  const r = await cli(['repo', 'add', fx.beside, '--id', 'app2'], fx.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /is a worktree of .*registering the repository itself/);
});

test('hooks attribute work in a worktree outside the repository folder to the repository', () => {
  const fx = repoWithWorktrees();
  const identity = { gate_mode: 'nudge', repos: [{ repo_id: 'app', path: fx.repo, project_id: 'app', gate_mode: 'strict' }] };
  assert.equal(scopeFor(identity, fx.beside).repo_id, 'app');
  assert.equal(scopeFor(identity, fx.beside).gate_mode, 'strict');
  assert.equal(scopeFor(identity, fx.inside).repo_id, 'app');
  assert.equal(scopeFor(identity, fx.root).repo_id, null);
});
