// Ticket worktrees from the CLI (ADR 0036, FR-1.1): `ticket work|bind --worktree`, `[worktree] auto`,
// `quill worktree list|remove`, and attribution of a session working inside one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHome, startWorker, cli, DESC } from './helpers.js';
import { makeRepo, git, sleep } from '../handoff/helpers.js';
import { saveUserConfig, loadRepoConfig, worktreeConfig } from '../../src/config/config.js';
import { scopeFor } from '../../src/hooks/scope.js';
import { currentBranch } from '../../src/lib/git-head.js';

function setup({ worktree } = {}) {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, '.gitignore'), '.env\n');
  git(repo.dir, 'add', '.gitignore');
  git(repo.dir, 'commit', '-q', '-m', 'ignore env');
  fs.writeFileSync(path.join(repo.dir, '.env'), 'API_URL=http://localhost\n');
  const fx = makeHome();
  fx.config.repos.demo.canonical_path = repo.dir;
  if (worktree) fx.config.worktree = worktree;
  saveUserConfig(fx.config, fx.env);
  return { fx, repo };
}

// Polls an async condition (the snapshot the CLI reads is published a moment after the ack).
async function until(fn, { timeoutMs = 5000 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(25);
  }
}

const listed = async (fx, extra = []) => JSON.parse((await cli(['worktree', 'list', '--json', ...extra], fx.env)).out);

test('ticket work --worktree mounts quill/<KEY> outside the repository, copies ignored env files and says where to switch', async () => {
  const { fx, repo } = setup();
  const w = await startWorker(fx);
  try {
    const r = await cli(['ticket', 'work', 'Fix login', '--description', DESC, '--category', 'bugfix', '--worktree', '--session', 'one'], fx.env);
    assert.equal(r.code, 0, r.err);
    const dir = path.join(fx.home, 'worktrees', 'demo', 'FIX-1');
    assert.match(r.out, /Created branch quill\/FIX-1 from the repository's HEAD/);
    assert.ok(r.out.includes(`Worktree path: ${dir}`), r.out);
    assert.ok(r.out.includes(`cd "${dir}"`));
    assert.match(r.out, /Copied ignored files: \.env/);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'API_URL=http://localhost\n');
    assert.equal(currentBranch(dir), 'quill/FIX-1');
    assert.equal(git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the repository checkout is untouched');
    const rows = await until(async () => { const x = await listed(fx); return x.length ? x : null; });
    assert.deepEqual(rows.map((x) => [x.key, x.state, x.branch, x.path, x.disk]), [['FIX-1', 'mounted', 'quill/FIX-1', dir, 'clean']]);
    // Binding another session with --worktree reuses it: no second record.
    const again = await cli(['ticket', 'bind', 'FIX-1', '--worktree', '--session', 'two'], fx.env);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already exists on branch quill\/FIX-1/);
    assert.equal((await listed(fx, ['--all'])).length, 1);
    // A session started inside the worktree is attributed to the repository (no git on the hook path).
    const identity = { gate_mode: 'nudge', repos: [{ path: repo.dir, repo_id: 'demo', project_id: 'demo' }] };
    assert.equal(scopeFor(identity, path.join(dir, 'src')).repo_id, 'demo');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    assert.equal(scopeFor(identity, path.join(dir, 'src')).repo_id, 'demo');
  } finally { await w.stop(); }
});

