// CI watch reducer (ADR 0039): worker-only ci-observation and ci-proposal events, the run's local
// `ci` record, at most one fix proposal per head commit and two per pull request, and lapsing when
// the head changes, CI passes or the pull request is merged or closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, createTicket, ev } from './helpers.js';
import { applyEvent } from '../../src/core/reducer.js';
import { makeEvent } from '../../src/core/events.js';
import { deterministicId } from '../../src/lib/ids.js';
import { ciProposalId, ciProposalsOf, CI_PERMISSIONS } from '../../src/core/reduce/ci.js';
import { proposalState } from '../../src/publish/run-proposals.js';

const T0 = '2026-10-02T08:00:00Z';
const TID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PR = 'https://github.com/acme/app/pull/12';
const BRANCH = 'quill/pmo-7';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);

function setup({ access = 'standard' } = {}) {
  const state = newState();
  createTicket(state, { id: TID, key: 'PMO-7', title: 'Payments fix' });
  state.handoffs.set(HID, { id: HID, ticket_id: TID, state: 'done', access, permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }, pr_url: PR, branch: BRANCH, pushed_branch: BRANCH, revision: 1, changed_files: ['src/a.js'] });
  return state;
}

const worker = (state, kind, payload, extra = {}) => ev(state, kind, payload, { producer: 'worker', occurred_at: T0, ...extra });
const obs = (state, over = {}, extra = {}) => {
  const h = state.handoffs.get(HID);
  return worker(state, 'ci-observation', { handoff_id: HID, n: (h.ci ? h.ci.n : 0) + 1, pr_url: PR, head_sha: SHA1, head_branch: BRANCH, pr_state: 'draft', state: 'failing', checks: [{ name: 'test (ubuntu)', state: 'failed' }, { name: 'lint', state: 'passed' }], ...over }, extra);
};
const propose = (state, over = {}, extra = {}) => worker(state, 'ci-proposal', { id: ciProposalId(HID, over.head_sha ?? SHA1), handoff_id: HID, pr_url: PR, head_sha: SHA1, head_branch: BRANCH, failing: ['test (ubuntu)'], log_tail: 'Error: expected 1 to be 2\n  at test.js:3', log_withheld: 0, ...over }, extra);

test('an observation records the run\'s CI state locally, in order, keeping when the state began', () => {
  const state = setup();
  assert.equal(obs(state).rejected, undefined);
  const h = state.handoffs.get(HID);
  assert.deepEqual([h.ci.n, h.ci.state, h.ci.head_sha, h.ci.pr_state, h.ci.failing], [1, 'failing', SHA1, 'draft', ['test (ubuntu)']]);
  assert.equal(h.ci.since, T0);
  assert.equal(obs(state, { checks: [{ name: 'test (ubuntu)', state: 'failed' }, { name: 'lint', state: 'failed' }] }, { occurred_at: '2026-10-02T08:05:00Z' }).rejected, undefined);
  assert.equal(h.ci.since, T0, 'same commit and state: still failing since the first observation');
  assert.deepEqual(h.ci.failing, ['test (ubuntu)', 'lint']);
  // A stale or repeated number is refused, never applied out of order.
  assert.equal(worker(state, 'ci-observation', { handoff_id: HID, n: 1, pr_url: PR, head_sha: SHA2, head_branch: BRANCH, pr_state: 'open', state: 'passing', checks: [] }).rejected, 'ci-observation-out-of-order');
  assert.equal(h.ci.head_sha, SHA1);
});

test('only the worker records CI; malformed payloads and a pull request the run did not open are refused', () => {
  const state = setup();
  assert.equal(obs(state, {}, { producer: 'cli' }).rejected, 'ci-observation-source');
  assert.equal(obs(state, { state: 'green' }).rejected, 'ci-observation-invalid');
  assert.equal(obs(state, { head_sha: 'xyz' }).rejected, 'ci-observation-invalid');
  assert.equal(obs(state, { head_branch: '--force' }).rejected, 'ci-observation-invalid');
  assert.equal(obs(state, { pr_url: 'https://evil.example/pull/1' }).rejected, 'ci-observation-invalid');
  assert.equal(obs(state, { pr_url: 'https://github.com/acme/other/pull/3' }).rejected, 'ci-pr-mismatch');
  assert.equal(obs(state, { handoff_id: 'nope' }).rejected, 'handoff-unknown');
  assert.equal(state.handoffs.get(HID).ci, undefined);
  // Check names are tool output: kept to one bounded line.
  assert.equal(obs(state, { checks: [{ name: `a\nb${'x'.repeat(500)}`, state: 'failed' }] }).rejected, undefined);
  assert.equal(state.handoffs.get(HID).ci.checks[0].name.length, 120);
  assert.doesNotMatch(state.handoffs.get(HID).ci.checks[0].name, /\n/);
});

