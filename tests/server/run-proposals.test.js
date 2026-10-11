// Proposed runs (ADR 0025): journaled once, approved only by the owner, through the normal handoff
// reservation, dismissed with a journal entry, and lapsing when stale or when the ticket is done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scenario, T1, T2 } from '../acceptance/scenario.js';
import { submitRequest } from '../../src/server/requests.js';

const PID = '44444444-0000-4000-8000-000000000001';
const proposal = (extra = {}) => ({
  id: PID, ticket_id: T1, publisher: 'team', editor: 'u_editor', edited_at: '2026-10-02T07:59:00Z',
  recipe: { name: 'analyse', source: 'builtin', hash: null }, mode: 'analyse', access: 'standard', read_only: true, auto: false, expected_revision: 1,
  permissions: { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false, edit_files: false, delete_files: false },
  ...extra,
});
const propose = (s, extra = {}) => s.w.emit('run-proposal', proposal(extra), { source_identity: `run-proposal:${extra.id ?? PID}` });
const approve = (s, extra = {}, opts) => submitRequest(s.w, { id: randomUUID(), kind: 'approve-run', target_id: T1, expected_revision: null, payload: { proposal_id: PID }, ...extra }, opts);

async function started() {
  const s = scenario({ withServer: true });
  await s.start();
  s.ticket(T1, 'PROJ-1');
  return s;
}

test('a proposal is journaled once, joins the ticket timeline, and queues nothing', async () => {
  const s = await started();
  try {
    const before = s.w.state.tickets.get(T1).revision;
    propose(s);
    propose(s);
    s.w.emit('run-proposal', proposal(), { source_identity: 'run-proposal:other-identity' });
    assert.equal(s.w.state.runProposals.size, 1);
    const p = s.w.state.runProposals.get(PID);
    assert.equal(p.state, 'proposed');
    assert.equal(p.proposed_at, s.iso());
    assert.equal(s.w.state.handoffs.size, 0, 'nothing runs until the owner approves');
    const t = s.w.state.tickets.get(T1);
    assert.equal(t.revision, before, 'a proposal never makes an owner edit conflict');
    assert.match(t.timeline.at(-1).text, /Run of analyse proposed on the team page by u_editor/);
    const snap = s.w.liveSnapshot();
    assert.deepEqual(snap.run_proposals.map((x) => [x.id, x.state, x.ticket_key]), [[PID, 'proposed', 'PROJ-1']]);
  } finally { await s.stop(); }
});

test('a second pick of the same recipe for the same ticket while one is open adds nothing', async () => {
  const s = await started();
  try {
    propose(s);
    const { result } = propose(s, { id: '44444444-0000-4000-8000-000000000002' });
    assert.equal(result.rejected, 'run-already-proposed');
    assert.equal(s.w.state.runProposals.size, 1);
    propose(s, { id: '44444444-0000-4000-8000-000000000003', recipe: { name: 'standup', source: 'builtin', hash: null } });
    assert.equal(s.w.state.runProposals.size, 2, 'another recipe is another proposal');
  } finally { await s.stop(); }
});

test('approving queues an ordinary suggest-only handoff with the recorded recipe, permissions and access', async () => {
  const s = await started();
  try {
    propose(s);
    const { request } = approve(s);
    s.w.tick();
    const req = s.w.state.requests.get(request.id);
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const h = s.w.state.handoffs.get(req.result.handoff_id);
    assert.equal(h.state, 'queued');
    assert.equal(h.recipe.name, 'analyse');
    assert.equal(h.access, 'standard');
    assert.equal(h.permissions.edit_source, false);
    assert.equal(h.proposal_id, PID);
    assert.match(h.note, /proposed on the team page by u_editor/);
    const p = s.w.state.runProposals.get(PID);
    assert.equal(p.state, 'approved');
    assert.equal(p.handoff_id, h.id);
    assert.equal(p.resolved_by, 'owner');
    assert.throws(() => approve(s), (e) => e.code === 'proposal-resolved', 'a proposal is approved once');
  } finally { await s.stop(); }
});

test('approving a ticket that already has an active run says so and leaves the proposal open', async () => {
  const s = await started();
  try {
    submitRequest(s.w, { id: randomUUID(), kind: 'handoff', target_id: T1, expected_revision: s.w.state.tickets.get(T1).revision, payload: { mode: 'analyse' } });
    s.w.tick();
    propose(s);
    const { request } = approve(s);
    s.w.tick();
    const req = s.w.state.requests.get(request.id);
    assert.equal(req.state, 'failed');
    assert.equal(req.error.code, 'handoff-reserved');
    assert.match(req.error.message, /PROJ-1 already has a queued run/);
    assert.match(req.error.message, /approve the proposal again once it finishes/);
    assert.equal(s.w.state.runProposals.get(PID).state, 'proposed');
  } finally { await s.stop(); }
});

