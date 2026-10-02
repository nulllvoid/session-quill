// Phase 7 — schedules and the Bitbucket provider (ADR 0007). Each test is named after its
// ACCEPTANCE.md scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { scenario, T1 } from './scenario.js';
import { defaultProviders } from '../../src/reconcile/providers/index.js';
import { journalPath } from '../../src/lib/paths.js';

const offline = { for: () => ({ name: 'github', fetchPr: async () => { throw new Error('gh: offline'); } }) };
const snap = async (c) => (await c.get('/v1/snapshot')).json();

test('A49 a cron schedule runs once at its slot in the store time zone, and the snapshot reports next and last runs', async () => {
  const s = scenario({ timezone: 'Asia/Kolkata', startMs: Date.parse('2026-10-02T13:00:00Z'), withServer: true, providers: offline });
  s.config.schedule = [{ name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5' }];
  await s.start();
  try {
    const c = await s.client();
    let view = await snap(c);
    assert.equal(view.schedules[0].next_due, '2026-10-02T14:00:00Z', '19:30 in Kolkata');
    assert.equal(view.schedules[0].last_outcome, null);
    s.advance(60 * 60 * 1000);
    await s.settle();
    view = await snap(c);
    const evening = view.schedules[0];
    assert.deepEqual([evening.last_outcome, evening.runs.length, evening.runs[0].trigger, evening.next_due], ['ok', 1, 'schedule', '2026-10-05T14:00:00Z']);
    assert.equal(view.meta.next_sync_due, '2026-10-05T14:00:00Z');
    await s.settle();
    assert.equal((await snap(c)).schedules[0].runs.length, 1, 'one run per slot');
  } finally { await s.stop(); }
});

test('A50 slots missed while the worker was stopped run once on restart, then the next future slot', async () => {
  const s = scenario({ startMs: Date.parse('2026-10-02T07:59:00Z'), providers: offline });
  s.config.schedule = [{ name: 'hourly', job: 'reconcile', cron: '0 * * * *' }];
  await s.start();
  s.advance(60 * 1000);
  await s.settle();
  assert.equal(s.w.state.schedules.get('hourly').runs.length, 1);
  await s.stop();
  s.advance(5.5 * 60 * 60 * 1000);
  await s.start();
  try {
    await s.settle();
    await s.settle();
    const rec = s.w.state.schedules.get('hourly');
    assert.deepEqual(rec.runs.map((r) => r.trigger), ['catch-up', 'schedule']);
    assert.equal(s.w.scheduleInfo()[0].next_due, '2026-10-02T14:00:00Z');
  } finally { await s.stop(); }
});

test('A51 Run now runs a schedule immediately without an undo delay; unknown schedules are refused; Refresh still works', async () => {
  const s = scenario({ withServer: true, providers: offline });
  s.config.schedule = [{ name: 'reconcile', job: 'reconcile', every: '2h' }, { name: 'evening', job: 'reconcile', cron: '30 19 * * 1-5' }];
  await s.start();
  try {
    const c = await s.client();
    const res = await c.post('/v1/requests', { id: randomUUID(), kind: 'run-job', payload: { schedule: 'evening' } });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.not_before, body.created_at);
    await s.settle();
    const evening = (await snap(c)).schedules.find((x) => x.name === 'evening');
    assert.deepEqual([evening.runs[0].trigger, evening.last_outcome], ['manual', 'ok']);
    assert.equal((await c.post('/v1/requests', { id: randomUUID(), kind: 'run-job', payload: { schedule: 'nope' } })).status, 400);
    const refresh = await (await c.post('/v1/requests', { id: randomUUID(), kind: 'refresh', payload: {} })).json();
    await s.settle();
    assert.equal(s.w.state.requests.get(refresh.id).state, 'applied');
  } finally { await s.stop(); }
});

test('A52 a Bitbucket Server PR is polled with a token from the environment; the token is stored nowhere', async () => {
  const TOKEN = 'bb-acceptance-token-6f1d';
  let seenAuth = null;
  const srv = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ state: 'MERGED', createdDate: Date.parse('2026-09-30T08:00:00Z'), closedDate: Date.parse('2026-10-01T10:30:00Z'), fromRef: { displayId: 'feat/pm-12' }, toRef: { displayId: 'main' } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const holder = {};
  const s = scenario({ withServer: true, providers: { for: (repo) => holder.providers.for(repo) } });
  s.config.repos.demo = { ...s.config.repos.demo, provider: 'bitbucket', provider_url: base, token_env: 'QUILL_TEST_BB_TOKEN', deployment_environments: ['staging', 'production'] };
  s.env.QUILL_TEST_BB_TOKEN = TOKEN;
  holder.providers = defaultProviders(s.config, s.env);
  await s.start();
  try {
    const prUrl = `${base}/projects/PM/repos/app/pull-requests/12`;
    s.ingest('ticket-create', { ticket: { id: T1, key: 'PM-12', title: 'Bitbucket work', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null, status: 'review', prs: [{ url: prUrl, provider: 'bitbucket', state: 'open' }] } });
    await s.settle();
    const c = await s.client();
    await c.post('/v1/requests', { id: randomUUID(), kind: 'refresh', payload: {} });
    await s.settle();
    const t = s.w.state.tickets.get(T1);
    assert.equal(seenAuth, `Bearer ${TOKEN}`);
    assert.deepEqual([t.prs[0].state, t.prs[0].merged_at, t.status], ['merged', '2026-10-01T10:30:00Z', 'deploy-pending']);
    assert.deepEqual(t.deployments.map((d) => d.environment).sort(), ['production', 'staging']);
    const view = JSON.stringify(await snap(c));
    const journal = fs.readFileSync(journalPath(s.env), 'utf8');
    const health = fs.existsSync(path.join(s.home, 'state', 'health-errors.jsonl')) ? fs.readFileSync(path.join(s.home, 'state', 'health-errors.jsonl'), 'utf8') : '';
    for (const [where, text] of [['snapshot', view], ['journal', journal], ['health log', health]]) assert.equal(text.includes(TOKEN), false, where);
  } finally { await s.stop(); srv.close(); }
});
