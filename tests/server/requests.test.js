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
