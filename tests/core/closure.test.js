import test from 'node:test';
import assert from 'node:assert/strict';
import { assessClosure } from '../../src/core/closure.js';
import { deriveStatusFromEvidence } from '../../src/core/transitions.js';
import { cleanupSuggestions } from '../../src/core/cleanup.js';

const nowIso = '2026-10-30T12:00:00Z';
const base = (extra = {}) => ({ id: 't', key: 'DEV-1', title: 'Work', status: 'review', prs: [{ id: 'p', state: 'merged', merged_at: nowIso, observed_at: nowIso }], deployments: [{ pr_id: 'p', environment: 'production', state: 'deployed' }], children_ids: [], ...extra });
const context = (tickets = [], handoffs = []) => ({ tickets, handoffs, sessions: [], nowIso, complete: true });

test('one merge cannot close a ticket while another PR remains open', () => {
  const t = base({ prs: [...base().prs, { id: 'other', state: 'open' }] });
  deriveStatusFromEvidence(t, { type: 'pr-merged', seq: 5, evidence_id: 'merge', pr_id: 'p', merged_at: nowIso, source_event_id: 'e', deploy_on: 'merge' }, {}, context());
  assert.equal(t.status, 'review');
});

test('finished children never bypass parent blocker, open PR or deployment', () => {
  const parent = base({ status: 'blocked', blocker: 'Rollout incomplete', deployments: [{ pr_id: 'p', state: 'pending' }], prs: [{ id: 'p', state: 'open' }] });
  const child = base({ id: 'child', parent_id: 't', status: 'done' });
  const suggestion = cleanupSuggestions([parent, child], { ...context([parent, child]), nowIso })[0];
  assert.equal(suggestion.closable, false);
  assert.equal(assessClosure(parent, context([parent, child])).closable, false);
});

test('missing deployment evidence and incomplete snapshot are review candidates, never automatic success', () => {
  assert.equal(assessClosure(base({ deployments: [] }), context()).closable, false);
  assert.equal(assessClosure(base()).closable, false);
});

test('legacy parents need review; explicit groups close only after required children finish', () => {
  const parent = base({ prs: [], deployments: [] });
  const child = base({ id: 'c', parent_id: 't', status: 'done', blocks_parent: true });
  assert.equal(assessClosure(parent, context([parent, child])).closable, false);
  parent.completion_mode = 'children';
  assert.equal(assessClosure(parent, context([parent, child])).closable, true);
  child.status = 'active';
  assert.equal(assessClosure(parent, context([parent, child])).closable, false);
});

test('independent followups do not hold shipped work open, but required or unknown children do', () => {
  const parent = base();
  const child = base({ id: 'c', parent_id: 't', status: 'active', blocks_parent: false });
  assert.equal(assessClosure(parent, context([parent, child])).closable, true);
  child.blocks_parent = true;
  assert.equal(assessClosure(parent, context([parent, child])).closable, false);
  child.blocks_parent = null;
  child.status = 'done';
  assert.equal(assessClosure(parent, context([parent, child])).closable, false);
});

test('active runs, new material work and failed provider observations prevent closure', () => {
  assert.equal(assessClosure(base(), context([], [{ ticket_id: 't', state: 'running' }])).closable, false);
  assert.equal(assessClosure(base({ last_work_at: '2026-10-30T13:00:00Z' }), context()).closable, false);
  assert.equal(assessClosure(base({ prs: [{ ...base().prs[0], error: 'offline' }] }), context()).closable, false);
});

test('abandoned required work is not successful completion of its parent', () => {
  const parent = base({ completion_mode: 'children', prs: [], deployments: [] });
  const child = base({ id: 'c', parent_id: 't', status: 'done', blocks_parent: true, resolution: { kind: 'abandoned' } });
  assert.equal(assessClosure(parent, context([parent, child])).closable, false);
});

test('a later clean run does not erase an earlier unresolved effect', () => {
  const t = { id: 't', status: 'active', prs: [{ id: 'p', state: 'merged' }], deployments: [{ pr_id: 'p', state: 'deployed' }] };
  const result = assessClosure(t, { complete: true, handoffs: [
    { ticket_id: t.id, finished_at: '2026-10-01T00:00:00Z', uncertain_effects: ['push may have partially happened'] },
    { ticket_id: t.id, finished_at: '2026-10-02T00:00:00Z', uncertain_effects: [] },
  ] });
  assert.equal(result.closable, false);
});
