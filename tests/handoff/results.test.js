import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordResult, planCriticalChanges, CRITICAL_NO_SCOPE, CRITICAL_NO_PIN, CRITICAL_TRUNCATED, CRITICAL_HIDDEN } from '../../src/handoff/results.js';
import { TrackerError } from '../../src/lib/errors.js';
import { deterministicId } from '../../src/lib/ids.js';
import { writeIngress } from '../../src/core/ingress.js';
import { ingressDir } from '../../src/lib/paths.js';
import { readHealthErrors } from '../../src/worker/health.js';
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

const base = { why: 'w', evidence: 'e', verify: 'v', rollback: 'r' };
const CRITICAL = [
  { ...base, title: 'Sync payments to staging', scope: 'argo.sync', target: 'pay-stg', action: 'argocd app sync pay-stg --prune', risk: 'medium' },
  { ...base, title: 'Rewrite the mainframe', scope: 'mainframe.write', target: 'x', action: 'mf write x', risk: 'high' },
  { ...base, title: 'Close the issue', scope: 'jira.write', target: 'PMO-1', action: 'Please close PMO-1 && tell the team', risk: 'low' },
];

async function doneRun(b, { state = 'done', changes = CRITICAL } = {}) {
  b.ticket(T1, 'LOCAL-a-00000001');
  b.request(RID, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: analyse });
  b.w.tick();
  const hid = b.w.state.requests.get(RID).result.handoff_id;
  const parsed = parseAgentResult({ text: `x\n\`\`\`json\n${JSON.stringify({ summary: 's', critical_changes: changes })}\n\`\`\``, is_error: false, session_id: 's1' });
  recordResult(b.w, hid, parsed, state === 'done' ? { state } : { state, error: { code: 'x', message: 'y' } });
  return hid;
}

const runProposals = (w) => [...w.state.runProposals.values()].filter((p) => p.origin === 'run');
const journaled = (w) => [...w.journal.read()].filter((e) => e.kind === 'critical-proposal').length;

test('a done run turns each pinnable critical change in a configured scope into a local-only child and a run proposal', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const hid = await doneRun(b);
    const proposals = runProposals(b.w);
    assert.equal(proposals.length, 1);
    const p = proposals[0];
    assert.equal(p.id, deterministicId(`${hid}:critical:0`));
    assert.deepEqual([p.from_handoff_id, p.access, p.recipe.name, p.recipe.source, p.action_pin.guard], [hid, 'autonomous', 'critical-change', 'builtin', 'argocd app sync pay-stg --prune']);
    assert.deepEqual(p.scopes.map((s) => [s.name, s.target, /^[0-9a-f]{64}$/.test(s.fingerprint)]), [['argo.sync', 'pay-stg', true]]);
    const child = b.w.state.tickets.get(p.ticket_id);
    assert.deepEqual([child.key, child.parent_id, child.local_only, child.tags, child.status], ['LOCAL-a-00000001.1', T1, true, ['critical'], 'todo']);
    const h = b.w.state.handoffs.get(hid);
    assert.deepEqual(h.critical_notes, [{ index: 1, reason: CRITICAL_NO_SCOPE }, { index: 2, reason: CRITICAL_NO_PIN }]);
    // R46: the vault gets the parent's note but none for the local-only child.
    b.w.flushNotes();
    const notes = fs.readdirSync(path.join(b.storePath, 'tickets'));
    const parentNote = notes.find((n) => n.startsWith('LOCAL-a-00000001') && !n.includes('00000001.1'));
    assert.ok(parentNote, notes.join(','));
    assert.equal(notes.some((n) => n.includes('00000001.1')), false, notes.join(','));
    assert.equal(fs.readFileSync(path.join(b.storePath, 'tickets', parentNote), 'utf8').includes('Sync payments to staging'), false);
    // Replay after a restart rebuilds the same child and proposal from the journal alone.
    await b.w.stop();
    const r = await restartWorker(b);
    b.w = r.w;
    assert.equal(b.w.state.tickets.get(p.ticket_id).critical_spec.action_pin.guard, 'argocd app sync pay-stg --prune');
    assert.equal(b.w.state.runProposals.get(p.id).state, 'proposed');
    assert.equal(b.w.state.criticalProblems.length, 0);
    assert.equal(journaled(b.w), 1, 'the restart emits nothing more');
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

// R45: a cut entry, or hidden characters in what the guard would enforce, is never proposed.
test('a truncated entry or one with control, format or bidi characters is not proposed, and nothing is stripped', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const long = `argocd app sync pay-stg --revision ${'a'.repeat(600)}`;
    const hid = await doneRun(b, { changes: [
      { ...CRITICAL[0], action: long },
      { ...CRITICAL[0], action: `argocd app sync pay-stg${String.fromCodePoint(0x202e)} --prune` },
      { ...CRITICAL[0], why: 'x'.repeat(600) },
    ] });
    const blob = JSON.parse(getBlob(b.w.state.handoffs.get(hid).result_ref, b.w.env));
    assert.deepEqual(blob.critical_changes[0].truncated, ['action']);
    assert.equal(blob.critical_changes[1].action, `argocd app sync pay-stg${String.fromCodePoint(0x202e)} --prune`, 'the stored action is exactly what the agent wrote');
    assert.deepEqual(b.w.state.handoffs.get(hid).critical_notes, [
      { index: 0, reason: CRITICAL_TRUNCATED }, { index: 1, reason: CRITICAL_HIDDEN }, { index: 2, reason: CRITICAL_TRUNCATED },
    ]);
    assert.equal(runProposals(b.w).length, 0);
    // A hidden character in the target or scope refuses the entry too.
    const w = { config: {}, env: b.env, log: () => {} };
    assert.deepEqual(planCriticalChanges(w, [{ ...CRITICAL[0], target: `pay-stg${String.fromCodePoint(0x200b)}` }, { ...CRITICAL[0], scope: `argo.sync${String.fromCodePoint(0x2066)}` }]).notes, [{ index: 0, reason: CRITICAL_HIDDEN }, { index: 1, reason: CRITICAL_HIDDEN }]);
  } finally { await b.w.stop(); }
});

