// Phase 3 — reconciliation, UI and sharing (ACCEPTANCE.md A24–A32).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scenario, T1, T2, RID } from './scenario.js';
import { runReconciliation } from '../../src/reconcile/run.js';
import { freshness } from '../../ui/lib/time.js';
import { renderHeader } from '../../ui/views/header.js';
import { buildStaticHtml } from '../../src/export/static.js';
import { snapshot as uiFixture } from '../ui/fixtures.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('A24 advancing time alone makes sessions idle/extinct and active tickets stale at the boundaries; new work clears stale without changing status; compaction does not end a session', async () => {
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('age-1', T1);
    s.ingest('ticket-update', { ticket_id: T1, fields: { status: 'active' }, source: 'manual' });
    s.w.tick();
    s.w.flushNotes();
    const notesBefore = fs.statSync(s.notePath('LOCAL-a-00000001')).mtimeMs;
    s.advance(31 * 60_000);
    let snap = s.w.publishGeneration();
    assert.equal(snap.sessions[0].state, 'idle');
    assert.equal(snap.tickets[0].stale, false);
    s.advance(5 * DAY);
    snap = s.w.publishGeneration();
    assert.equal(snap.sessions[0].state, 'extinct');
    assert.equal(snap.tickets[0].stale, true);
    assert.equal(snap.tickets[0].status, 'active');
    assert.equal(fs.statSync(s.notePath('LOCAL-a-00000001')).mtimeMs, notesBefore, 'note mtime unchanged while ageing');
    s.ingest('pre-compact', { trigger: 'auto' }, { session_id: 'age-1' });
    s.w.tick();
    assert.equal(s.w.state.sessions.get('age-1').ended_at, null);
    s.ingest('stop', { content_ref: 'a'.repeat(64), preview: 'new work', length: 8, complete: true }, { session_id: 'age-1' });
    s.w.tick();
    snap = s.w.publishGeneration();
    assert.equal(snap.tickets[0].stale, false);
    assert.equal(snap.tickets[0].status, 'active');
    assert.equal(snap.sessions[0].state, 'live');
  } finally { await s.stop(); }
});

test('A25 ranking excludes blocked/done before scoring, counts an overdue due once, breaks ties deterministically, caps display at 100 and shows fewer than five when fewer exist', async () => {
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001', { priority: 'P0', due: '2026-09-01' });
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'x', status: 'active' }, source: 'manual' });
    s.ticket(T2, 'LOCAL-b-00000002', { priority: 'P0', due: '2026-09-01' });
    s.ticket('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'LOCAL-c-00000003', { priority: 'P0' });
    s.ingest('ticket-update', { ticket_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', fields: { status: 'blocked', blocker: 'b' }, source: 'manual' });
    s.ticket('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'LOCAL-d-00000004', { priority: 'P0' });
    s.ingest('ticket-update', { ticket_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fields: { status: 'done' }, source: 'manual' });
    s.w.tick();
    const snap = s.w.publishGeneration();
    assert.equal(snap.picknext.length, 2);
    assert.equal(snap.picknext[0].ticket_id, T1);
    assert.equal(snap.picknext[0].raw_score, 80);
    assert.equal(snap.picknext[1].raw_score, 70);
    assert.ok(snap.picknext.every((p) => p.score <= 100));
    assert.deepEqual(snap.blocked.map((b) => b.ticket_id), ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
  } finally { await s.stop(); }
});

test('A26 repeated identical PR polls cannot undo a manual status; multiple environments keep separate obligations; draft/closed-unmerged create none; done-with-pending stays listed', async () => {
  let prState = { state: 'merged', opened_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-01T12:00:00Z' };
  const providers = { for: () => ({ name: 'github', fetchPr: async (url) => (url.endsWith('/1') ? prState : { state: 'draft', opened_at: '2026-10-01T00:00:00Z', merged_at: null }) }) };
  const s = await scenario({ providers, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['staging', 'production'], provider: 'github' } } }).start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.ticket(T2, 'LOCAL-b-00000002');
    s.bind('pr1', T1);
    s.bind('pr2', T2);
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'pr1', tool_call_id: 'g1', source_identity: 'pre:pr1:g1' });
    s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: 'https://github.com/acme/demo/pull/1', provider: 'github', state: 'open' } }, { session_id: 'pr1', tool_call_id: 'g1', source_identity: 'post:pr1:g1' });
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'pr2', tool_call_id: 'g2', source_identity: 'pre:pr2:g2' });
    s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: 'https://github.com/acme/demo/pull/2', provider: 'github', state: 'draft' } }, { session_id: 'pr2', tool_call_id: 'g2', source_identity: 'post:pr2:g2' });
    s.w.tick();
    await runReconciliation(s.w, { providers });
    const t1 = s.w.state.tickets.get(T1);
    assert.equal(t1.status, 'deploy-pending');
    assert.deepEqual(t1.deployments.map((d) => d.environment).sort(), ['production', 'staging']);
    assert.equal(s.w.state.tickets.get(T2).deployments.length, 0, 'draft PR: no obligation');
    s.ingest('ticket-update', { ticket_id: T1, fields: { status: 'blocked', blocker: 'hold' }, source: 'manual' });
    s.w.tick();
    await runReconciliation(s.w, { providers });
    await runReconciliation(s.w, { providers });
    assert.equal(t1.status, 'blocked');
    assert.equal(t1.deployments.length, 2);
    prState = { state: 'closed', opened_at: '2026-10-01T00:00:00Z', merged_at: null };
    await runReconciliation(s.w, { providers });
    assert.equal(s.w.state.tickets.get(T2).deployments.length, 0, 'closed-unmerged creates none');
    s.ingest('ticket-update', { ticket_id: T1, fields: { status: 'done' }, source: 'manual' });
    s.w.tick();
    const snap = s.w.publishGeneration();
    assert.equal(snap.deployments_outstanding.filter((d) => d.ticket_id === T1).length, 2, 'done with pending obligations stays in Deployments');
  } finally { await s.stop(); }
});