test('a fix proposal is staged only for the failing commit, once per commit, at most two per pull request', () => {
  const state = setup({ access: 'full' });
  assert.equal(propose(state).rejected, 'ci-not-failing', 'nothing observed yet');
  obs(state);
  assert.equal(propose(state, {}, { producer: 'hook' }).rejected, 'ci-proposal-source');
  assert.equal(propose(state, { id: 'forged' }).rejected, 'ci-id-mismatch');
  assert.equal(propose(state, { head_sha: SHA2 }).rejected, 'ci-not-failing', 'not the observed commit');
  assert.equal(propose(state, { head_branch: 'main' }).rejected, 'ci-branch-mismatch');
  assert.equal(propose(state, { log_tail: 'x'.repeat(4097) }).rejected, 'ci-proposal-invalid', 'log tail capped at 4096');
  assert.equal(propose(state).rejected, undefined);
  const p = state.runProposals.get(ciProposalId(HID, SHA1));
  assert.deepEqual([p.origin, p.from_handoff_id, p.ticket_id, p.mode, p.state, p.access], ['ci', HID, TID, 'attempt-fix', 'proposed', 'standard'], 'full access never carries over to a CI fix');
  assert.deepEqual(p.permissions, CI_PERMISSIONS);
  assert.equal(p.permissions.open_draft_pr, false);
  assert.deepEqual([p.ci.head_sha, p.ci.head_branch, p.ci.pr_url, p.ci.failing, p.ci.log_tail], [SHA1, BRANCH, PR, ['test (ubuntu)'], 'Error: expected 1 to be 2\n  at test.js:3']);
  assert.equal(propose(state).duplicate, true, 'one per head commit');
  const t = state.tickets.get(TID);
  const line = t.timeline.at(-1).text;
  assert.match(line, /CI failed on commit aaaaaaa/);
  assert.doesNotMatch(line, /test \(ubuntu\)|expected 1/, 'no check names or log text reach the timeline (and prompts)');
  // A new failing commit: a second proposal; a third commit: refused.
  obs(state, { head_sha: SHA2 });
  assert.equal(proposalState(p, t, T0), 'expired', 'the head changed');
  assert.equal(p.lapse_reason, 'head-changed');
  assert.equal(propose(state, { head_sha: SHA2 }).rejected, undefined);
  obs(state, { head_sha: SHA3 });
  assert.equal(propose(state, { head_sha: SHA3 }).rejected, 'ci-proposal-limit');
  assert.equal(ciProposalsOf(state, HID).length, 2);
});

test('an autonomous run\'s CI fix stays autonomous, without its scopes', () => {
  const state = setup({ access: 'autonomous' });
  state.handoffs.get(HID).scopes = ['k8s.write:stg'];
  obs(state);
  propose(state);
  const p = state.runProposals.get(ciProposalId(HID, SHA1));
  assert.equal(p.access, 'autonomous');
  assert.equal(p.scopes, undefined);
  assert.equal(p.action_pin, undefined);
});

test('a proposal lapses when CI passes or the pull request is merged or closed, not while checks rerun on the same commit', () => {
  for (const [over, reason] of [[{ state: 'passing' }, 'ci-passed'], [{ pr_state: 'merged', state: 'failing' }, 'pr-merged'], [{ pr_state: 'closed', state: 'pending' }, 'pr-closed']]) {
    const state = setup();
    obs(state);
    propose(state);
    const p = state.runProposals.get(ciProposalId(HID, SHA1));
    obs(state, { state: 'pending' });
    assert.equal(p.lapsed_at, null, 'a rerun on the same commit keeps the proposal');
    obs(state, over, { occurred_at: '2026-10-02T09:00:00Z' });
    assert.deepEqual([p.lapse_reason, p.lapsed_at], [reason, '2026-10-02T09:00:00Z']);
    assert.equal(proposalState(p, state.tickets.get(TID), '2026-10-02T09:00:00Z'), 'expired');
  }
});

