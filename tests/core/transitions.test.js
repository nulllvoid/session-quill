import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStatusChange, deriveStatusFromEvidence, outstandingObligations } from '../../src/core/transitions.js';
import { newState, createTicket } from './helpers.js';

const repo = { deployment_environments: ['production'] };

test('first successful attributed write moves todo -> active', () => {
  const t = createTicket(newState());
  const r = deriveStatusFromEvidence(t, { type: 'write', seq: 5, evidence_id: 'e5' }, repo);
  assert.equal(r.changed, true);
  assert.equal(t.status, 'active');
  assert.equal(t.status_source, 'evidence');
});

test('manual blocked then PR evidence at or below the floor keeps blocked', () => {
  const t = createTicket(newState());
  applyStatusChange(t, { status: 'blocked', blocker: 'waiting on infra', source: 'manual', seq: 10 });
  assert.equal(t.manual_status_evidence_floor, 10);
  deriveStatusFromEvidence(t, { type: 'pr-open', seq: 10, evidence_id: 'e10' }, repo);
  assert.equal(t.status, 'blocked');
  deriveStatusFromEvidence(t, { type: 'pr-open', seq: 11, evidence_id: 'e11' }, repo);
  assert.equal(t.status, 'blocked', 'blocked is preserved against PR evidence even above the floor');
});

test('evidence above the floor moves active -> review and merge -> deploy-pending with an obligation', () => {
  const t = createTicket(newState());
  applyStatusChange(t, { status: 'active', source: 'manual', seq: 3 });
  deriveStatusFromEvidence(t, { type: 'pr-open', seq: 3, evidence_id: 'same' }, repo);
  assert.equal(t.status, 'active', 'evidence at the manual floor cannot override');
  deriveStatusFromEvidence(t, { type: 'pr-open', seq: 4, evidence_id: 'e4' }, repo);
  assert.equal(t.status, 'review');
  deriveStatusFromEvidence(t, { type: 'pr-merged', seq: 5, evidence_id: 'e5', pr_id: 'pr1', merged_at: '2026-10-02T09:00:00Z', source_event_id: 'ev5' }, repo);
  assert.equal(t.status, 'deploy-pending');
  assert.equal(t.deployments.length, 1);
  assert.equal(t.deployments[0].environment, 'production');
  assert.equal(t.deployments[0].state, 'pending');
  deriveStatusFromEvidence(t, { type: 'pr-merged', seq: 6, evidence_id: 'e6', pr_id: 'pr1', merged_at: '2026-10-02T09:00:00Z', source_event_id: 'ev6' }, repo);
  assert.equal(t.deployments.length, 1, 'obligation identity is pr_id + environment');
});

test('draft PR evidence moves to review but creates no obligation; done is preserved', () => {
  const t = createTicket(newState());
  deriveStatusFromEvidence(t, { type: 'pr-draft', seq: 2, evidence_id: 'e2' }, repo);
  assert.equal(t.status, 'review');
  assert.equal(t.deployments.length, 0);
  applyStatusChange(t, { status: 'done', source: 'manual', seq: 3 });
  deriveStatusFromEvidence(t, { type: 'pr-merged', seq: 4, evidence_id: 'e4', pr_id: 'pr9', merged_at: '2026-10-02T09:00:00Z', source_event_id: 'ev4' }, repo);
  assert.equal(t.status, 'done');
  assert.equal(t.deployments.length, 1, 'obligation still recorded for a done ticket');
  assert.equal(outstandingObligations(t).length, 1);
});

test('all obligations deployed or waived moves deploy-pending -> done', () => {
  const t = createTicket(newState());
  deriveStatusFromEvidence(t, { type: 'pr-merged', seq: 4, evidence_id: 'e4', pr_id: 'pr1', merged_at: '2026-10-02T09:00:00Z', source_event_id: 'ev4' }, { deployment_environments: ['staging', 'production'] });
  assert.equal(t.deployments.length, 2);
  t.deployments[0].state = 'deployed';
  deriveStatusFromEvidence(t, { type: 'obligations-cleared', seq: 5, evidence_id: 'e5' }, repo);
  assert.equal(t.status, 'deploy-pending');
  t.deployments[1].state = 'waived';
  deriveStatusFromEvidence(t, { type: 'obligations-cleared', seq: 6, evidence_id: 'e6' }, repo);
  assert.equal(t.status, 'done');
});

test('applyStatusChange requires blocker text for blocked and records provenance', () => {
  const t = createTicket(newState());
  assert.throws(() => applyStatusChange(t, { status: 'blocked', source: 'manual', seq: 1 }), (e) => e.code === 'blocker-required');
  assert.throws(() => applyStatusChange(t, { status: 'parked', source: 'manual', seq: 1 }), (e) => e.code === 'status-invalid');
  applyStatusChange(t, { status: 'review', source: 'migration', seq: 1 });
  assert.equal(t.status_source, 'migration');
});
