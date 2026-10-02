import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';
import { runReconciliation, nextSyncDue } from '../../src/reconcile/run.js';
import { createExtension } from '../../src/reconcile/extension.js';
import { derive } from '../../src/reconcile/derive.js';
import { mapGithubPr } from '../../src/reconcile/providers/github.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PR_URL = 'https://github.com/acme/demo/pull/7';

function fixture({ environments = ['production'], provider = 'github' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rec-'));
  const storePath = path.join(home, 'Tracker');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Tracker', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: environments, provider } } };
  const env = { TRACKER_HOME: home };
  let nowMs = Date.parse('2026-10-02T08:00:00Z');
  const clock = () => nowMs;
  const iso = () => new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: iso(), ...extra });
  return { env, meta, config, clock, iso, mk, advance: (ms) => { nowMs += ms; } };
}

async function ticketWithPr(f, w, state = 'open') {
  writeIngress(f.mk('ticket-create', { ticket: { id: T1, key: 'LOCAL-demo-00000001', title: 'Demo', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }), f.env);
  writeIngress(f.mk('session-start', { source: 'startup' }, { session_id: 'h1' }), f.env);
  writeIngress(f.mk('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'h1' }), f.env);
  writeIngress(f.mk('pre-tool', { tool_name: 'Bash' }, { session_id: 'h1', tool_call_id: 't1', source_identity: 'pre:h1:t1' }), f.env);
  writeIngress(f.mk('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: PR_URL, provider: 'github', state } }, { session_id: 'h1', tool_call_id: 't1', source_identity: 'post:h1:t1' }), f.env);
  w.tick();
  return w.state.tickets.get(T1);
}

function fakeProviders(responses) {
  return {
    for: () => ({
      name: 'github',
      fetchPr: async (url) => {
        const r = typeof responses === 'function' ? responses(url) : responses;
        if (r instanceof Error) throw r;
        return r;
      },
    }),
  };
}

test('mapGithubPr maps gh JSON into contract PR states', () => {
  assert.equal(mapGithubPr({ state: 'MERGED', isDraft: false, createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-02T00:00:00Z', baseRefName: 'main', headRefName: 'f' }).state, 'merged');
  assert.equal(mapGithubPr({ state: 'OPEN', isDraft: true }).state, 'draft');
  assert.equal(mapGithubPr({ state: 'OPEN', isDraft: false }).state, 'open');
  assert.equal(mapGithubPr({ state: 'CLOSED' }).state, 'closed');
  assert.equal(mapGithubPr({ state: 'MERGED', mergedAt: '2026-10-02T00:00:00.000Z' }).merged_at, '2026-10-02T00:00:00Z');
});

test('open PR -> review; provider failure keeps prior evidence and records provider error; last_sync set after a run', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, derive });
  await w.start();
  const t = await ticketWithPr(f, w, 'open');
  assert.equal(t.status, 'review');
  const failing = fakeProviders(new Error('gh: network unreachable'));
  const result = await runReconciliation(w, { reason: 'test', providers: failing });
  assert.equal(result.provider_health[0].error, 'gh: network unreachable');
  assert.equal(t.prs[0].state, 'open', 'prior evidence retained');
  assert.equal(t.prs[0].error, 'gh: network unreachable');
  assert.equal(w.state.lastSync, f.iso());
  const snap = w.getSnapshot();
  assert.equal(snap.meta.provider_health[0].provider, 'github');
  assert.equal(snap.meta.last_sync, f.iso());
  await w.stop();
});

test('merge evidence creates one obligation per environment; repeated identical polls cannot undo a manual blocked status; done-with-pending stays in deployments', async () => {
  const f = fixture({ environments: ['staging', 'production'] });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, derive });
  await w.start();
  const t = await ticketWithPr(f, w, 'open');
  const merged = { state: 'merged', opened_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T07:00:00Z', base_branch: 'main', head_branch: 'feat', observed_at: f.iso() };
  await runReconciliation(w, { reason: 'test', providers: fakeProviders(merged) });
  assert.equal(t.status, 'deploy-pending');
  assert.equal(t.deployments.length, 2);
  assert.deepEqual(t.deployments.map((d) => d.environment).sort(), ['production', 'staging']);
  // Owner marks blocked manually
  writeIngress(f.mk('ticket-update', { ticket_id: T1, fields: { status: 'blocked', blocker: 'waiting for infra' }, source: 'manual' }), f.env);
  w.tick();
  assert.equal(t.status, 'blocked');
  await runReconciliation(w, { reason: 'test', providers: fakeProviders(merged) });
  await runReconciliation(w, { reason: 'test', providers: fakeProviders(merged) });
  assert.equal(t.status, 'blocked', 'identical poll evidence cannot undo the manual choice');
  assert.equal(t.deployments.length, 2, 'no duplicate obligations');
  writeIngress(f.mk('ticket-update', { ticket_id: T1, fields: { status: 'done' }, source: 'manual' }), f.env);
  w.tick();
  const d = derive(w.state, f.iso());
  assert.equal(t.status, 'done');
  assert.equal(d.deployments_outstanding.filter((o) => o.ticket_id === T1).length, 2);
  await w.stop();
});

test('draft and closed-unmerged PRs create no deployment obligation', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, derive });
  await w.start();
  const t = await ticketWithPr(f, w, 'draft');
  assert.equal(t.status, 'review');
  assert.equal(t.deployments.length, 0);
  await runReconciliation(w, { reason: 'test', providers: fakeProviders({ state: 'closed', opened_at: '2026-10-01T00:00:00Z', merged_at: null, observed_at: f.iso() }) });
  assert.equal(t.deployments.length, 0);
  assert.equal(t.prs[0].state, 'closed');
  await w.stop();
});

test('scheduler: catch-up run on start when never synced, next run due after the interval, refresh request runs within one tick and duplicates join the same run', async () => {
  const f = fixture({ provider: null });
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, derive });
  const ext = createExtension({ env: f.env, config: f.config }, { providers: fakeProviders({ state: 'unknown' }) });
  w.use(ext);
  await w.start();
  w.tick();
  await ext.idle();
  assert.equal(w.state.lastSync, f.iso(), 'catch-up run on start');
  assert.equal(nextSyncDue(w.state.lastSync, 2), '2026-10-02T10:00:00Z');
  f.advance(60 * 60 * 1000);
  w.tick();
  await ext.idle();
  assert.equal(w.state.lastSync, '2026-10-02T08:00:00Z', 'not yet due');
  f.advance(60 * 60 * 1000);
  w.tick();
  await ext.idle();
  assert.equal(w.state.lastSync, '2026-10-02T10:00:00Z');
  // two refresh requests: one run, both applied with the same run id
  const now = f.iso();
  for (const id of ['11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb']) {
    writeIngress(f.mk('request', { id, kind: 'refresh', target_id: null, expected_revision: null, payload: {}, created_at: now, not_before: now, actor_id: 'test' }, { source_identity: `request:${id}` }), f.env);
  }
  f.advance(1000);
  w.tick();
  await ext.idle();
  w.tick();
  const reqs = [...w.state.requests.values()];
  assert.deepEqual(reqs.map((r) => r.state), ['applied', 'applied']);
  assert.equal(reqs[0].result.run_id, reqs[1].result.run_id);
  assert.equal(w.state.lastSync, f.iso());
  await w.stop();
});