test('no proposal on a done ticket; replay of the same events gives the same state', () => {
  const state = setup();
  obs(state);
  ev(state, 'ticket-update', { ticket_id: TID, fields: { status: 'done' }, source: 'manual' });
  assert.equal(propose(state).rejected, 'ticket-done');

  const mkState = () => setup();
  const a = mkState();
  const b = mkState();
  const events = [
    makeEvent({ kind: 'ci-observation', payload: { handoff_id: HID, n: 1, pr_url: PR, head_sha: SHA1, head_branch: BRANCH, pr_state: 'open', state: 'failing', checks: [{ name: 't', state: 'failed' }] }, store_id: a.meta.store_id, machine_id: a.meta.machine_id, producer: 'worker', occurred_at: T0, source_identity: `ci-observation:${HID}:1` }),
    makeEvent({ kind: 'ci-proposal', payload: { id: ciProposalId(HID, SHA1), handoff_id: HID, pr_url: PR, head_sha: SHA1, head_branch: BRANCH, failing: ['t'], log_tail: null, log_withheld: 0 }, store_id: a.meta.store_id, machine_id: a.meta.machine_id, producer: 'worker', occurred_at: T0, source_identity: `ci-proposal:${ciProposalId(HID, SHA1)}` }),
  ];
  events.forEach((e, i) => { e.sequence = 100 + i; });
  for (const e of events) { applyEvent(a, e); applyEvent(b, e); }
  for (const e of events) assert.equal(applyEvent(a, e).duplicate, true, 'a duplicate has no second effect');
  assert.deepEqual(a.handoffs.get(HID).ci, b.handoffs.get(HID).ci);
  assert.deepEqual(a.runProposals.get(ciProposalId(HID, SHA1)), b.runProposals.get(ciProposalId(HID, SHA1)));
});

test('an open proposal lapses when the reconciler records the pull request merged or closed, on the ticket or on the run', () => {
  for (const [upd, reason] of [[{ ticket_id: TID, url: PR, state: 'merged', merged_at: '2026-10-02T09:00:00Z' }, 'pr-merged'], [{ ticket_id: TID, url: PR, state: 'closed' }, 'pr-closed'], [{ handoff_id: HID, url: PR, state: 'merged', merged_at: '2026-10-02T09:00:00Z' }, 'pr-merged']]) {
    const state = setup();
    state.tickets.get(TID).prs.push({ id: 'pr1', provider: 'github', url: PR, state: 'draft', opened_at: T0, merged_at: null, base_branch: 'main', head_branch: BRANCH, observed_at: T0, error: null, evidence_id: null });
    obs(state);
    propose(state);
    const p = state.runProposals.get(ciProposalId(HID, SHA1));
    // A failed poll records nothing about the pull request's state.
    worker(state, 'reconcile', { pr_updates: [{ ...upd, state: undefined, error: 'gh offline' }] });
    assert.equal(p.lapsed_at, null);
    worker(state, 'reconcile', { pr_updates: [upd] }, { occurred_at: '2026-10-02T09:01:00Z' });
    assert.deepEqual([p.lapse_reason, p.lapsed_at], [reason, '2026-10-02T09:01:00Z'], JSON.stringify(upd));
    assert.equal(proposalState(p, state.tickets.get(TID), '2026-10-02T09:01:00Z'), 'expired');
  }
});

test('a page run-proposal cannot take a worker-only proposal id (CI fix or critical change) first', () => {
  const state = setup();
  obs(state);
  const ciId = ciProposalId(HID, SHA1);
  const page = (id) => ev(state, 'run-proposal', { id, ticket_id: TID, publisher: 'board', editor: 'ann', recipe: { name: 'analyse', source: 'builtin', hash: null }, mode: 'analyse', permissions: {} }, { producer: 'cli' });
  assert.equal(page(ciId).rejected, 'proposal-id-reserved');
  assert.equal(page(deterministicId(`${HID}:critical:0`)).rejected, 'proposal-id-reserved');
  assert.equal(state.runProposals.has(ciId), false);
  assert.equal(propose(state).rejected, undefined, 'the CI proposal is still staged');
  assert.equal(state.runProposals.get(ciId).origin, 'ci');
  // A page pick's own id (editRequestId: version-4 shaped) is accepted.
  assert.equal(page('44444444-0000-4000-8000-000000000001').rejected, undefined);
});
