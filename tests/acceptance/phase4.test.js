// Phase 4 — handoff (ACCEPTANCE.md A35, A36, A37, A39, A41). A38 (real 20-minute wall clock) and
// A40 (real push/draft PR) need live infrastructure and are recorded as pending manual checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scenario, T1, T2, RID, until } from './scenario.js';
import { validateRequestBody } from '../../src/server/requests.js';
import { allowedToolsFor } from '../../src/handoff/runner.js';
import { nextDispatchable } from '../../src/handoff/reserve.js';
import { makeRepo } from '../handoff/helpers.js';

const analyse = { mode: 'analyse', note: '', permissions: { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false } };
const fix = { mode: 'attempt-fix', note: 'fix', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false } };

function queue(s, id, ticketId, payload) {
  const t = s.w.state.tickets.get(ticketId);
  s.ingest('request', { id, kind: 'handoff', target_id: ticketId, expected_revision: t.revision, payload, created_at: s.iso(), not_before: s.iso(), actor_id: 'test', body_hash: id }, { source_identity: `request:${id}` });
  s.w.tick();
  return s.w.state.requests.get(id);
}

test('A35 source-off analysis never reads local source; attempt-fix without read/edit is rejected; no commit, push or PR without each explicit dependent permission', async () => {
  const s = await scenario({ withHandoff: true }).start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    assert.throws(() => validateRequestBody({ id: RID(1), kind: 'handoff', target_id: T1, expected_revision: 1, payload: { mode: 'attempt-fix', permissions: { read_source: true } } }, s.w.state, s.iso()), (e) => e.code === 'permission-required');
    assert.throws(() => validateRequestBody({ id: RID(1), kind: 'handoff', target_id: T1, expected_revision: 1, payload: { mode: 'analyse', permissions: { commit: true } } }, s.w.state, s.iso()), (e) => e.code === 'permission-dependency');
    assert.throws(() => validateRequestBody({ id: RID(1), kind: 'handoff', target_id: T1, expected_revision: 1, payload: { mode: 'attempt-fix', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true }, branch: 'main' } }, s.w.state, s.iso()), (e) => e.code === 'branch-protected');
    assert.throws(() => validateRequestBody({ id: RID(1), kind: 'handoff', target_id: T1, expected_revision: 1, payload: { mode: 'attempt-fix', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }, branch: 'feat/x' } }, { ...s.w.state, meta: { ...s.w.state.meta, repos: { demo: { ...s.w.state.meta.repos.demo, provider: null } } } }, s.iso()), (e) => e.code === 'provider-required');
    const tools = allowedToolsFor({ mode: 'analyse', permissions: analyse.permissions });
    for (const t of ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']) assert.ok(tools.disallowed.includes(t), `${t} disallowed without source access`);
    const r = queue(s, RID(2), T1, analyse);
    const hid = r.result.handoff_id;
    const done = await until(() => { s.w.tick(); const h = s.w.state.handoffs.get(hid); return h.state === 'done' ? h : null; });
    const log = fs.readFileSync(done.log_path, 'utf8');
    assert.match(log, /sandbox/);
    assert.equal(done.worktree_path, null);
    assert.equal(done.commit_sha, null);
    assert.equal(done.pr_url, null);
  } finally { await s.stop(); }
});

