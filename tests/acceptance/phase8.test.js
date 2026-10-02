// Phase 8 — agent recipes (ADR 0008). Each test is named after its ACCEPTANCE.md scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scenario, until, T1 } from './scenario.js';
import { createJobs } from '../../src/schedule/jobs.js';
import { makeRepo } from '../handoff/helpers.js';

const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };
const RESULT = { summary: 'Staging has v1.4; production pending.', next_action: 'Promote v1.4 to production', deploy_evidence: [{ environment: 'production', state: 'deployed', evidence: 'values.yaml v1.4', deployed_at: '2026-10-02T07:00:00Z' }], comment_draft: 'Live on production.' };

function repoDir() {
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, '.quill', 'agents'), { recursive: true });
  return dir;
}

async function start(extra = {}) {
  const dir = repoDir();
  const s = await scenario({ withHandoff: true, handoffOpts: { spawnEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT) } }, repos: { demo: { project_id: 'demo', display_name: 'demo', canonical_path: dir, default_branch: 'main', deployment_environments: ['production'], provider: 'github' } }, ...extra }).start();
  return { s, dir };
}

const post = (c, body) => c.post('/v1/requests', { id: randomUUID(), ...body });

test('A53 repository recipes override personal and built-in ones of the same name; the snapshot lists effective recipes without paths; an invalid recipe cannot be queued', async () => {
  const { s, dir } = await start();
  try {
    fs.mkdirSync(path.join(s.home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(s.home, 'agents', 'standup.md'), '---\nname: standup\ndescription: Personal standup\n---\nMine for {{ticket.key}}');
    fs.writeFileSync(path.join(dir, '.quill', 'agents', 'standup.md'), '---\nname: standup\ndescription: Team standup\n---\nTeam format for {{ticket.key}}');
    fs.writeFileSync(path.join(dir, '.quill', 'agents', 'risky.md'), '---\nname: risky\ndescription: x\npermissions: { push: true }\n---\nx');
    s.w.recipeCatalog = null;
    const t = s.ticket(T1, 'PROJ-1');
    const c = await s.client();
    s.w.publishGeneration();
    const snap = await (await c.get('/v1/snapshot')).json();
    const repoStandup = snap.recipes.find((r) => r.name === 'standup' && r.repo_id === 'demo');
    assert.equal(repoStandup.description, 'Team standup');
    assert.equal(snap.recipes.find((r) => r.name === 'standup' && r.repo_id === null).description, 'Personal standup');
    assert.match(snap.recipes.find((r) => r.name === 'risky').error, /push_branch requires commit/);
    assert.ok(!JSON.stringify(snap.recipes).includes(dir) && !JSON.stringify(snap.recipes).includes(s.home));
    const res = await post(c, { kind: 'handoff', target_id: T1, expected_revision: t.revision, payload: { recipe: 'risky', note: '', permissions: NONE } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'recipe-invalid');
  } finally { await s.stop(); }
});

test('A54 a recipe run gets no more than its frontmatter, runs with its tools and time cap, and a recipe edited after queueing fails at dispatch', async () => {
  const { s, dir } = await start();
  try {
    const t = s.ticket(T1, 'PROJ-1');
    const c = await s.client();
    const beyond = await post(c, { kind: 'handoff', target_id: T1, expected_revision: t.revision, payload: { recipe: 'deploy-check', note: '', permissions: { ...NONE, read_source: true, edit_source: true } } });
    assert.equal(beyond.status, 400);
    assert.equal((await beyond.json()).error.code, 'permission-beyond-recipe');
    const ok = await post(c, { kind: 'handoff', target_id: T1, expected_revision: t.revision, payload: { recipe: 'deploy-check', note: '', permissions: { ...NONE, read_source: true } } });
    assert.equal(ok.status, 202);
    s.w.tick();
    const h = await until(() => { s.w.tick(); return [...s.w.state.handoffs.values()].find((x) => x.state === 'done'); });
    assert.equal(Date.parse(h.deadline_at) - Date.parse(h.started_at), 10 * 60_000);
    assert.match(fs.readFileSync(h.log_path, 'utf8'), /--allowedTools Read Grep Glob Bash\(git log:\*\) Bash\(git show:\*\)/);
    fs.writeFileSync(path.join(dir, '.quill', 'agents', 'triage.md'), '---\nname: triage\ndescription: Triage\npermissions: { read_source: true }\n---\nTriage {{ticket.key}}');
    s.hext.pause();
    const t2 = s.w.state.tickets.get(T1);
    const queued = await post(c, { kind: 'handoff', target_id: T1, expected_revision: t2.revision, payload: { recipe: 'triage', note: '', permissions: NONE } });
    assert.equal(queued.status, 202);
    s.w.tick();
    fs.appendFileSync(path.join(dir, '.quill', 'agents', 'triage.md'), '\nAlso push everything.');
    s.hext.resume();
    const failed = await until(() => { s.w.tick(); return [...s.w.state.handoffs.values()].find((x) => x.recipe && x.recipe.name === 'triage' && x.state === 'failed'); });
    assert.equal(failed.error.code, 'recipe-changed');
  } finally { await s.stop(); }
});

test('A55 typed outputs arrive as suggestions; nothing changes until a revision-checked accept; a comment draft is only marked used', async () => {
  const { s } = await start();
  try {
    const t = s.ticket(T1, 'PROJ-1');
    s.w.state.tickets.get(T1).deployments.push({ id: 'd1', pr_id: 'pr1', environment: 'production', state: 'pending', merged_at: '2026-10-01T12:00:00Z', deployed_at: null, evidence: null, waiver_reason: null, source_event_id: null });
    const c = await s.client();
    await post(c, { kind: 'handoff', target_id: T1, expected_revision: t.revision, payload: { recipe: 'deploy-check', note: '', permissions: { ...NONE, read_source: true } } });
    s.w.tick();
    const h = await until(() => { s.w.tick(); return [...s.w.state.handoffs.values()].find((x) => x.state === 'done'); });
    assert.deepEqual(h.suggestions.map((x) => x.type), ['next-action', 'deploy-evidence']);
    assert.equal(s.w.state.tickets.get(T1).next_action, '');
    const rev = s.w.state.tickets.get(T1).revision;
    const stale = await post(c, { kind: 'accept-suggestion', target_id: T1, expected_revision: rev - 1, payload: { handoff_id: h.id, suggestion_id: 's1' } });
    assert.equal(stale.status, 202);
    for (const sid of ['s1', 's2']) assert.equal((await post(c, { kind: 'accept-suggestion', target_id: T1, expected_revision: rev, payload: { handoff_id: h.id, suggestion_id: sid } })).status, 202);
    s.advance(11_000);
    await s.settle();
    let ticket = s.w.state.tickets.get(T1);
    assert.equal(ticket.next_action, 'Promote v1.4 to production');
    assert.equal(ticket.deployments.find((d) => d.id === 'd1').state, 'pending');
    assert.equal([...s.w.state.requests.values()].filter((r) => r.kind === 'accept-suggestion' && r.state === 'conflict').length, 2, 'the stale accept and the second accept (after the first changed the ticket) both conflict');
    assert.equal(s.w.state.handoffs.get(h.id).suggestions.find((x) => x.id === 's2').state, 'proposed', 'a conflicted accept leaves the suggestion open');
    assert.equal((await post(c, { kind: 'accept-suggestion', target_id: T1, expected_revision: ticket.revision, payload: { handoff_id: h.id, suggestion_id: 's2' } })).status, 202);
    s.advance(11_000);
    await s.settle();
    ticket = s.w.state.tickets.get(T1);
    assert.deepEqual([ticket.deployments.find((d) => d.id === 'd1').state, ticket.deployments.find((d) => d.id === 'd1').evidence], ['deployed', 'values.yaml v1.4']);
    // A comment draft is never sent anywhere: accepting it records that it was used, nothing more.
    fs.mkdirSync(path.join(s.home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(s.home, 'agents', 'comment.md'), '---\nname: comment\ndescription: Draft a tracker comment\noutputs: [comment_draft]\n---\nDraft a comment for {{ticket.key}}');
    await post(c, { kind: 'handoff', target_id: T1, expected_revision: ticket.revision, payload: { recipe: 'comment', note: '', permissions: NONE } });
    s.w.tick();
    const h2 = await until(() => { s.w.tick(); return [...s.w.state.handoffs.values()].find((x) => x.recipe.name === 'comment' && x.state === 'done'); });
    assert.deepEqual(h2.suggestions.map((x) => [x.type, x.text]), [['comment-draft', 'Live on production.']]);
    const before = s.w.state.tickets.get(T1);
    await post(c, { kind: 'accept-suggestion', target_id: T1, expected_revision: before.revision, payload: { handoff_id: h2.id, suggestion_id: 's1' } });
    s.advance(11_000);
    await s.settle();
    assert.equal(s.w.state.handoffs.get(h2.id).suggestions[0].state, 'accepted');
    assert.deepEqual([s.w.state.tickets.get(T1).revision, s.w.state.tickets.get(T1).next_action], [before.revision, before.next_action]);
  } finally { await s.stop(); }
});

test('A56 a scheduled agent job queues read-only runs for the tickets in scope, skips tickets already running and refuses source-editing recipes', async () => {
  const { s } = await start();
  try {
    s.hext.pause();
    for (const [id, key] of [[T1, 'PROJ-1'], ['dddddddd-0000-4000-8000-000000000002', 'PROJ-2']]) {
      s.ticket(id, key);
      s.w.emit('ticket-update', { ticket_id: id, fields: { status: 'active' }, source: 'manual' });
    }
    const jobs = createJobs({ providers: null });
    const first = await jobs.agent(s.w, { schedule: 'standups', settings: { recipe: 'deploy-check', scope: 'active', limit: 10 } });
    assert.equal(first.summary, 'queued 2 deploy-check runs');
    s.w.tick();
    const runs = [...s.w.state.handoffs.values()];
    assert.ok(runs.every((h) => h.permissions.read_source && !h.permissions.edit_source && !h.permissions.commit && !h.permissions.push_branch && !h.permissions.open_draft_pr));
    const again = await jobs.agent(s.w, { schedule: 'standups', settings: { recipe: 'deploy-check', scope: 'active', limit: 10 } });
    assert.equal(again.summary, 'queued 0 deploy-check runs (2 already running)');
    await assert.rejects(jobs.agent(s.w, { schedule: 'fixes', settings: { recipe: 'attempt-fix', scope: 'active', limit: 10 } }), /cannot run on a schedule/);
  } finally { await s.stop(); }
});
