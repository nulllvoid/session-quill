import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recordResult, CRITICAL_NO_SCOPE, CRITICAL_NO_PIN } from '../../src/handoff/results.js';
import { deterministicId } from '../../src/lib/ids.js';
import { writeIngress } from '../../src/core/ingress.js';
import { ingressDir } from '../../src/lib/paths.js';
import { getBlob } from '../../src/core/blobs.js';
import { parseAgentResult } from '../../src/handoff/runner.js';
import { bootWorker, restartWorker, T1 } from './helpers.js';

const RID = '22222222-0000-4000-8000-000000000001';
const analyse = { mode: 'analyse', note: 'look', permissions: { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false }, branch: null };

const reply = {
  summary: 's', stage_reached: 'pr_opened',
  attempts: [{ route: 'argocd', tool: 'argocd', target: 'app', outcome: 'refused', reason: 'denied', evidence: 'e' }, { route: 'git log', tool: 'git', target: '.', outcome: 'worked', reason: '', evidence: 'abc' }],
  learnings: [{ scope: 'repo', section: 'Build', key: null, kind: 'fact', text: 't', evidence: ['a:1'], derived_from: 'repo-file' }],
  critical_changes: [{ title: 'c', risk: 'low' }], verification: [{ claim: 'x', method: 'test', command: 'npm test', result: 'passed' }], plan: ['one'],
};

test('recordResult keeps the new result fields in the blob and only counts, claimed stage and recorded stage on the record', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    b.request(RID, { target_id: T1, expected_revision: t.revision, payload: analyse });
    b.w.tick();
    const hid = b.w.state.requests.get(RID).result.handoff_id;
    const parsed = parseAgentResult({ text: `x\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``, is_error: false, session_id: 's1' });
    recordResult(b.w, hid, parsed, { state: 'done', extra: { commit_sha: 'abc', test_gate: { status: 'passed' }, num_turns: 12, cost_usd: 0.5, cost_estimated: true } });
    const h = b.w.state.handoffs.get(hid);
    assert.deepEqual([h.attempt_count, h.learning_count, h.critical_count, h.stage_reached, h.recorded_stage], [2, 1, 1, 'pr_opened', 'committed']);
    assert.deepEqual([h.num_turns, h.cost_usd, h.cost_estimated], [12, 0.5, true]);
    for (const k of ['attempts', 'learnings', 'critical_changes', 'verification', 'plan']) assert.equal(k in h, false, `${k} stays out of the record`);
    const blob = JSON.parse(getBlob(h.result_ref, b.w.env));
    assert.equal(blob.attempts.length, 2);
    assert.equal(blob.learnings[0].text, 't');
    assert.equal(blob.critical_changes[0].title, 'c');
    assert.equal(blob.verification[0].command, 'npm test');
    assert.deepEqual([blob.plan, blob.stage_reached], [['one'], 'pr_opened']);
  } finally { await b.w.stop(); }
});

test('a failed run with no structured result still gets a recorded stage and zero counts', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const t = b.ticket(T1, 'LOCAL-a-00000001');
    b.request(RID, { target_id: T1, expected_revision: t.revision, payload: analyse });
    b.w.tick();
    const hid = b.w.state.requests.get(RID).result.handoff_id;
    recordResult(b.w, hid, { summary: null }, { state: 'failed', error: { code: 'x', message: 'y' } });
    const h = b.w.state.handoffs.get(hid);
    assert.deepEqual([h.attempt_count, h.learning_count, h.critical_count, h.stage_reached, h.recorded_stage], [0, 0, 0, null, 'investigated']);
  } finally { await b.w.stop(); }
});

const CRITICAL = [
  { title: 'Sync payments to staging', scope: 'argo.sync', target: 'pay-stg', action: 'argocd app sync pay-stg --prune', why: 'w', evidence: 'e', verify: 'v', rollback: 'r', risk: 'medium' },
  { title: 'Rewrite the mainframe', scope: 'mainframe.write', target: 'x', action: 'mf write x', why: 'w', evidence: 'e', verify: 'v', rollback: 'r', risk: 'high' },
  { title: 'Close the issue', scope: 'jira.write', target: 'PMO-1', action: 'Please close PMO-1 && tell the team', why: 'w', evidence: 'e', verify: 'v', rollback: 'r', risk: 'low' },
];

async function doneRun(b, { state = 'done' } = {}) {
  b.ticket(T1, 'LOCAL-a-00000001');
  b.request(RID, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: analyse });
  b.w.tick();
  const hid = b.w.state.requests.get(RID).result.handoff_id;
  const parsed = parseAgentResult({ text: `x\n\`\`\`json\n${JSON.stringify({ summary: 's', critical_changes: CRITICAL })}\n\`\`\``, is_error: false, session_id: 's1' });
  recordResult(b.w, hid, parsed, state === 'done' ? { state } : { state, error: { code: 'x', message: 'y' } });
  return hid;
}

