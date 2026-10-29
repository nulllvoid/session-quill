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
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: environments, provider } } };
  const env = { QUILL_HOME: home };
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

// ADR 0033: merge commits, revert detection within 48 hours, and a run's own draft PR.
const MERGE = 'c'.repeat(40);
const REVERT = 'd'.repeat(40);

test('mapGithubPr keeps the merge commit of a merged PR only', () => {
  assert.equal(mapGithubPr({ state: 'MERGED', mergedAt: '2026-10-02T00:00:00Z', mergeCommit: { oid: MERGE } }).merge_commit, MERGE);
  assert.equal(mapGithubPr({ state: 'OPEN', mergeCommit: { oid: MERGE } }).merge_commit, null);
  assert.equal(mapGithubPr({ state: 'MERGED', mergeCommit: { oid: 'not-a-sha' } }).merge_commit, null);
});

function ghFake({ commits = [], prs = [], title = 'Fix retries' } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ title, mergedAt: '2026-10-02T08:00:00Z', mergeCommit: { oid: MERGE } });
    if (args[0] === 'api') return JSON.stringify(commits);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { exec, calls };
}

test('findGithubRevert: a revert commit or a Revert PR inside 48 h of the merge counts; one outside does not', async () => {
  const { findGithubRevert } = await import('../../src/reconcile/providers/github.js');
  const inside = ghFake({ commits: [{ sha: REVERT, commit: { message: `Revert "Fix retries"\n\nThis reverts commit ${MERGE}.`, committer: { date: '2026-10-03T08:00:00Z' } } }] });
  assert.deepEqual(await findGithubRevert(inside.exec, { url: PR_URL, merged_at: '2026-10-02T08:00:00Z', merge_commit: MERGE }), { reverted_by: REVERT, reverted_at: '2026-10-03T08:00:00Z', merge_commit: MERGE });
  assert.match(inside.calls.find((a) => a[0] === 'api')[1], /^repos\/acme\/demo\/commits\?since=.*&until=2026-10-04T08%3A00%3A00Z/);
  const late = ghFake({ commits: [{ sha: REVERT, commit: { message: `This reverts commit ${MERGE}.`, committer: { date: '2026-10-04T09:00:00Z' } } }], prs: [{ title: 'Revert "Fix retries"', mergedAt: '2026-10-05T00:00:00Z', mergeCommit: { oid: REVERT } }] });
  assert.equal((await findGithubRevert(late.exec, { url: PR_URL, merged_at: '2026-10-02T08:00:00Z', merge_commit: MERGE })).reverted_by, null);
  const byPr = ghFake({ prs: [{ title: 'Revert "Other"', body: 'Reverts acme/demo#6', mergedAt: '2026-10-02T09:00:00Z', mergeCommit: { oid: 'e'.repeat(40) } }, { title: 'Revert "Fix retries"', body: 'Reverts acme/demo#7', headRefName: 'revert-7-fix', mergedAt: '2026-10-02T20:00:00Z', mergeCommit: { oid: REVERT } }] });
  assert.equal((await findGithubRevert(byPr.exec, { url: PR_URL, merged_at: '2026-10-02T08:00:00Z', merge_commit: MERGE })).reverted_by, REVERT);
  await assert.rejects(findGithubRevert(inside.exec, { url: 'https://example.com/x' }), /unsupported/);
});

