import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequestBody, EDIT_DELAY_MS } from '../../src/server/requests.js';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { newState, createTicket } from '../core/helpers.js';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-10-02T08:00:00Z';
const id = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function stateWithTicket(extra = {}) {
  const state = newState();
  const t = createTicket(state);
  Object.assign(t, extra);
  return { state, t };
}

test('ticket edits require a known target and expected_revision; not_before is created_at + 10 s', () => {
  const { state, t } = stateWithTicket();
  const r = validateRequestBody({ id, kind: 'set-next-action', target_id: T1, expected_revision: t.revision, payload: { next_action: 'Do it' } }, state, NOW);
  assert.equal(r.not_before, '2026-10-02T08:00:10Z');
  assert.equal(EDIT_DELAY_MS, 10_000);
  assert.throws(() => validateRequestBody({ id, kind: 'set-next-action', target_id: T1, payload: { next_action: 'x' } }, state, NOW), (e) => e.code === 'expected-revision-required');
  assert.throws(() => validateRequestBody({ id, kind: 'set-next-action', target_id: 'nope', expected_revision: 1, payload: { next_action: 'x' } }, state, NOW), (e) => e.code === 'target-unknown');
  assert.throws(() => validateRequestBody({ id: 'not-a-uuid', kind: 'refresh', payload: {} }, state, NOW), (e) => e.code === 'request-invalid');
  assert.throws(() => validateRequestBody({ id, kind: 'teleport', payload: {} }, state, NOW), (e) => e.code === 'kind-invalid');
});

test('refresh and handoff have no undo delay', () => {
  const { state, t } = stateWithTicket();
  assert.equal(validateRequestBody({ id, kind: 'refresh', payload: {} }, state, NOW).not_before, NOW);
  const h = validateRequestBody({ id, kind: 'handoff', target_id: T1, expected_revision: t.revision, payload: { mode: 'analyse', note: 'look', permissions: {} } }, state, NOW);
  assert.equal(h.not_before, NOW);
});

test('set-status validation: blocked needs blocker; done with pending deployments needs an explicit choice', () => {
  const { state, t } = stateWithTicket({ deployments: [{ id: 'd1', pr_id: 'p1', environment: 'production', state: 'pending', merged_at: NOW }] });
  const base = { id, kind: 'set-status', target_id: T1, expected_revision: t.revision };
  assert.throws(() => validateRequestBody({ ...base, payload: { status: 'blocked' } }, state, NOW), (e) => e.code === 'blocker-required');
  assert.throws(() => validateRequestBody({ ...base, payload: { status: 'done' } }, state, NOW), (e) => e.code === 'deployment-choice-required');
  assert.throws(() => validateRequestBody({ ...base, payload: { status: 'done', deployment_choice: 'waive', deployments: [{ pr_id: 'p1', environment: 'production' }] } }, state, NOW), (e) => e.code === 'waiver-reason-required');
  assert.doesNotThrow(() => validateRequestBody({ ...base, payload: { status: 'done', deployment_choice: 'leave' } }, state, NOW));
  assert.doesNotThrow(() => validateRequestBody({ ...base, payload: { status: 'done', deployment_choice: 'record', deployments: [{ pr_id: 'p1', environment: 'production', deployed_at: NOW, evidence: 'release 1.2' }] } }, state, NOW));
  assert.throws(() => validateRequestBody({ ...base, payload: { status: 'parked' } }, state, NOW), (e) => e.code === 'status-invalid');
});

test('record-deployment names each obligation with evidence or waiver reason', () => {
  const { state, t } = stateWithTicket({ deployments: [{ id: 'd1', pr_id: 'p1', environment: 'production', state: 'pending', merged_at: NOW }] });
  const base = { id, kind: 'record-deployment', target_id: T1, expected_revision: t.revision };
  assert.throws(() => validateRequestBody({ ...base, payload: { items: [] } }, state, NOW), (e) => e.code === 'request-invalid');
  assert.throws(() => validateRequestBody({ ...base, payload: { items: [{ pr_id: 'p1', environment: 'staging', deployed_at: NOW }] } }, state, NOW), (e) => e.code === 'obligation-missing');
  const ok = validateRequestBody({ ...base, payload: { items: [{ pr_id: 'p1', environment: 'production', waiver_reason: 'not needed' }] } }, state, NOW);
  assert.equal(ok.payload.items[0].state, 'waived');
});

test('handoff permission rules', () => {
  const repo = { id: 'demo', default_branch: 'main', provider: null };
  assert.throws(() => validateHandoffRequest({ mode: 'attempt-fix', note: '', permissions: { read_source: false, edit_source: false } }, { repo }), (e) => e.code === 'permission-required');
  assert.throws(() => validateHandoffRequest({ mode: 'analyse', note: 'x'.repeat(281), permissions: {} }, { repo }), (e) => e.code === 'note-too-long');
  assert.throws(() => validateHandoffRequest({ mode: 'analyse', note: '', permissions: { commit: true } }, { repo }), (e) => e.code === 'permission-dependency');
  assert.throws(() => validateHandoffRequest({ mode: 'attempt-fix', note: '', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, branch: 'main' } }, { repo }), (e) => e.code === 'branch-protected');
  assert.throws(() => validateHandoffRequest({ mode: 'attempt-fix', note: '', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, branch: 'feat/x', open_draft_pr: true } }, { repo }), (e) => e.code === 'provider-required');
  const ok = validateHandoffRequest({ mode: 'attempt-fix', note: 'fix it', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, branch: 'feat/x', open_draft_pr: true } }, { repo: { ...repo, provider: 'github' } });
  assert.deepEqual(Object.keys(ok.permissions).sort(), ['commit', 'delete_files', 'edit_files', 'edit_source', 'open_draft_pr', 'push_branch', 'read_source']);
  assert.equal(ok.branch, 'feat/x');
  const def = validateHandoffRequest({}, { repo });
  assert.equal(def.mode, 'analyse-followups');
  assert.equal(def.permissions.read_source, false);
  assert.throws(() => validateHandoffRequest({ mode: 'attempt-fix', permissions: { read_source: true, edit_source: true } }, { repo: null }), (e) => e.code === 'repo-required');
});