test('a page, or anything acting for one, can never approve', async () => {
  const s = await started();
  try {
    propose(s);
    const { request } = approve(s, {}, { actor: 'artifact:team' });
    s.w.tick();
    assert.equal(s.w.state.requests.get(request.id).state, 'failed');
    assert.equal(s.w.state.requests.get(request.id).error.code, 'approval-refused');
    const auto = approve(s, {}, { actor: 'auto-run:team' });
    s.w.tick();
    assert.equal(s.w.state.requests.get(auto.request.id).error.code, 'approval-refused', 'auto-run only for a proposal marked auto');
    assert.equal(s.w.state.handoffs.size, 0);
    assert.equal(s.w.state.runProposals.get(PID).state, 'proposed');
  } finally { await s.stop(); }
});

test('an auto proposal is approved under its publisher\'s auto-run actor only', async () => {
  const s = await started();
  try {
    propose(s, { auto: true });
    const other = approve(s, {}, { actor: 'auto-run:elsewhere' });
    s.w.tick();
    assert.equal(s.w.state.requests.get(other.request.id).error.code, 'approval-refused');
    const { request } = approve(s, {}, { actor: 'auto-run:team' });
    s.w.tick();
    assert.equal(s.w.state.requests.get(request.id).state, 'applied');
    assert.equal(s.w.state.runProposals.get(PID).resolved_by, 'auto-run:team');
  } finally { await s.stop(); }
});

test('dismiss is journaled after the undo window; a dismissed proposal cannot be approved', async () => {
  const s = await started();
  try {
    propose(s);
    const { request } = submitRequest(s.w, { id: randomUUID(), kind: 'dismiss-run', target_id: T1, expected_revision: null, payload: { proposal_id: PID } });
    s.w.tick();
    assert.equal(s.w.state.runProposals.get(PID).state, 'proposed', 'the 10-second undo window applies');
    s.advance(11_000);
    s.w.tick();
    assert.equal(s.w.state.requests.get(request.id).state, 'applied');
    assert.equal(s.w.state.runProposals.get(PID).state, 'dismissed');
    assert.match(s.w.state.tickets.get(T1).timeline.at(-1).text, /Proposed analyse run dismissed/);
    assert.throws(() => approve(s), (e) => e.code === 'proposal-resolved');
  } finally { await s.stop(); }
});

test('an open proposal lapses after seven days or when its ticket is done, and cannot be approved then', async () => {
  const s = await started();
  try {
    s.ticket(T2, 'PROJ-2');
    propose(s);
    propose(s, { id: '44444444-0000-4000-8000-000000000009', ticket_id: T2 });
    s.ingest('ticket-update', { ticket_id: T2, fields: { status: 'done' }, source: 'manual' });
    s.w.tick();
    const snap = s.w.liveSnapshot();
    assert.equal(snap.run_proposals.find((p) => p.ticket_id === T2).state, 'expired');
    assert.throws(() => submitRequest(s.w, { id: randomUUID(), kind: 'approve-run', target_id: T2, payload: { proposal_id: '44444444-0000-4000-8000-000000000009' } }), (e) => e.code === 'proposal-expired');
    s.advance(8 * 24 * 3600_000);
    assert.equal(s.w.liveSnapshot().run_proposals.find((p) => p.id === PID).state, 'expired');
    assert.throws(() => approve(s), (e) => e.code === 'proposal-expired');
    propose(s, { id: '44444444-0000-4000-8000-00000000000a' });
    assert.equal(s.w.state.runProposals.get('44444444-0000-4000-8000-00000000000a').state, 'proposed', 'a lapsed proposal does not block a new pick');
  } finally { await s.stop(); }
});

test('resolved and lapsed proposals are dropped from state 30 days later', async () => {
  const s = await started();
  try {
    propose(s);
    s.advance(40 * 24 * 3600_000);
    propose(s, { id: '44444444-0000-4000-8000-00000000000b', recipe: { name: 'standup', source: 'builtin', hash: null } });
    assert.deepEqual([...s.w.state.runProposals.keys()], ['44444444-0000-4000-8000-00000000000b']);
  } finally { await s.stop(); }
});

test('the dashboard approves through its CSRF-protected request endpoint; without the token nothing happens', async () => {
  const s = scenario({ withServer: true });
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    propose(s);
    const c = await s.client();
    const body = { id: randomUUID(), kind: 'approve-run', target_id: T1, expected_revision: null, payload: { proposal_id: PID } };
    const refused = await fetch(`${c.base}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookie, origin: c.base }, body: JSON.stringify(body) });
    assert.equal(refused.status, 403);
    const ok = await c.post('/v1/requests', body);
    assert.equal(ok.status, 202);
    await s.settle();
    assert.equal(s.w.state.runProposals.get(PID).state, 'approved');
  } finally { await s.stop(); }
});