test('A27 fresh, ageing, stale, never-synced and disconnected states display; a local sync with provider failure keeps old evidence age and a separate provider error', async () => {
  const now = '2026-10-02T12:00:00Z';
  assert.equal(freshness({ last_sync: null }, now), 'never-synced');
  assert.equal(freshness({ last_sync: '2026-10-02T11:00:00Z' }, now), 'fresh');
  assert.equal(freshness({ last_sync: '2026-10-02T08:00:00Z' }, now), 'ageing');
  assert.equal(freshness({ last_sync: '2026-10-02T05:00:00Z' }, now), 'stale');
  const base = uiFixture();
  const disconnected = renderHeader(base, { now, online: false, refresh: null, theme: 'dark' });
  assert.match(disconnected, /Offline/);
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('h1', T1);
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'h1', tool_call_id: 'g', source_identity: 'pre:h1:g' });
    s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: 'https://github.com/acme/demo/pull/3', provider: 'github', state: 'open' } }, { session_id: 'h1', tool_call_id: 'g', source_identity: 'post:h1:g' });
    s.w.tick();
    const ok = { for: () => ({ name: 'github', fetchPr: async () => ({ state: 'open', opened_at: '2026-10-01T00:00:00Z', merged_at: null }) }) };
    await runReconciliation(s.w, { providers: ok });
    const observed = s.w.state.tickets.get(T1).prs[0].observed_at;
    s.advance(3 * HOUR);
    await runReconciliation(s.w, { providers: { for: () => ({ name: 'github', fetchPr: async () => { throw new Error('gh: auth required'); } }) } });
    const snap = s.w.publishGeneration();
    assert.equal(snap.meta.last_sync, s.iso(), 'local sync completed');
    assert.equal(snap.tickets[0].prs[0].observed_at, observed, 'provider evidence age not reset');
    assert.equal(snap.meta.provider_health[0].error, 'gh: auth required');
    assert.equal(snap.meta.provider_health[0].last_success_at, observed);
  } finally { await s.stop(); }
});

