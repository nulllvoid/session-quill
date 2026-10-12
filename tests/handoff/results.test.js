import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordResult } from '../../src/handoff/results.js';
import { getBlob } from '../../src/core/blobs.js';
import { parseAgentResult } from '../../src/handoff/runner.js';
import { bootWorker, T1 } from './helpers.js';

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