test('a legacy run PR without branch identity is observed for reverts but cannot move its ticket', async () => {
  const f = fixture();
  const w = new Worker({ config: f.config, storeMeta: f.meta, env: f.env, clock: f.clock, derive });
  await w.start();
  writeIngress(f.mk('ticket-create', { ticket: { id: T1, key: 'LOCAL-demo-00000001', title: 'Demo', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }), f.env);
  w.tick();
  const HID = '99999999-0000-4000-8000-000000000001';
  w.state.handoffs.set(HID, { id: HID, ticket_id: T1, repo_id: 'demo', state: 'done', finished_at: f.iso(), pr_url: PR_URL, recipe: { name: 'attempt-fix' } });
  let fetches = 0;
  let reverts = 0;
  const providers = { for: () => ({ name: 'github', fetchPr: async () => { fetches += 1; return { state: 'merged', merged_at: '2026-10-02T07:00:00Z', merge_commit: MERGE }; }, findRevert: async () => { reverts += 1; return { reverted_by: null, reverted_at: null, merge_commit: MERGE }; } }) };
  const before = w.state.tickets.get(T1).status;
  await runReconciliation(w, { reason: 'test', providers });
  const h = w.state.handoffs.get(HID);
  assert.equal(h.pr_observed.state, 'merged');
  assert.equal(h.pr_observed.merge_commit, MERGE);
  assert.equal(h.pr_observed.reverted_by, null);
  assert.equal(h.pr_observed.revert_checked_at, f.iso());
  assert.equal(w.state.tickets.get(T1).status, before, 'a legacy run without matching recorded branch is not ticket evidence');
  assert.equal(w.state.tickets.get(T1).prs.length, 0);
  f.advance(49 * 60 * 60 * 1000);
  await runReconciliation(w, { reason: 'test', providers });
  assert.equal(reverts, 2, 'checked once more after the window closed');
  await runReconciliation(w, { reason: 'test', providers });
  assert.equal(fetches, 2, 'a settled run PR is not polled again');
  await w.stop();
});

test('findGithubRevert: a Revert PR counts only for the PR it names, never for every PR sharing its title', async () => {
  const { findGithubRevert } = await import('../../src/reconcile/providers/github.js');
  // A bulk dialog gives every run the same note, so their PRs share the title "Handoff: fix flaky".
  const title = 'Handoff: fix flaky';
  const url = (n) => `https://github.com/acme/demo/pull/${n}`;
  const revertOf8 = { title: `Revert "${title}"`, body: 'Reverts acme/demo#8\n\nBroke the build.', headRefName: 'revert-8-quill-run-b', mergedAt: '2026-10-02T20:00:00Z', mergeCommit: { oid: REVERT } };
  const batch = ghFake({ title, prs: [revertOf8] });
  const check = async (n, fake = batch) => (await findGithubRevert(fake.exec, { url: url(n), merged_at: '2026-10-02T08:00:00Z', merge_commit: MERGE })).reverted_by;
  assert.equal(await check(8), REVERT, 'the PR the revert names');
  assert.equal(await check(7), null, 'a sibling with the same title is not reverted');
  assert.equal(await check(9), null);
  // The title alone never counts; a near-miss number never counts.
  const titleOnly = ghFake({ title, prs: [{ title: `Revert "${title}"`, body: 'manual revert', headRefName: 'undo-it', mergedAt: '2026-10-02T20:00:00Z', mergeCommit: { oid: REVERT } }] });
  assert.equal(await check(7, titleOnly), null);
  const near = ghFake({ title, prs: [{ title: `Revert "${title}"`, body: 'Reverts acme/demo#70', headRefName: 'revert-70-x', mergedAt: '2026-10-02T20:00:00Z', mergeCommit: { oid: REVERT } }] });
  assert.equal(await check(7, near), null);
  const otherRepo = ghFake({ title, prs: [{ title: `Revert "${title}"`, body: 'Reverts someone/else#7', mergedAt: '2026-10-02T20:00:00Z', mergeCommit: { oid: REVERT } }] });
  assert.equal(await check(7, otherRepo), null);
  // GitHub's revert branch alone is enough.
  const byBranch = ghFake({ title, prs: [{ title: 'Revert something', body: '', headRefName: 'revert-7-quill-run-a', mergedAt: '2026-10-02T20:00:00Z', mergeCommit: { oid: REVERT } }] });
  assert.equal(await check(7, byBranch), REVERT);
  assert.ok(batch.calls.some((a) => a[0] === 'pr' && a[1] === 'list' && a.includes('title,body,headRefName,mergedAt,mergeCommit')));
});