// Write scopes (spec §4.3, Task 11): validated against the scope catalog when the request is made
// and again when it applies; the queued record copies them.
test('handoff scopes: refused with standard access, unknown scopes refused, the record copies the scopes', async () => {
  const fs = await import('node:fs');
  const { scopeValidator } = await import('../../src/handoff/scopes.js');
  const { bootWorker, makeRepo, until } = await import('../handoff/helpers.js');
  const { state, t } = stateWithTicket();
  const scopeCheck = scopeValidator({ scopes: { 'k8s.write': { targets: { stg: { env: { KUBECONFIG: '/rw/stg' } } } } } });
  const body = (payload) => ({ id, kind: 'handoff', target_id: T1, expected_revision: t.revision, payload: { mode: 'analyse', note: '', permissions: {}, ...payload } });
  assert.throws(() => validateRequestBody(body({ access: 'standard', scopes: ['jira.write'] }), state, NOW, { scopeCheck }), (e) => e.code === 'scope-needs-autonomous');
  assert.throws(() => validateRequestBody(body({ access: 'autonomous', scopes: ['k8s.nope'] }), state, NOW, { scopeCheck }), (e) => e.code === 'unknown-scope');
  assert.deepEqual(validateRequestBody(body({ access: 'autonomous', scopes: ['k8s.write:stg'] }), state, NOW, { scopeCheck }).payload.scopes, ['k8s.write:stg']);

  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: false, configExtra: { scopes: { 'k8s.write': { targets: { stg: { env: { KUBECONFIG: '/rw/stg' } } } } } } });
  try {
    b.ticket(T1, 'PROJ-31');
    const rid = '88888888-0000-4000-8000-000000000001';
    b.request(rid, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: { recipe: 'analyse', note: '', permissions: {}, access: 'autonomous', scopes: ['k8s.write:stg', 'jira.write'] } });
    const req = await until(() => { b.w.tick(); const r = b.w.state.requests.get(rid); return r && r.state !== 'pending' ? r : null; });
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    assert.deepEqual(b.w.state.handoffs.get(req.result.handoff_id).scopes, ['k8s.write:stg', 'jira.write']);
  } finally {
    await b.w.stop();
    for (const d of [b.home, repo.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('restore-snapshot names a snapshot of a finished run of the ticket, with the 10 s undo window', () => {
  const { state } = stateWithTicket();
  const hid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const snap = { id: 'snap-1', n: 0, step: 'agent', label: "After the agent's turn", tree: 'a'.repeat(40), commit: 'b'.repeat(40), ref: `refs/quill/snapshots/${hid}/00-agent`, files_changed: 1, at: NOW, restored_at: null, archived_at: null };
  const h = { id: hid, ticket_id: T1, state: 'done', permissions: { read_source: true, edit_source: true }, worktree_path: 'C:/q/handoffs/worktrees/x', snapshots: [snap] };
  state.handoffs.set(hid, h);
  const body = (payload) => ({ id, kind: 'restore-snapshot', target_id: T1, expected_revision: null, payload });
  const ok = validateRequestBody(body({ handoff_id: hid, snapshot_id: 'snap-1', extra: 'dropped' }), state, NOW);
  assert.deepEqual(ok.payload, { handoff_id: hid, snapshot_id: 'snap-1' });
  assert.equal(ok.not_before, '2026-10-02T08:00:10Z');
  assert.throws(() => validateRequestBody(body({ handoff_id: 'nope', snapshot_id: 'snap-1' }), state, NOW), (e) => e.code === 'handoff-unknown');
  assert.throws(() => validateRequestBody(body({ handoff_id: hid, snapshot_id: 'snap-9' }), state, NOW), (e) => e.code === 'snapshot-unknown');
  for (const st of ['queued', 'running']) {
    h.state = st;
    assert.throws(() => validateRequestBody(body({ handoff_id: hid, snapshot_id: 'snap-1' }), state, NOW), (e) => e.code === 'run-active', st);
  }
  h.state = 'failed';
  h.worktree_removed_at = NOW;
  assert.throws(() => validateRequestBody(body({ handoff_id: hid, snapshot_id: 'snap-1' }), state, NOW), (e) => e.code === 'checkout-removed');
  delete h.worktree_removed_at;
  h.snapshots = Array.from({ length: 20 }, (_, i) => ({ ...snap, id: `snap-${i + 1}`, n: i }));
  assert.throws(() => validateRequestBody(body({ handoff_id: hid, snapshot_id: 'snap-1' }), state, NOW), (e) => e.code === 'snapshot-limit');
});