test('A28 two clients with the same revision: one applies, one conflicts; identical repost returns the same result; different body rejects; retry does not overwrite newer content', async () => {
  const s = await scenario({ withServer: true }).start();
  try {
    const rev0 = s.ticket(T1, 'LOCAL-a-00000001').revision;
    const c = await s.client();
    const a = { id: RID(10), kind: 'set-next-action', target_id: T1, expected_revision: rev0, payload: { next_action: 'A' } };
    const b = { id: RID(11), kind: 'set-next-action', target_id: T1, expected_revision: rev0, payload: { next_action: 'B' } };
    assert.equal((await c.post('/v1/requests', a)).status, 202);
    assert.equal((await c.post('/v1/requests', b)).status, 202);
    s.advance(10_000); await s.settle();
    const ra = await (await c.get(`/v1/requests/${RID(10)}`)).json();
    const rb = await (await c.get(`/v1/requests/${RID(11)}`)).json();
    assert.deepEqual([ra.state, rb.state].sort(), ['applied', 'conflict']);
    assert.equal((await (await c.post('/v1/requests', a)).json()).id, RID(10));
    assert.equal((await c.post('/v1/requests', { ...a, payload: { next_action: 'A2' } })).status, 409);
    const retry = { id: RID(12), kind: 'set-next-action', target_id: T1, expected_revision: rev0, payload: { next_action: 'stale retry' }, retry_of: RID(11) };
    assert.equal((await c.post('/v1/requests', retry)).status, 202);
    s.advance(10_000); await s.settle();
    assert.equal((await (await c.get(`/v1/requests/${RID(12)}`)).json()).state, 'conflict', 'a retry against a stale revision cannot overwrite newer content');
    assert.equal(s.w.state.tickets.get(T1).next_action, 'A');
  } finally { await s.stop(); }
});

test('A29 cancel inside the 10 s window applies nothing; cancellation after application reports applied and a reversal is a new revision-checked request', async () => {
  const s = await scenario({ withServer: true }).start();
  try {
    const t = s.ticket(T1, 'LOCAL-a-00000001');
    const c = await s.client();
    await c.post('/v1/requests', { id: RID(20), kind: 'set-next-action', target_id: T1, expected_revision: t.revision, payload: { next_action: 'undo me' } });
    s.advance(4_000); await s.settle();
    assert.equal((await (await c.post(`/v1/requests/${RID(20)}/cancel`)).json()).outcome, 'cancelled');
    s.advance(10_000); await s.settle();
    assert.equal(s.w.state.tickets.get(T1).next_action, '');
    await c.post('/v1/requests', { id: RID(21), kind: 'set-next-action', target_id: T1, expected_revision: t.revision, payload: { next_action: 'kept' } });
    s.advance(11_000); await s.settle();
    const late = await (await c.post(`/v1/requests/${RID(21)}/cancel`)).json();
    assert.equal(late.outcome, 'already-applied');
    const rev = s.w.state.tickets.get(T1).revision;
    assert.equal((await c.post('/v1/requests', { id: RID(22), kind: 'set-next-action', target_id: T1, expected_revision: rev, payload: { next_action: '' } })).status, 202);
    s.advance(11_000); await s.settle();
    assert.equal(s.w.state.tickets.get(T1).next_action, '');
  } finally { await s.stop(); }
});