test('A36 a fix uses an isolated base-commit worktree and leaves the live dirty checkout unchanged; denied worktree setup fails instead of silently becoming note-only', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, 'src.js'), 'export const a = 2; // live dirty\n');
  const s = await scenario({ withHandoff: true, handoffOpts: { spawnEnv: { FAKE_CLAUDE_EDIT: 'src.js' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', canonical_path: repo.dir, default_branch: 'main', deployment_environments: ['production'], provider: null } } }).start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    const r = queue(s, RID(3), T1, fix);
    const hid = r.result.handoff_id;
    const done = await until(() => { s.w.tick(); const h = s.w.state.handoffs.get(hid); return ['done', 'failed'].includes(h.state) ? h : null; });
    assert.equal(done.state, 'done');
    assert.equal(done.base_commit, repo.head);
    assert.deepEqual(done.changed_files, ['src.js']);
    assert.equal(fs.readFileSync(path.join(repo.dir, 'src.js'), 'utf8'), 'export const a = 2; // live dirty\n');
  } finally { await s.stop(); }
  const broken = await scenario({ withHandoff: true, repos: { demo: { project_id: 'demo', display_name: 'demo', canonical_path: path.join(repo.dir, 'does-not-exist'), default_branch: 'main', deployment_environments: ['production'], provider: null } } }).start();
  try {
    broken.ticket(T1, 'LOCAL-a-00000001');
    const r = queue(broken, RID(4), T1, fix);
    const hid = r.result.handoff_id;
    const failed = await until(() => { broken.w.tick(); const h = broken.w.state.handoffs.get(hid); return ['done', 'failed'].includes(h.state) ? h : null; });
    assert.equal(failed.state, 'failed');
    assert.match(failed.error.code, /repo-unavailable|worktree-failed/);
  } finally { await broken.stop(); }
});

test('A37 concurrent requests cannot reserve two runs for one ticket; fixes to one repo serialize; duplicate result delivery does not duplicate children', async () => {
  const s = await scenario({ withHandoff: true }).start();
  try {
    s.hext.pause();
    s.ticket(T1, 'LOCAL-a-00000001');
    s.ticket(T2, 'LOCAL-b-00000002');
    const a = queue(s, RID(5), T1, analyse);
    const b = queue(s, RID(6), T1, analyse);
    assert.equal(a.state, 'applied');
    assert.equal(b.state, 'failed');
    assert.equal(b.error.code, 'handoff-reserved');
    queue(s, RID(7), T2, fix);
    const t3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    s.ticket(t3, 'LOCAL-c-00000003');
    queue(s, RID(8), t3, fix);
    const dispatchable = nextDispatchable(s.w.state, { running: new Set() });
    assert.equal(dispatchable.filter((h) => h.mode === 'attempt-fix').length, 1, 'only one fix per repo dispatches at a time');
    s.hext.resume();
    const followups = { mode: 'analyse-followups', note: '', permissions: analyse.permissions };
    const t4 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    s.ticket(t4, 'LOCAL-d-00000004');
    const r = queue(s, RID(9), t4, followups);
    const hid = r.result.handoff_id;
    const done = await until(() => { s.w.tick(); const h = s.w.state.handoffs.get(hid); return h.state === 'done' ? h : null; }, { timeoutMs: 15000 });
    const { recordResult } = await import('../../src/handoff/results.js');
    recordResult(s.w, hid, { summary: 'again', children: [{ title: 'Add fake timers to retry tests' }, { title: 'Document retry timing contract' }] });
    assert.equal(s.w.state.tickets.get(t4).children_ids.length, 2);
    assert.equal(done.children_ids.length, 2);
  } finally { await s.stop(); }
});

test('A39 a worker restart during a run leaves it failed/interrupted with no automatic rerun; uncertain remote effects are recorded for reconciliation before any retry', async () => {
  const s = await scenario({ withHandoff: true, handoffOpts: { spawnEnv: { FAKE_CLAUDE_SLEEP_MS: '5000' } } }).start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    const r = queue(s, RID(10), T1, analyse);
    const hid = r.result.handoff_id;
    await until(() => { s.w.tick(); return s.w.state.handoffs.get(hid).state === 'running'; });
    await s.stop({ flush: false, abandonRuns: true });
    await s.start();
    const h = s.w.state.handoffs.get(hid);
    assert.equal(h.state, 'failed');
    assert.equal(h.error.code, 'interrupted');
    s.w.tick();
    assert.equal(nextDispatchable(s.w.state, { running: new Set() }).length, 0, 'no automatic rerun');
    s.w.emit('handoff-tx', { handoff_id: hid, update: { uncertain_effects: ['push may have partially happened'] } }, { source_identity: `handoff-tx:${hid}:uncertain` });
    assert.deepEqual(s.w.state.handoffs.get(hid).uncertain_effects, ['push may have partially happened']);
    const retry = queue(s, RID(11), T1, { ...analyse, retry_of: hid });
    assert.equal(retry.state, 'applied');
    assert.notEqual(retry.result.handoff_id, hid, 'an explicit retry is a new run referencing the previous one');
  } finally { await s.stop(); }
});

test('A41 a parent that changes during a handoff makes the proposed next action conflict while newer owner fields remain; missing runtime fails at dispatch with a reason', async () => {
  const s = await scenario({ withHandoff: true }).start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    const r = queue(s, RID(12), T1, { mode: 'analyse-followups', note: '', permissions: analyse.permissions });
    const hid = r.result.handoff_id;
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'owner wins' }, source: 'manual' });
    const done = await until(() => { s.w.tick(); const h = s.w.state.handoffs.get(hid); return h.state === 'done' ? h : null; });
    assert.equal(s.w.state.tickets.get(T1).next_action, 'owner wins');
    assert.ok(done.uncertain_effects.some((u) => /next_action/.test(u)));
  } finally { await s.stop(); }
  const noRuntime = await scenario({ withHandoff: true, handoffOpts: { runtimeAvailable: false } }).start();
  try {
    noRuntime.ticket(T1, 'LOCAL-a-00000001');
    const r = queue(noRuntime, RID(13), T1, analyse);
    const hid = r.result.handoff_id;
    const h = await until(() => { noRuntime.w.tick(); const x = noRuntime.w.state.handoffs.get(hid); return x.state === 'failed' ? x : null; });
    assert.equal(h.error.code, 'runtime-missing');
    assert.match(h.error.message, /not installed/);
  } finally { await noRuntime.stop(); }
});
