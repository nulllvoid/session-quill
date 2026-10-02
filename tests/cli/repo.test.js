import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeHome, startWorker, cli } from './helpers.js';
import { loadUserConfig } from '../../src/config/config.js';

function gitRepo(name, { branch = 'main', originHead = null } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-')), name);
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', branch);
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (originHead) {
    git('update-ref', `refs/remotes/origin/${originHead}`, 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${originHead}`);
  }
  return dir;
}

test('issue #5: repo add registers a git work tree with an id from the folder and the detected default branch, without .quill.toml', async () => {
  const fx = makeHome();
  const dir = gitRepo('payments-api', { branch: 'feature', originHead: 'develop' });
  const r = await cli(['repo', 'add', dir], fx.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /payments-api/);
  const repo = loadUserConfig(fx.env).repos['payments-api'];
  assert.equal(repo.canonical_path, path.resolve(dir));
  assert.equal(repo.default_branch, 'develop');
  assert.equal(repo.project_id, 'demo');
  assert.equal(fs.existsSync(path.join(dir, '.quill.toml')), false, 'no repository file unless asked');
  const master = gitRepo('legacy', { branch: 'master' });
  assert.equal((await cli(['repo', 'add', master, '--id', 'old-app', '--repo-file'], fx.env)).code, 0);
  const cfg = loadUserConfig(fx.env);
  assert.equal(cfg.repos['old-app'].default_branch, 'master');
  assert.equal(fs.existsSync(path.join(master, '.quill.toml')), true);
  assert.equal(cfg.repos.demo.project_id, 'demo', 'the existing repository is kept');
});

test('issue #5: repo add refuses non-git folders, unknown projects and an id taken by another path', async () => {
  const fx = makeHome();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plain-'));
  const notGit = await cli(['repo', 'add', plain], fx.env);
  assert.notEqual(notGit.code, 0);
  assert.match(notGit.err, /not a git work tree/);
  const missing = await cli(['repo', 'add', path.join(plain, 'nope')], fx.env);
  assert.match(missing.err, /does not exist/);
  const dir = gitRepo('web');
  const proj = await cli(['repo', 'add', dir, '--project', 'ghost'], fx.env);
  assert.match(proj.err, /unknown project ghost/);
  assert.equal((await cli(['repo', 'add', dir], fx.env)).code, 0);
  assert.equal((await cli(['repo', 'add', dir], fx.env)).code, 0, 'adding the same path again is idempotent');
  const other = gitRepo('web');
  const taken = await cli(['repo', 'add', other], fx.env);
  assert.notEqual(taken.code, 0);
  assert.match(taken.err, /already registered/);
  assert.match(taken.err, /--id/);
});

test('issue #5: repo list shows registered repositories and flags missing paths; repo remove unregisters', async () => {
  const fx = makeHome();
  const dir = gitRepo('svc');
  await cli(['repo', 'add', dir], fx.env);
  const list = await cli(['repo', 'list'], fx.env);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /svc/);
  assert.match(list.out, /demo/);
  const json = JSON.parse((await cli(['repo', 'list', '--json'], fx.env)).out);
  assert.equal(json.find((r) => r.id === 'svc').status, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
  const gone = JSON.parse((await cli(['repo', 'list', '--json'], fx.env)).out);
  assert.equal(gone.find((r) => r.id === 'svc').status, 'missing');
  const rm = await cli(['repo', 'remove', 'svc'], fx.env);
  assert.equal(rm.code, 0, rm.err);
  assert.equal(loadUserConfig(fx.env).repos.svc, undefined);
  const unknown = await cli(['repo', 'remove', 'svc'], fx.env);
  assert.match(unknown.err, /unknown repository svc/);
});

test('issue #5: removing a project\'s repository clears projects.<id>.repo_id', async () => {
  const fx = makeHome();
  const rm = await cli(['repo', 'remove', 'demo'], fx.env);
  assert.equal(rm.code, 0, rm.err);
  const cfg = loadUserConfig(fx.env);
  assert.equal(cfg.repos.demo, undefined);
  assert.equal(cfg.projects.demo.repo_id ?? null, null);
});

test('issue #5: a running worker picks up added and removed repositories', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const dir = gitRepo('late');
    await cli(['repo', 'add', dir], fx.env);
    await cli(['repo', 'remove', 'demo'], fx.env);
    w.worker.lastIdentityCheckMs = -Infinity;
    w.worker.refreshIdentity();
    assert.ok(w.worker.state.meta.repos.late, 'added repository reaches the worker');
    assert.equal(w.worker.state.meta.repos.demo, undefined, 'removed repository leaves the worker');
  } finally {
    await w.stop();
  }
});

test('issue #5: doctor flags registered repositories whose path is gone or not a git work tree', async () => {
  const fx = makeHome();
  const dir = gitRepo('flaky');
  await cli(['repo', 'add', dir], fx.env);
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  const r = await cli(['doctor'], fx.env);
  assert.match(r.out, /repo flaky: .*not a git work tree/);
});

test('issue #5: init refuses a folder that is not a git work tree unless --force', async () => {
  const fx = makeHome();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'st-home-'));
  const base = ['init', '--yes', '--no-worker', '--store', fx.storePath, '--project', 'demo', '--repo', plain];
  const refused = await cli(base, fx.env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /not a git work tree/);
  assert.match(refused.err, /--force/);
  const forced = await cli([...base, '--force'], fx.env);
  assert.match(forced.out, /not a git work tree/);
  assert.ok(loadUserConfig(fx.env).repos.demo.canonical_path === path.resolve(plain));
});

test('issue #5: init gives a second repository of a project its own id instead of overwriting the first', async () => {
  const fx = makeHome();
  const first = gitRepo('alpha', { branch: 'trunk' });
  const second = gitRepo('beta');
  const base = ['init', '--yes', '--no-worker', '--store', fx.storePath, '--project', 'shop', '--project-name', 'Shop'];
  const a = await cli([...base, '--repo', first], fx.env);
  assert.doesNotMatch(a.err, /not a git work tree/, a.err);
  const b = await cli([...base, '--repo', second], fx.env);
  assert.doesNotMatch(b.err, /not a git work tree/, b.err);
  const cfg = loadUserConfig(fx.env);
  assert.equal(cfg.repos.shop.canonical_path, path.resolve(first));
  assert.equal(cfg.repos.shop.default_branch, 'trunk', 'default branch is detected');
  assert.equal(cfg.repos.beta.canonical_path, path.resolve(second));
});