test('a done run turns each pinnable critical change in a configured scope into a local-only child and a run proposal', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const hid = await doneRun(b);
    const proposals = [...b.w.state.runProposals.values()].filter((p) => p.origin === 'run');
    assert.equal(proposals.length, 1);
    const p = proposals[0];
    assert.equal(p.id, deterministicId(`${hid}:critical:0`));
    assert.deepEqual([p.from_handoff_id, p.access, p.recipe.name, p.recipe.source, p.action_pin.guard], [hid, 'autonomous', 'critical-change', 'builtin', 'argocd app sync pay-stg --prune']);
    assert.deepEqual(p.scopes.map((s) => [s.name, s.target, /^[0-9a-f]{64}$/.test(s.fingerprint)]), [['argo.sync', 'pay-stg', true]]);
    const child = b.w.state.tickets.get(p.ticket_id);
    assert.deepEqual([child.key, child.parent_id, child.local_only, child.tags, child.status], ['LOCAL-a-00000001.1', T1, true, ['critical'], 'todo']);
    const h = b.w.state.handoffs.get(hid);
    assert.deepEqual(h.critical_notes, [{ index: 1, reason: CRITICAL_NO_SCOPE }, { index: 2, reason: CRITICAL_NO_PIN }]);
    // Replay after a restart rebuilds the same child and proposal from the journal and the result blob.
    await b.w.stop();
    const r = await restartWorker(b);
    b.w = r.w;
    assert.equal(b.w.state.tickets.get(p.ticket_id).critical_spec.action_pin.guard, 'argocd app sync pay-stg --prune');
    assert.equal(b.w.state.runProposals.get(p.id).state, 'proposed');
    assert.equal(b.w.state.criticalProblems.length, 0);
  } finally { await b.w.stop(); }
});

test('a run that did not finish done proposes no critical change', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const hid = await doneRun(b, { state: 'failed' });
    assert.equal([...b.w.state.runProposals.values()].length, 0);
    assert.equal([...b.w.state.tickets.values()].some((t) => t.local_only), false);
    assert.equal('critical_notes' in b.w.state.handoffs.get(hid), false);
  } finally { await b.w.stop(); }
});

test('a critical-proposal arriving through ingress is quarantined, whatever producer it claims', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const hid = await doneRun(b);
    const forged = b.mk('critical-proposal', { id: deterministicId(`${hid}:critical:9`), from_handoff_id: hid, index: 9, pin: {}, scopes: [], child: { key: 'LOCAL-a-00000001.9' } }, { producer: 'worker' });
    writeIngress(forged, b.env);
    b.w.tick();
    assert.equal(b.w.journal.hasEvent(forged.event_id), false);
    assert.ok(fs.existsSync(path.join(ingressDir(b.env), 'quarantine', `${forged.event_id}.json`)));
  } finally { await b.w.stop(); }
});