test('worktree remove refuses uncommitted work, then removes the clean worktree and keeps the branch', async () => {
  const { fx, repo } = setup();
  const w = await startWorker(fx);
  try {
    assert.equal((await cli(['ticket', 'work', 'Add search', '--description', DESC, '--category', 'feature', '--worktree', '--session', 'one'], fx.env)).code, 0);
    const dir = path.join(fx.home, 'worktrees', 'demo', 'FEAT-1');
    await until(async () => (await listed(fx)).length === 1);
    fs.writeFileSync(path.join(dir, 'wip.js'), 'unsaved');
    const refused = await cli(['worktree', 'remove', 'FEAT-1'], fx.env);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /uncommitted changes.*no force option/);
    assert.equal(fs.readFileSync(path.join(dir, 'wip.js'), 'utf8'), 'unsaved');
    assert.equal((await cli(['worktree', 'remove', 'FEAT-1', '--force'], fx.env)).code, 1, 'a --force flag changes nothing');
    assert.ok(fs.existsSync(path.join(dir, 'wip.js')));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'wip');
    const ok = await cli(['worktree', 'remove', 'FEAT-1'], fx.env);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /branch quill\/FEAT-1 kept/);
    assert.equal(fs.existsSync(dir), false);
    assert.ok(git(repo.dir, 'log', '--oneline', 'quill/FEAT-1').includes('wip'), 'the committed work stays on the branch');
    const rows = await until(async () => { const x = await listed(fx, ['--all']); return x.length && x[0].state === 'pruned' ? x : null; });
    assert.equal(rows.length, 1);
    assert.deepEqual(await listed(fx), []);
    // Mounting again checks out the kept branch with its commits.
    const back = await cli(['ticket', 'bind', 'FEAT-1', '--worktree', '--session', 'one'], fx.env);
    assert.equal(back.code, 0, back.err);
    assert.match(back.out, /Checked out the existing branch quill\/FEAT-1/);
    assert.ok(fs.existsSync(path.join(dir, 'wip.js')));
  } finally { await w.stop(); }
});

test('[worktree] auto mounts without the flag, --no-worktree skips it, and a ticket without a repository only says why', async () => {
  const { fx } = setup({ worktree: { auto: true, copy: [] } });
  const w = await startWorker(fx);
  try {
    const skip = await cli(['ticket', 'work', 'Plain', '--description', DESC, '--no-worktree', '--session', 'one'], fx.env);
    assert.equal(skip.code, 0, skip.err);
    assert.doesNotMatch(skip.out, /Worktree path/);
    const auto = await cli(['ticket', 'work', 'Auto', '--description', DESC, '--category', 'feature', '--session', 'one'], fx.env);
    assert.equal(auto.code, 0, auto.err);
    assert.match(auto.out, /Worktree path: .*FEAT-1/);
    assert.equal(fs.existsSync(path.join(fx.home, 'worktrees', 'demo', 'FEAT-1', '.env')), false, 'copy = [] copies nothing');
    assert.equal((await cli(['ticket', 'set', 'FEAT-1', '--repo', 'none'], fx.env)).code, 0);
    await until(async () => JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((t) => t.key === 'FEAT-1' && t.repo_id === null));
    const none = await cli(['ticket', 'bind', 'FEAT-1', '--session', 'two'], fx.env);
    assert.equal(none.code, 0, none.err);
    assert.match(none.out, /No worktree for FEAT-1: FEAT-1 has no repository/);
    const explicit = await cli(['ticket', 'bind', 'FEAT-1', '--worktree', '--session', 'two'], fx.env);
    assert.equal(explicit.code, 1);
    assert.match(explicit.err, /bound to FEAT-1, but no worktree was made/);
  } finally { await w.stop(); }
});

test('[worktree] is user-only: a repository .quill.toml cannot set what is copied or when it goes', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, '.quill.toml'), '[worktree]\nauto = true\ncopy = ["../../.ssh/id_rsa"]\nkeep_days = 1\n');
  assert.equal('worktree' in (loadRepoConfig(repo.dir) ?? {}), false);
  assert.deepEqual(worktreeConfig({}), { auto: false, copy: ['.env', '.env.local'], keep_days: 7 });
  assert.deepEqual(worktreeConfig({ worktree: { auto: 'yes', copy: 'x', keep_days: 0 } }), { auto: false, copy: ['.env', '.env.local'], keep_days: 7 });
});

test('inside an agent run ticket worktree commands are refused before anything runs', async () => {
  const { fx } = setup();
  const env = { ...fx.env, QUILL_HANDOFF_ID: 'run-1' };
  for (const argv of [['worktree', 'list'], ['worktree', 'remove', 'FIX-1'], ['ticket', 'work', 'x', '--worktree', '--session', 's'], ['ticket', 'bind', 'FIX-1', '--worktree', '--session', 's']]) {
    const r = await cli(argv, env);
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.equal(fs.existsSync(path.join(fx.home, 'worktrees')), false);
});
