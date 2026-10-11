import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planClone, executeClone, cloneArgs } from '../../src/onboard/clone.js';
import { clone as cloneCommand } from '../../src/cli/commands/repo.js';
import { loadUserConfig, saveUserConfig } from '../../src/config/config.js';
import { createExtension as onboardExt } from '../../src/onboard/extension.js';
import { makeHome, startWorker, cli, DESC } from '../cli/helpers.js';
import { scenario, until, RID } from '../acceptance/scenario.js';

const sh = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
function gitRepo(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q');
  if (origin) sh(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

// Stands in for `git clone`: never touches the network, just makes a repository whose origin is
// the remote it was asked for.
function fakeGit({ fail = false } = {}) {
  const calls = [];
  const git = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const i = args.indexOf('--');
    const [url, target] = args.slice(i + 1);
    if (fail) { fs.mkdirSync(path.join(target, '.git'), { recursive: true }); return { code: 128, stdout: '', stderr: 'fatal: repository not found' }; }
    gitRepo(target, url);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, git };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-clone-'));
const config = (dir, extra = {}) => ({ projects: { demo: { name: 'Demo' } }, default_project: 'demo', repos: {}, tracker: { auto_clone_dir: dir, ...extra } });
const needsClone = (remote, extra = {}) => ({ id: 't1', key: 'PROJ-1', project_id: 'demo', repo_id: null, tags: [], repo_resolution: { state: 'needs-clone', remote }, ...extra });

test('a clone plan names the remote, the allowed host and a folder directly inside auto_clone_dir', () => {
  const dir = tmp();
  const plan = planClone({ config: config(dir), ticket: needsClone('git@github.com:acme/api.git') });
  assert.deepEqual([plan.action, plan.host, plan.protocol, plan.path], ['clone', 'github.com', 'ssh', path.join(dir, 'api')]);
  fs.mkdirSync(path.join(dir, 'api'));
  assert.equal(planClone({ config: config(dir), ticket: needsClone('git@github.com:acme/api.git') }).path, path.join(dir, 'acme-api'), 'an unrelated folder of that name is never reused');
  fs.mkdirSync(path.join(dir, 'acme-api'));
  assert.throws(() => planClone({ config: config(dir), ticket: needsClone('git@github.com:acme/api.git') }), (e) => e.code === 'clone-target-exists');
});

test('a clone is refused for linked or no-code tickets, unknown remotes, other hosts and credentials', () => {
  const dir = tmp();
  const refused = (ticket, code, extra = {}) => assert.throws(() => planClone({ config: config(dir, extra), ticket }), (e) => e.code === code, code);
  refused(needsClone('https://github.com/acme/api', { repo_id: 'demo' }), 'repo-linked');
  refused(needsClone('https://github.com/acme/api', { tags: ['quill/no-code'] }), 'no-code');
  refused(needsClone(null, { repo_resolution: null }), 'remote-unknown');
  refused(needsClone('https://git.evil.example/acme/api.git'), 'clone-host-refused');
  refused(needsClone('https://gitlab.com/acme/api.git'), 'clone-host-refused', { clone_hosts: ['github.com'] });
  refused(needsClone('https://me:token@github.com/acme/api.git'), 'clone-credentials');
  refused(needsClone('ext::sh -c x'), 'clone-url-invalid');
  refused(needsClone('file:///srv/repo.git'), 'clone-transport-refused');
  assert.equal(fs.readdirSync(dir).length, 0, 'nothing was created');
});

test('a remote that already has a clone is linked or registered, never cloned again', () => {
  const dir = tmp();
  const registered = gitRepo(path.join(tmp(), 'api'), 'https://github.com/acme/api.git');
  const cfg = { ...config(dir), repos: { api: { project_id: 'demo', canonical_path: registered } } };
  assert.deepEqual([planClone({ config: cfg, ticket: needsClone('git@github.com:Acme/API.git') }).action, planClone({ config: cfg, ticket: needsClone('git@github.com:Acme/API.git') }).repo_id], ['link', 'api']);
  const onDisk = gitRepo(path.join(dir, 'web'), 'git@github.com:acme/web.git');
  const plan = planClone({ config: config(dir), ticket: needsClone('https://github.com/acme/web') });
  assert.deepEqual([plan.action, path.resolve(plan.path)], ['register', path.resolve(onDisk)]);
});

test('git clone gets -- before the remote, no file or ext transport and no submodules, and a failed clone leaves nothing behind', async () => {
  assert.deepEqual(cloneArgs('git@github.com:acme/api.git', '/x/.api.partial'), ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', 'clone', '--no-recurse-submodules', '--', 'git@github.com:acme/api.git', '/x/.api.partial']);
  const dir = path.join(tmp(), 'clones');
  const plan = planClone({ config: config(dir), ticket: needsClone('https://github.com/acme/api.git') });
  const failing = fakeGit({ fail: true });
  await assert.rejects(executeClone(plan, { git: failing.git }), (e) => e.code === 'clone-failed' && /repository not found/.test(e.message));
  assert.deepEqual(fs.readdirSync(dir), [], 'the partial clone is removed');
  const ok = fakeGit();
  assert.equal(await executeClone(plan, { git: ok.git }), path.join(dir, 'api'));
  assert.ok(fs.existsSync(path.join(dir, 'api', '.git')));
  assert.deepEqual(fs.readdirSync(dir), ['api']);
  assert.match(path.basename(ok.calls[0].args.at(-1)), /^\.api\.partial-/, 'cloned under a hidden name, then renamed');
});

test('quill repo clone previews, then with --confirm clones, registers and links; a second ticket on that remote reuses the clone', async () => {
  const fx = makeHome();
  const clones = path.join(fx.home, 'clones');
  fx.config.tracker = { auto_clone_dir: clones };
  saveUserConfig(fx.config, fx.env);
  const w = await startWorker(fx);
  try {
    const keyOf = (out) => /((?:DEV|FEAT|FIX|RES)-[0-9]+)/.exec(out)[1];
    const k1 = keyOf((await cli(['ticket', 'create', '--description', DESC, 'Fix the API', '--session', 's1'], fx.env)).out);
    await cli(['ticket', 'set', k1, '--repo', 'none'], fx.env);
    const git = fakeGit();
    let out = '';
    const io = { println: (s = '') => { out += `${s}\n`; }, json: (o) => { out += JSON.stringify(o); } };
    assert.equal(await cloneCommand(io, [k1], { url: 'git@github.com:acme/api.git' }, fx.env, { git: git.git }), 0);
    assert.match(out, /Preview: nothing has been cloned\.\n {2}remote {3}git@github.com:acme\/api.git\n {2}host {5}github.com \(allowed by \[tracker\] clone_hosts\)/);
    assert.equal(git.calls.length, 0);
    assert.equal(fs.existsSync(clones), false);
    out = '';
    assert.equal(await cloneCommand(io, [k1], { url: 'git@github.com:acme/api.git', confirm: true }, fx.env, { git: git.git }), 0);
    assert.equal(git.calls.length, 1);
    assert.match(out, /Registered repository api → .*api\nLinked .* to api\./);
    const cfg = loadUserConfig(fx.env);
    assert.equal(path.resolve(cfg.repos.api.canonical_path), path.resolve(clones, 'api'));
    const ticket = (k) => JSON.parse(fs.readFileSync(path.join(fx.home, 'projections', 'tickets', `${[...w.worker.state.tickets.values()].find((t) => t.key === k).id}.json`), 'utf8'));
    await until(() => ticket(k1).repo_id === 'api');

    const k2 = keyOf((await cli(['ticket', 'create', '--description', DESC, 'More API work', '--session', 's2'], fx.env)).out);
    await cli(['ticket', 'set', k2, '--repo', 'none'], fx.env);
    out = '';
    await cloneCommand(io, [k2], { url: 'https://github.com/acme/api', confirm: true }, fx.env, { git: git.git });
    assert.equal(git.calls.length, 1, 'the remote is never cloned twice');
    assert.match(out, /Linked .* to api\./);
    await assert.rejects(cloneCommand(io, [k2], { url: 'https://evil.example/acme/x.git', confirm: true }, fx.env, { git: git.git }), (e) => e.code === 'repo-linked');
  } finally { await w.stop(); }
});

test('the dashboard repo-clone request shows Cloning, then links the ticket; a disallowed host is refused when submitted', async () => {
  const s = scenario({ withServer: true });
  s.config.tracker = { auto_clone_dir: path.join(s.home, 'clones') };
  const git = fakeGit();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowGit = async (args, opts) => { await gate; return git.git(args, opts); };
  await s.start();
  s.w.use(onboardExt(s.ctx, { git: slowGit }));
  try {
    const T = 'dddddddd-0000-4000-8000-000000000001';
    s.ingest('ticket-create', { ticket: { id: T, key: 'PROJ-7', title: 'API', project_id: 'demo', category: 'feature', priority: 'P2', repo_id: null } });
    s.w.tick();
    s.w.emit('tracker-sync', { system: 'jira', synced_at: s.iso(), results: [], resolutions: [{ ticket_id: T, state: 'needs-clone', remote: 'git@github.com:acme/api.git', rule: 'repo_map', via: 'PROJ' }] });
    assert.equal(s.w.getSnapshot().tickets.find((t) => t.id === T).repo_state, 'needs-clone');
    const c = await s.client();
    const refused = await c.post('/v1/requests', { id: RID(901), kind: 'repo-clone', target_id: T, payload: { url: 'https://evil.example/acme/api.git' } });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'clone-host-refused');
    const res = await c.post('/v1/requests', { id: RID(902), kind: 'repo-clone', target_id: T, payload: { url: 'git@github.com:acme/api.git' } });
    assert.equal(res.status, 202);
    s.w.tick();
    s.w.publishGeneration();
    assert.equal(s.w.getSnapshot().tickets.find((t) => t.id === T).repo_state, 'cloning');
    release();
    await until(async () => { s.w.tick(); return s.w.state.requests.get(RID(902)).state === 'applied'; });
    const t = s.w.state.tickets.get(T);
    assert.equal(t.repo_id, 'api');
    assert.equal(s.w.config.repos.api.display_name, 'api', 'the worker reads the new repository at once');
    assert.equal(git.calls.length, 1);
    assert.equal(s.w.state.handoffs.size, 0, 'cloning never runs an agent');
  } finally { await s.stop(); }
});
