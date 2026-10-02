// Phase 9 — per-environment deployments, Today and the digest (ADR 0009). Each test is named after
// its ACCEPTANCE.md scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scenario, T1 } from './scenario.js';
import { runReconciliation } from '../../src/reconcile/run.js';
import { sanitizeSnapshot } from '../../src/export/sanitize.js';

const merged = { state: 'merged', opened_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T06:00:00Z' };
const providers = { for: () => ({ name: 'github', fetchPr: async () => merged }) };
const snap = async (c) => (await c.get('/v1/snapshot')).json();

function withPr(s, session = 'pr1') {
  s.bind(session, T1);
  s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: session, tool_call_id: 'g1', source_identity: `pre:${session}:g1` });
  s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: 'https://github.com/acme/demo/pull/1', provider: 'github', state: 'open' } }, { session_id: session, tool_call_id: 'g1', source_identity: `post:${session}:g1` });
  s.w.tick();
}

test('A57 tracker environments create one obligation per environment; recorded evidence kinds and N/A show per environment; the ticket leaves Deployments only when every obligation is resolved', async () => {
  const s = scenario({ providers, withServer: true, startMs: Date.parse('2026-10-02T08:00:00Z'), repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', provider: 'github' } } });
  s.config.tracker = { system: 'jira', domain: 'https://example.atlassian.net', environments: ['stage', 'prod'] };
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    withPr(s);
    await runReconciliation(s.w, { providers });
    const c = await s.client();
    let view = await snap(c);
    let t = view.tickets.find((x) => x.id === T1);
    assert.equal(t.status, 'deploy-pending');
    assert.deepEqual(t.environments.map((e) => [e.environment, e.state]), [['stage', 'pending'], ['prod', 'pending']]);
    const stage = t.deployments.find((d) => d.environment === 'stage');
    const prod = t.deployments.find((d) => d.environment === 'prod');
    const res = await c.post('/v1/requests', { id: randomUUID(), kind: 'record-deployment', target_id: T1, expected_revision: t.revision, payload: { items: [{ pr_id: stage.pr_id, environment: 'stage', deployed_at: '2026-10-02T07:30:00Z', evidence: 'stage sync 41', evidence_kind: 'argocd' }] } });
    assert.equal(res.status, 202);
    s.advance(11_000);
    await s.settle();
    view = await snap(c);
    t = view.tickets.find((x) => x.id === T1);
    assert.deepEqual(t.environments.map((e) => [e.environment, e.state, e.evidence_kind]), [['stage', 'done', 'argocd'], ['prod', 'pending', null]]);
    assert.equal(view.deployments_outstanding.filter((d) => d.ticket_id === T1).length, 1, 'still on Deployments while prod is pending');
    await c.post('/v1/requests', { id: randomUUID(), kind: 'record-deployment', target_id: T1, expected_revision: t.revision, payload: { items: [{ pr_id: prod.pr_id, environment: 'prod', waiver_reason: 'not applicable: internal tool' }] } });
    s.advance(11_000);
    await s.settle();
    await runReconciliation(s.w, { providers });
    view = await snap(c);
    t = view.tickets.find((x) => x.id === T1);
    assert.deepEqual(t.environments.map((e) => e.state), ['done', 'n-a']);
    assert.equal(view.deployments_outstanding.filter((d) => d.ticket_id === T1).length, 0);
    assert.equal(t.status, 'done');
  } finally { await s.stop(); }
});

test('A58 Today groups the week by store-local day and ticket, newest first, leaves tool calls out, and is not exported', async () => {
  const s = await scenario({ timezone: 'Asia/Kolkata', startMs: Date.parse('2026-10-02T19:00:00Z') }).start();
  try {
    s.ticket(T1, 'PROJ-1');
    s.bind('sess', T1);
    s.ingest('pre-tool', { tool_name: 'Write' }, { session_id: 'sess', tool_call_id: 'w1', source_identity: 'pre:w1' });
    s.ingest('post-tool', { tool_name: 'Write', write_paths: ['a.js'], repo_id: 'demo', success: true }, { session_id: 'sess', tool_call_id: 'w1', source_identity: 'post:w1' });
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'sess', tool_call_id: 'b1', source_identity: 'pre:b1' });
    s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true }, { session_id: 'sess', tool_call_id: 'b1', source_identity: 'post:b1' });
    s.w.tick();
    const view = s.w.publishGeneration();
    assert.equal(view.today.generated_for, '2026-10-03', '19:00 UTC is already the 3rd in Kolkata');
    const day = view.today.days[0];
    assert.equal(day.date, '2026-10-03');
    assert.equal(day.tickets[0].key, 'PROJ-1');
    assert.ok(day.tickets[0].counts.write >= 1);
    assert.ok(!day.tickets[0].items.some((i) => i.kind === 'tool'));
    assert.ok(!('today' in sanitizeSnapshot(view, { fields: ['key', 'title'] })));
  } finally { await s.stop(); }
});