test('A30 Refresh starts within one tick on an idle worker regardless of schedule; duplicates join the run; a failed run permits retry', async () => {
  let fail = false;
  const providers = { for: () => { if (fail) throw new Error('simulated reconciliation failure'); return { name: 'github', fetchPr: async () => ({ state: 'open', opened_at: '2026-10-01T00:00:00Z', merged_at: null }) }; } };
  const s = await scenario({ withServer: true, providers }).start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('rf', T1);
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'rf', tool_call_id: 'g', source_identity: 'pre:rf:g' });
    s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: 'https://github.com/acme/demo/pull/9', provider: 'github', state: 'open' } }, { session_id: 'rf', tool_call_id: 'g', source_identity: 'post:rf:g' });
    s.w.tick();
    const c = await s.client();
    const before = s.w.state.lastSync;
    s.advance(60_000);
    await c.post('/v1/requests', { id: RID(30), kind: 'refresh', payload: {} });
    await c.post('/v1/requests', { id: RID(31), kind: 'refresh', payload: {} });
    await s.settle();
    const r1 = s.w.state.requests.get(RID(30));
    const r2 = s.w.state.requests.get(RID(31));
    assert.equal(r1.state, 'applied');
    assert.equal(r1.result.run_id, r2.result.run_id, 'duplicate refresh joined the same run');
    assert.notEqual(s.w.state.lastSync, before);
    // simulate a run failure in the reconciliation path
    fail = true;
    s.advance(60_000);
    await c.post('/v1/requests', { id: RID(32), kind: 'refresh', payload: {} });
    await s.settle();
    assert.equal(s.w.state.requests.get(RID(32)).state, 'failed');
    assert.equal(s.w.state.requests.get(RID(32)).error.retryable, true);
    fail = false;
    await c.post('/v1/requests', { id: RID(33), kind: 'refresh', payload: {}, retry_of: RID(32) });
    await s.settle();
    assert.equal(s.w.state.requests.get(RID(33)).state, 'applied');
  } finally { await s.stop(); }
});

test('A31 a crash with an applying request resolves to applied or safe re-evaluation on restart, never permanent pending', async () => {
  const s = await scenario({ withServer: true }).start();
  try {
    const t = s.ticket(T1, 'LOCAL-a-00000001');
    const c = await s.client();
    await c.post('/v1/requests', { id: RID(40), kind: 'set-next-action', target_id: T1, expected_revision: t.revision, payload: { next_action: 'recover' } });
    s.w.emit('request-tx', { request_id: RID(40), outcome: 'applying' }, { source_identity: `request-tx:${RID(40)}:applying` });
    await s.stop({ flush: false });
    await s.start();
    assert.equal(s.w.state.requests.get(RID(40)).state, 'applied');
    assert.equal(s.w.state.tickets.get(T1).next_action, 'recover');
    // a second applying request whose expected revision is now stale re-evaluates to conflict
    await s.client();
    s.w.emit('request', { id: RID(41), kind: 'set-next-action', target_id: T1, expected_revision: t.revision, payload: { next_action: 'stale' }, created_at: s.iso(), not_before: s.iso(), actor_id: 'test' }, { source_identity: `request:${RID(41)}` });
    s.w.emit('request-tx', { request_id: RID(41), outcome: 'applying' }, { source_identity: `request-tx:${RID(41)}:applying` });
    await s.stop({ flush: false });
    await s.start();
    assert.equal(s.w.state.requests.get(RID(41)).state, 'conflict');
    assert.equal(s.w.state.tickets.get(T1).next_action, 'recover');
  } finally { await s.stop(); }
});

test('A32 export contains exactly the selected fields/projects, no secrets, local paths, private links or mutation code, and shows fixed export and sync times', async () => {
  const s = await scenario({ withServer: true }).start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('x1', T1);
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'see C:\\Users\\me\\secret.txt' }, source: 'manual' });
    s.w.tick();
    const snap = s.w.publishGeneration();
    const html = buildStaticHtml(snap, { exportedAt: s.iso(), fields: ['key', 'title', 'status'] });
    for (const needle of ['/v1/requests', 'st_owner', 'x-quill-csrf', 'C:\\\\Users', 'secret.txt', 'quill://', s.storePath.replace(/\\/g, '\\\\')]) assert.equal(html.includes(needle), false, needle);
    const embedded = JSON.parse(/window\.__SNAPSHOT__ = (.*?);<\/script>/s.exec(html)[1]);
    assert.equal(embedded.meta.exported_at, s.iso());
    assert.equal(embedded.meta.last_sync, snap.meta.last_sync);
    assert.equal(embedded.tickets[0].next_action, undefined);
    assert.equal(embedded.capabilities.edit_tickets, false);
    assert.equal(embedded.sessions[0].cwd, undefined);
    const c = await s.client();
    const preview = await (await c.get('/v1/export/preview?fields=key,title&projects=demo')).json();
    assert.deepEqual(preview.fields, ['key', 'title']);
    assert.equal(preview.ticket_count, 1);
  } finally { await s.stop(); }
});
