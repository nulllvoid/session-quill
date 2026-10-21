// Approval leases (FR-3.4, ADR 0031): a critical approval's "Valid for" choice is frozen in the
// grant as `notAfter`; after it the guard refuses every scoped write and pinned action with
// lease-expired, and reads still pass. It only refuses: before `notAfter` the 1.1 decision stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../../src/gate/run-guard.js';
import { commandSha } from '../../src/gate/dry-run.js';
import { runDir, checkout, tmp, ENV, grantWith, bash, call, K8S_STG, ARGO, ARGO_STG, PIN_STG, MCP_PIN, denied } from './guard-fixture.js';

const NOT_AFTER = '2026-10-21T10:15:00.000Z';
const BEFORE = { ...ENV, now: Date.parse(NOT_AFTER) - 1000 };
const AT = { ...ENV, now: NOT_AFTER };
const AFTER = { ...ENV, now: Date.parse(NOT_AFTER) + 1000 };
const leased = (over = {}) => grantWith({ scopes: [ARGO_STG], actionPins: [PIN_STG], notAfter: NOT_AFTER, ...over });
const EXPIRED = denied('lease-expired');

test('a pinned action is allowed until notAfter and refused with lease-expired after it', () => {
  assert.equal(decide(bash(PIN_STG.pin), leased(), BEFORE).decision, 'allow');
  assert.equal(decide(bash(PIN_STG.pin), leased(), AT).decision, 'allow', 'notAfter itself is still inside the lease');
  const r = decide(bash(PIN_STG.pin), leased(), AFTER);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, EXPIRED);
  assert.match(r.reason, new RegExp(NOT_AFTER.replace(/\./g, '\\.')));
  assert.match(r.reason, /reads still are/);
  assert.equal(r.criticalChange, undefined, 'an expired lease proposes nothing new');
});

test('the clock is the real one when no time is injected', () => {
  assert.match(decide(bash(PIN_STG.pin), leased({ notAfter: '2000-01-01T00:00:00.000Z' }), ENV).reason, EXPIRED);
  assert.equal(decide(bash(PIN_STG.pin), leased({ notAfter: '2999-01-01T00:00:00.000Z' }), ENV).decision, 'allow');
});

test('after the lease every write a scope or pin covers is refused, pinned or not, shell or MCP', () => {
  const scoped = grantWith({ scopes: [K8S_STG], notAfter: NOT_AFTER });
  assert.equal(decide(bash('kubectl --context stg apply -f x.yaml'), scoped, BEFORE).decision, 'allow');
  assert.match(decide(bash('kubectl --context stg apply -f x.yaml'), scoped, AFTER).reason, EXPIRED);
  const mcp = grantWith({ scopes: [ARGO], actionPins: [MCP_PIN], notAfter: NOT_AFTER });
  const sync = call('mcp__argocd__sync_application', { applicationName: 'pay-stg' });
  assert.equal(decide(sync, mcp, BEFORE).decision, 'allow');
  assert.match(decide(sync, mcp, AFTER).reason, EXPIRED);
});

test('after the lease a write no scope or pin covers follows the 1.1 path: refused as a critical change, proposed', () => {
  const scoped = grantWith({ scopes: [K8S_STG], notAfter: NOT_AFTER });
  for (const [c, g] of [
    [bash('kubectl --context prod delete pod api'), scoped],
    [bash('argocd app sync pay-prod'), leased()],
    [bash('argocd app sync pay-stg --prune'), leased()],
    [bash('kubectl --context stg apply -f x.yaml; kubectl --context prod delete pod api'), scoped],
  ]) {
    const before = decide(c, g, BEFORE);
    const after = decide(c, g, AFTER);
    assert.equal(after.decision, 'deny');
    assert.match(after.reason, /^QUILL_CRITICAL_CHANGE /, c.tool_input.command);
    assert.ok(after.criticalChange, 'the critical change is recorded for a proposal, as in 1.1');
    assert.deepEqual(after, before, 'the lease changes nothing for an uncovered write');
  }
});

test('reads and the run\'s own scratch files still pass after the lease', () => {
  const g = leased({ scopes: [K8S_STG, ARGO_STG] });
  for (const c of [
    bash('kubectl --context stg get pods'),
    bash('argocd app get pay-stg'),
    call('Read', { file_path: path.join(checkout, 'src', 'app.js') }),
    call('Write', { file_path: path.join(runDir, 'notes.md'), content: 'x' }),
    call('Write', { file_path: path.join(tmp, 'out.txt'), content: 'x' }),
  ]) assert.equal(decide(c, g, AFTER).decision, 'allow', JSON.stringify(c));
});

test('a notAfter that does not parse counts as passed', () => {
  for (const notAfter of ['soon', '', 42, {}]) {
    assert.match(decide(bash(PIN_STG.pin), leased({ notAfter }), BEFORE).reason, EXPIRED, JSON.stringify(notAfter));
  }
});

test('a grant without notAfter has no lease (a whole-run approval, and every 1.1 grant)', () => {
  assert.equal(decide(bash(PIN_STG.pin), leased({ notAfter: undefined }), { ...ENV, now: Date.parse('2999-01-01T00:00:00Z') }).decision, 'allow');
  assert.equal(decide(bash(PIN_STG.pin), leased({ notAfter: null }), AFTER).decision, 'allow');
});

test('the lease is checked before the dry-run preflight: a passed twin does not outlive the lease', () => {
  const pin = 'kubectl --context stg scale deployment/api --replicas=3';
  const twin = `${pin} --dry-run=server`;
  const ledger = path.join(runDir, 'ledger.jsonl');
  fs.writeFileSync(ledger, `${JSON.stringify({ kind: 'guard', tool_use_id: 'x1', decision: 'allow', argv_sha: commandSha(bash(twin)) })}\n${JSON.stringify({ kind: 'tool_result', tool_use_id: 'x1', exit_code: 0 })}\n`);
  try {
    const g = grantWith({ scopes: [K8S_STG], actionPins: [{ scope: 'k8s.write:stg', pin }], requireDryRun: true, notAfter: NOT_AFTER });
    assert.equal(decide(bash(pin), g, BEFORE).decision, 'allow');
    assert.match(decide(bash(pin), g, AFTER).reason, EXPIRED);
    // the twin is a read, so it still passes after the lease; it allows nothing by itself
    assert.equal(decide(bash(twin), g, AFTER).decision, 'allow');
  } finally { fs.rmSync(ledger, { force: true }); }
});

test('a lease never allows what the 1.1 guard refuses', () => {
  // inside the lease, a write outside the pin is still a critical change, as without a lease
  const r = decide(bash('argocd app sync pay-prod'), leased(), BEFORE);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^QUILL_CRITICAL_CHANGE /);
  assert.equal(decide(bash('argocd app sync pay-stg'), leased({ scopes: [] }), BEFORE).decision, 'deny');
});
