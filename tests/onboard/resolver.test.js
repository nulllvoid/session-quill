import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRepo, createOriginIndex, originUrl, ORIGIN_CONCURRENCY, NO_CODE_TAG } from '../../src/onboard/resolver.js';
import { onboardSettings } from '../../src/onboard/settings.js';
import { track } from './cleanup.js';

const JIRA = { system: 'jira', domain: 'https://example.atlassian.net' };
const settings = (repoMap = {}, extra = {}) => onboardSettings({ repo_map: repoMap, ...extra }, { home: os.tmpdir() });
const ticket = (extra = {}) => ({ key: 'PROJ-1', repo_id: null, tags: [], ...extra });
const hints = (extra = {}) => ({ project: 'PROJ', components: [], github_repo: null, links: [], ...extra });
// An index over fixed remotes: no git, no disk.
const fakeIndex = (registered = {}, clones = {}) => ({ registered: (k) => registered[k] ?? null, clone: (k) => clones[k] ?? null });
const REPOS = { backend: { canonical_path: '/r/backend' }, payments: { canonical_path: '/r/payments' } };

test('repo_map maps a component before its project, to a registered repository id', () => {
  const s = settings({ PROJ: 'backend', 'PROJ/Payments': 'payments' });
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: hints({ components: ['Payments'] }), settings: s, repos: REPOS, index: fakeIndex(), tracker: JIRA }), { state: 'linked', repo_id: 'payments', rule: 'repo_map', via: 'PROJ/Payments' });
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: hints({ components: ['Other'] }), settings: s, repos: REPOS, index: fakeIndex(), tracker: JIRA }), { state: 'linked', repo_id: 'backend', rule: 'repo_map', via: 'PROJ' });
});

test('a mapped remote links the registered clone of it, else asks for a clone, else points at an existing clone', () => {
  const s = settings({ PROJ: 'git@github.com:acme/api.git' });
  const args = { ticket: ticket(), hints: hints(), settings: s, repos: REPOS, tracker: JIRA };
  assert.deepEqual(resolveRepo({ ...args, index: fakeIndex({ 'github.com/acme/api': 'backend' }) }), { state: 'linked', repo_id: 'backend', rule: 'repo_map', via: 'PROJ' });
  assert.deepEqual(resolveRepo({ ...args, index: fakeIndex() }), { state: 'needs-clone', remote: 'git@github.com:acme/api.git', existing_path: null, rule: 'repo_map', via: 'PROJ' });
  assert.deepEqual(resolveRepo({ ...args, index: fakeIndex({}, { 'github.com/acme/api': '/clones/api' }) }), { state: 'needs-clone', remote: 'git@github.com:acme/api.git', existing_path: '/clones/api', rule: 'scan', via: 'PROJ' });
});

test('repository links on the issue match a registered repository by origin, https or ssh alike', () => {
  const h = hints({ links: ['https://example.atlassian.net/wiki/x', 'https://github.com/Acme/API/pull/7'] });
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: h, settings: settings(), repos: REPOS, index: fakeIndex({ 'github.com/acme/api': 'backend' }), tracker: JIRA }), { state: 'linked', repo_id: 'backend', rule: 'issue', via: 'https://github.com/Acme/API/pull/7' });
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: h, settings: settings(), repos: REPOS, index: fakeIndex(), tracker: JIRA }), { state: 'needs-clone', remote: 'https://github.com/Acme/API.git', existing_path: null, rule: 'issue', via: 'https://github.com/Acme/API/pull/7' });
  const elsewhere = hints({ links: ['https://git.internal.example/acme/api/pull/7'] });
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: elsewhere, settings: settings(), repos: REPOS, index: fakeIndex(), tracker: JIRA }), { state: 'none' }, 'links on hosts outside clone_hosts are not repositories');
});

test('a GitHub issue resolves through its own repository; no-code tickets and unmapped issues resolve to nothing', () => {
  const gh = { system: 'github', domain: 'https://github.com', repo: 'acme/web' };
  const h = { project: null, components: [], github_repo: 'acme/web', links: ['https://github.com/acme/web'] };
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: h, settings: settings({ 'acme/web': 'backend' }), repos: REPOS, index: fakeIndex(), tracker: gh }), { state: 'linked', repo_id: 'backend', rule: 'repo_map', via: 'acme/web' });
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: h, settings: settings(), repos: REPOS, index: fakeIndex(), tracker: gh }).remote, 'https://github.com/acme/web.git');
  assert.deepEqual(resolveRepo({ ticket: ticket({ tags: [NO_CODE_TAG] }), hints: h, settings: settings({ 'acme/web': 'backend' }), repos: REPOS, index: fakeIndex(), tracker: gh }), { state: 'no-code' });
  assert.deepEqual(resolveRepo({ ticket: ticket(), hints: hints(), settings: settings({ PROJ: 'not-registered' }), repos: REPOS, index: fakeIndex(), tracker: JIRA }), { state: 'none' });
});

test('the origin index reads origins of registered repositories and of clones in auto_clone_dir', async () => {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'st-resolve-')));
  const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  const mk = (dir, origin) => { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q'); if (origin) git(dir, 'remote', 'add', 'origin', origin); return dir; };
  const registered = mk(path.join(root, 'work', 'backend'), 'git@github.com:acme/backend.git');
  mk(path.join(root, 'work', 'sibling'), 'https://github.com/acme/sibling');
  mk(path.join(root, 'clones', 'api'), 'https://github.com/acme/api.git');
  mk(path.join(root, 'clones', 'no-origin'), null);
  fs.mkdirSync(path.join(root, 'clones', 'plain-folder'));
  const index = await createOriginIndex({ repos: { backend: { canonical_path: registered } }, autoCloneDir: path.join(root, 'clones') });
  assert.equal(index.registered('github.com/acme/backend'), 'backend');
  assert.equal(index.registered('github.com/acme/api'), null);
  assert.equal(path.resolve(index.clone('github.com/acme/api')), path.resolve(root, 'clones', 'api'));
  assert.equal(path.resolve(index.clone('github.com/acme/sibling')), path.resolve(root, 'work', 'sibling'), 'folders beside registered repositories are scanned too');
  assert.equal(index.clone('github.com/acme/none'), null);
});

test('origins are read a few at a time and cached until the folder\'s git config changes', async () => {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'st-origin-')));
  let running = 0;
  let peak = 0;
  const repos = {};
  for (let i = 0; i < 10; i += 1) repos[`r${i}`] = { canonical_path: path.join(root, `r${i}`) };
  const slowOrigin = async (dir) => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running -= 1; return `https://github.com/acme/${path.basename(dir)}.git`; };
  const index = await createOriginIndex({ repos, autoCloneDir: null, originOf: slowOrigin, scan: false });
  assert.equal(index.registered('github.com/acme/r7'), 'r7');
  assert.ok(peak > 1 && peak <= ORIGIN_CONCURRENCY, `peak ${peak}`);

  const dir = path.join(root, 'cached');
  fs.mkdirSync(dir);
  spawnSync('git', ['-C', dir, 'init', '-q'], { windowsHide: true });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/one.git'], { windowsHide: true });
  assert.equal(await originUrl(dir), 'https://github.com/acme/one.git');
  spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/two.git'], { windowsHide: true });
  const cfg = path.join(dir, '.git', 'config');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(cfg, later, later);
  assert.equal(await originUrl(dir), 'https://github.com/acme/two.git', 'a changed config is read again');
});