test('A59 a digest schedule writes the day into the store\'s daily note at its slot, keeps the owner\'s text, and fails visibly instead of overwriting an edited digest', async () => {
  const s = scenario({ timezone: 'UTC', startMs: Date.parse('2026-10-02T19:29:00Z') });
  s.config.schedule = [{ name: 'evening-digest', job: 'digest', cron: '30 19 * * *', to: ['vault-daily'] }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1', { title: 'Retry flake' });
    s.bind('sess', T1);
    s.advance(60_000);
    await s.settle();
    const note = path.join(s.storePath, 'daily', '2026-10-02.md');
    assert.match(fs.readFileSync(note, 'utf8'), /PROJ-1\*\* Retry flake/);
    assert.equal(s.w.state.schedules.get('evening-digest').last_outcome, 'ok');
    fs.writeFileSync(note, `# Thursday\nmy own line\n\n${fs.readFileSync(note, 'utf8').replace('Retry flake', 'Retry flake!!')}`);
    s.advance(24 * 3600_000);
    await s.settle();
    const rec = s.w.state.schedules.get('evening-digest');
    assert.equal(rec.last_outcome, 'ok', 'a new day writes a new note');
    assert.match(fs.readFileSync(note, 'utf8'), /my own line/);
    const next = path.join(s.storePath, 'daily', '2026-10-03.md');
    fs.writeFileSync(next, fs.readFileSync(next, 'utf8').replace('No tracked activity.', 'edited'));
    const before = rec.runs.length;
    const { submitRequest } = await import('../../src/server/requests.js');
    submitRequest(s.w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'evening-digest' } });
    await s.settle();
    const after = s.w.state.schedules.get('evening-digest');
    assert.equal(after.runs.length, before + 1);
    assert.deepEqual([after.last_outcome, /was edited after Quill wrote it/.test(after.last_error)], ['failed', true]);
    assert.match(fs.readFileSync(next, 'utf8'), /edited/);
  } finally { await s.stop(); }
});

test('A60 Pick next explains a fresh merge awaiting deployment and days since last touch', async () => {
  const s = await scenario({ providers, startMs: Date.parse('2026-10-02T08:00:00Z') }).start();
  try {
    s.ticket(T1, 'PROJ-1');
    withPr(s);
    await runReconciliation(s.w, { providers });
    s.ticket('eeeeeeee-0000-4000-8000-000000000002', 'PROJ-2');
    s.advance(3 * 24 * 3600_000);
    s.w.tick();
    const view = s.w.publishGeneration();
    const p1 = view.picknext.find((p) => p.ticket_id === T1);
    const p2 = view.picknext.find((p) => p.ticket_id === 'eeeeeeee-0000-4000-8000-000000000002');
    assert.ok(p1.reasons.some((r) => /Merged PR awaiting deployment for 3 day\(s\): \+20/.test(r)), p1.reasons.join('; '));
    assert.ok(p2.reasons.some((r) => /^Untouched for 3 days: \+3$/.test(r)), p2.reasons.join('; '));
  } finally { await s.stop(); }
});
