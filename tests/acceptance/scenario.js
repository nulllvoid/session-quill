// Shared scenario harness: a worker on a fake clock, hook runner, HTTP client and store helpers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../../src/config/config.js';
import { derive } from '../../src/reconcile/derive.js';
import { createExtension as reconcileExt } from '../../src/reconcile/extension.js';
import { createExtension as serverExt } from '../../src/server/extension.js';
import { createExtension as handoffExt } from '../../src/handoff/extension.js';
import { hashSecret } from '../../src/server/auth.js';
import { runHook } from '../../src/hooks/adapter.js';
import { writeRuntimeIdentity, writeHeartbeat } from '../../src/hooks/binding-snapshot.js';

export const MACHINE = '22222222-2222-4222-8222-222222222222';
export const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.js');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scenarios A01–A41 describe the strict gate; phase 6 passes gateMode explicitly (ADR 0005).
export function scenario({ startMs = Date.parse('2026-10-02T08:00:00Z'), repos = {}, providers = null, withServer = false, withHandoff = false, handoffOpts = {}, gateMode = 'strict' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-acc-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'acc' }));
  const config = { ...defaultUserConfig(), store_path: storePath, default_project: 'demo', projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'], provider: 'github' }, ...repos } };
  config.gate = { ...config.gate, mode: gateMode };
  const env = { QUILL_HOME: home };
  saveUserConfig(config, env);
  let nowMs = startMs;
  const clock = () => nowMs;
  const iso = () => new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ctx = { env, config, storeMeta: meta, machineId: MACHINE };
  const s = {
    home, storePath, meta, config, env, ctx, clock, iso, w: null, rext: null, sext: null, hext: null,
    advance: (ms) => { nowMs += ms; },
    mk: (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: extra.producer ?? 'test', occurred_at: extra.at ?? iso(), ...extra }),
    ingest: (kind, payload, extra = {}) => { writeIngress(s.mk(kind, payload, extra), env); },
    ticket: (id, key, extra = {}) => { s.ingest('ticket-create', { ticket: { id, key, title: extra.title ?? `Ticket ${key}`, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: extra.priority ?? 'P2', parent_id: extra.parent_id ?? null, repo_id: 'demo', due: extra.due ?? null, jira: null } }); s.w.tick(); return s.w.state.tickets.get(id); },
    bind: (session_id, ticket_id, extra = {}) => { s.ingest('session-start', { source: 'startup', cwd: 'C:/repo' }, { session_id, ...extra }); s.ingest('bind', { ticket_id, project_id: 'demo' }, { session_id, ...extra }); s.w.tick(); },
    hook: (eventName, input, at) => runHook(eventName, { hook_event_name: eventName, cwd: 'C:/repo', ...input }, { env, now: at ?? iso() }),
    hookIdentity: () => { writeRuntimeIdentity({ store_id: meta.store_id, machine_id: MACHINE, store_path: storePath, gate_enabled: true, approval_phrases_enabled: false, allow_tools: [] }, env); writeHeartbeat({ at: iso(), pid: 1, store_id: meta.store_id }, env); },
    async start({ derive: d = derive } = {}) {
      s.w = new Worker({ config, storeMeta: meta, env, clock, derive: d });
      s.rext = reconcileExt(ctx, { providers: providers ?? { for: () => ({ name: 'github', fetchPr: async () => { throw new Error('gh: offline'); } }) } });
      s.w.use(s.rext);
      if (withServer || withHandoff) { s.sext = serverExt(ctx, { port: 0 }); s.w.use(s.sext); }
      if (withHandoff) { s.hext = handoffExt(ctx, { claudePath: process.execPath, claudeArgs: [FAKE_CLAUDE], runtimeAvailable: true, maxConcurrent: 4, ...handoffOpts }); s.w.use(s.hext); }
      await s.w.start();
      s.w.tick();
      await s.rext.idle();
      s.w.tick();
      return s;
    },
    async settle() { s.w.tick(); if (s.rext) await s.rext.idle(); s.w.tick(); },
    // Runs fn while the worker ticks in the background (CLI commands wait for worker acks).
    async ticking(fn) { const timer = setInterval(() => { try { s.w.tick(); } catch { /* surfaced by assertions */ } }, 20); try { return await fn(); } finally { clearInterval(timer); } },
    async stop(opts) { if (s.w) await s.w.stop(opts); },
    async client() {
      const port = s.sext.address().port;
      const base = `http://127.0.0.1:${port}`;
      const secret = 'e'.repeat(64);
      s.sext.acceptSecretHash(hashSecret(secret), nowMs + 600_000);
      const auth = await fetch(`${base}/auth?secret=${secret}`, { redirect: 'manual' });
      const cookie = auth.headers.get('set-cookie').split(';')[0];
      const csrf = (await (await fetch(`${base}/v1/csrf`, { headers: { cookie } })).json()).csrf;
      return {
        base, cookie, csrf,
        get: (url) => fetch(`${base}${url}`, { headers: { cookie } }),
        post: (url, body, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-quill-csrf': csrf, origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
      };
    },
    notePath: (key) => path.join(storePath, 'tickets', `${key}.md`),
  };
  return s;
}

export async function until(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(stepMs);
  }
}

export const RID = (n) => `33333333-0000-4000-8000-${String(n).padStart(12, '0')}`;