// R48 (M1): the guard's own coverage decision binds a proposal to the scope target.
test('target binding: a proposal needs the action to act on the scope target', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const hid = await doneRun(b, { changes: [
      { ...CRITICAL[0], action: 'argocd app sync pay-prod --prune' },
      { ...CRITICAL[0], scope: 'argo.sync:pay-stg', target: '', action: 'argocd app sync --prune pay-stg' },
      { ...CRITICAL[0], scope: 'http.write', target: 'hooks.example.com', action: 'curl -X POST https://other.example.com/x' },
    ] });
    const notes = b.w.state.handoffs.get(hid).critical_notes;
    assert.deepEqual(notes.map((n) => n.index), [0, 2]);
    assert.match(notes[0].reason, /^scope argo\.sync:pay-stg would not cover this action: the action acts on "pay-prod", not the scope's target "pay-stg"/);
    assert.match(notes[1].reason, /^scope http\.write:hooks\.example\.com would not cover this action: the action acts on "other\.example\.com"/);
    assert.deepEqual(runProposals(b.w).map((p) => p.id), [deterministicId(`${hid}:critical:1`)]);
  } finally { await b.w.stop(); }
});

test('R48: every known target-binding bypass is refused at proposal; the brief\'s examples still propose', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-r48-'));
  try {
    const w = { config: { scopes: { 'k8s.write': { env: { KUBECONFIG: 'env:QUILL_TEST_KUBECONFIG' } } } }, env: { QUILL_HOME: home }, log: (m) => { throw new Error(`unexpected log: ${m}`); } };
    const entry = (scope, target, action) => ({ ...base, title: 't', scope, target, action, risk: 'high' });
    const refused = [
      entry('k8s.write', 'stg', 'kubectl --context stg --context prod rollout restart deploy/api'),
      entry('k8s.write', 'stg', 'kubectl --context prod --v 9 -n stg rollout restart deploy/api'),
      entry('k8s.write', 'stg', 'kubectl --context stg -n pay --namespace prod rollout restart deploy/api'),
      entry('argo.sync', 'pay-stg', 'argocd app sync pay-stg pay-prod'),
      entry('argo.sync', 'pay-stg', 'argocd app sync pay-prod --app-namespace pay-stg'),
      entry('argo.sync', 'pay-stg', 'argocd app sync pay-stg --server argo-prod.example'),
      entry('argo.sync', 'pay-stg', 'mcp__argocd__sync_application {"applicationName":"pay-prod","name":"pay-stg"}'),
      entry('argo.sync', 'pay-stg', 'mcp__argocd__sync_application {"applicationName":"pay-stg","name":"pay-prod"}'),
    ];
    const out = planCriticalChanges(w, refused);
    assert.equal(out.plans.length, 0, JSON.stringify(out.plans.map((p) => p.change.action)));
    assert.deepEqual(out.notes.map((n) => n.index), refused.map((_, i) => i));
    for (const n of out.notes) assert.match(n.reason, /^scope (k8s\.write:stg|argo\.sync:pay-stg) would not cover this action: \S/, JSON.stringify(n));
    assert.match(out.notes[0].reason, /exactly once/);
    assert.match(out.notes[2].reason, /more than once/);
    assert.match(out.notes[3].reason, /exactly one item/);
    assert.match(out.notes[6].reason, /acts on "pay-prod"/);
    assert.match(out.notes[7].reason, /also names "pay-prod"/);
    const legit = [
      entry('argo.sync', 'pay-stg', 'argocd app sync pay-stg --prune'),
      entry('k8s.write', 'stg', 'kubectl --context stg -n pay rollout restart deploy/api'),
      entry('jira.write', 'PMO-1', 'mcp__atlassian__transitionJiraIssue {"issueIdOrKey":"PMO-1","transition":"Done"}'),
      entry('argo.sync', 'pay-stg', 'mcp__argocd__sync_application {"applicationName":"pay-stg"}'),
    ];
    const ok = planCriticalChanges(w, legit);
    assert.deepEqual(ok.notes, []);
    assert.deepEqual(ok.plans.map((p) => [p.scopes[0].name, p.scopes[0].target]), [['argo.sync', 'pay-stg'], ['k8s.write', 'stg'], ['jira.write', null], ['argo.sync', 'pay-stg']]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// R47 M2: a stop between the run's handoff-tx and its proposals is made good at the next start, once.
test('proposals lost to a crash after the run was recorded are emitted at the next start, and only once', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  const emit = b.w.emit.bind(b.w);
  b.w.emit = (kind, ...rest) => { if (kind === 'critical-proposal') throw new Error('simulated crash'); return emit(kind, ...rest); };
  let hid;
  try {
    hid = await doneRun(b);
    assert.equal(b.w.state.handoffs.get(hid).state, 'done');
    assert.equal(runProposals(b.w).length, 0);
  } finally { await b.w.stop(); }
  const clock = () => Date.parse('2026-10-02T09:00:00Z');
  const r1 = await restartWorker(b, { clock });
  try {
    assert.equal(runProposals(r1.w).length, 1);
    assert.equal(r1.w.state.runProposals.has(deterministicId(`${hid}:critical:0`)), true);
    assert.equal(journaled(r1.w), 1);
  } finally { await r1.w.stop(); }
  const r2 = await restartWorker({ ...b, w: r1.w }, { clock });
  try {
    assert.equal(journaled(r2.w), 1, 'a second start emits nothing');
    assert.equal(runProposals(r2.w).length, 1);
  } finally { await r2.w.stop(); }
});

// R47 M3: a bug is logged, never turned into an owner-facing note.
test('an unexpected error while planning is logged and leaves no critical note', () => {
  const lines = [];
  const w = { config: {}, env: {}, log: (m) => lines.push(m) };
  const out = planCriticalChanges(w, [CRITICAL[0]], { loadCatalog: () => { throw new TypeError('boom'); } });
  assert.deepEqual(out, { plans: [], notes: [] });
  assert.match(lines.join('\n'), /critical change 0 not proposed after an unexpected error: TypeError: boom/);
  const resolverError = planCriticalChanges(w, [CRITICAL[0]], { resolve: () => { throw new TrackerError('scope-credentials-missing', 'scope-credentials-missing:argo.sync: no credentials'); } });
  assert.deepEqual(resolverError.notes, [{ index: 0, reason: 'scope-credentials-missing:argo.sync: no credentials' }], 'expected resolver refusals are still notes');
});

// R44: a refused critical-proposal is never silent: it is a health error as well as a reducer problem.
test('a refused critical-proposal is recorded as a health error', async () => {
  const b = await bootWorker({ runtimeAvailable: true });
  try {
    const hid = await doneRun(b);
    const { event, result } = b.w.emit('critical-proposal', { id: deterministicId(`${hid}:critical:7`), from_handoff_id: hid, index: 2, pin: {}, scopes: [], child: {} });
    assert.equal(result.rejected, 'critical-id-mismatch');
    const errors = readHealthErrors(b.env);
    assert.ok(errors.some((e) => e.kind === 'critical-proposal-rejected' && e.event_id === event.event_id && e.code === 'critical-id-mismatch'), JSON.stringify(errors));
  } finally { await b.w.stop(); }
});
