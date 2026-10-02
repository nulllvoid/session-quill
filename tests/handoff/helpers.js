import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';
import { derive } from '../../src/reconcile/derive.js';
import { createExtension as serverExt } from '../../src/server/extension.js';
import { createExtension as handoffExt } from '../../src/handoff/extension.js';

export const MACHINE = '22222222-2222-4222-8222-222222222222';
export const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.js');

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

export async function bootWorker({ repo, fakeEnv = {}, deadlineMs, withServer = true, claudePath = process.execPath, claudeArgs = [FAKE_CLAUDE], runtimeAvailable } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ho-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', canonical_path: repo ? repo.dir : undefined, default_branch: 'main', deployment_environments: ['production'], provider: null } } };
  const env = { QUILL_HOME: home };
  let nowMs = Date.parse('2026-10-02T08:00:00Z');
  const clock = () => nowMs;
  const iso = () => new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const w = new Worker({ config, storeMeta: meta, env, clock, derive });
  const ctx = { env, config, storeMeta: meta };
  const hext = handoffExt(ctx, { claudePath, claudeArgs, spawnEnv: fakeEnv, deadlineMs, maxConcurrent: 4, runtimeAvailable });
  if (withServer) w.use(serverExt(ctx, { port: 0 }));
  w.use(hext);
  await w.start();
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: iso(), ...extra });
  const ticket = (id, key, extra = {}) => { writeIngress(mk('ticket-create', { ticket: { id, key, title: `Ticket ${key}`, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null, ...extra } }), env); w.tick(); return w.state.tickets.get(id); };
  const request = (id, body) => { writeIngress(mk('request', { id, kind: 'handoff', target_id: body.target_id, expected_revision: body.expected_revision, payload: body.payload, created_at: iso(), not_before: iso(), actor_id: 'test', body_hash: 'x' }, { source_identity: `request:${id}` }), env); w.tick(); return w.state.requests.get(id); };
  return { w, env, meta, config, ticket, request, hext, advance: (ms) => { nowMs += ms; }, iso, mk, home, storePath };
}

export async function restartWorker(prev, { runtimeAvailable = true } = {}) {
  const w = new Worker({ config: prev.config, storeMeta: prev.meta, env: prev.env, derive });
  const ctx = { env: prev.env, config: prev.config, storeMeta: prev.meta };
  const hext = handoffExt(ctx, { claudePath: process.execPath, claudeArgs: [FAKE_CLAUDE], runtimeAvailable, maxConcurrent: 4 });
  w.use(hext);
  await w.start();
  return { ...prev, w, hext };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(stepMs);
  }
}
