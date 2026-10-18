// Interrupted runs (spec §5.4, Task 19): a run cut off by a worker restart keeps its session id and
// partial ledger, is failed/interrupted, and can be resumed as a NEW run (`retry_of` + `--resume`)
// that never widens what the original run was granted. Writes its ledger shows it was allowed to
// make become uncertain effects: they may have run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { submitRequest } from '../../src/server/requests.js';
import { recordResult } from '../../src/handoff/results.js';
import { parseAgentResult } from '../../src/handoff/runner.js';
import { interruptedEffects, resumeFields, resumeProblem } from '../../src/handoff/resume.js';
import { deterministicId } from '../../src/lib/ids.js';
import { writeIngress } from '../../src/core/ingress.js';
import { renderRunDetail } from '../../ui/views/run-detail.js';
import { normalizeSnapshot } from '../../ui/components.js';
import { snapshot as uiSnapshot, TID } from '../ui/fixtures.js';
import { bootWorker, restartWorker, until, T1, T2 } from './helpers.js';

const RID = (n) => `19191919-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };
const analyse = { mode: 'analyse', note: 'look', permissions: NONE };
const TERMINAL = ['done', 'failed', 'cancelled', 'timed-out'];
const settle = (b, hid) => until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return x && TERMINAL.includes(x.state) ? x : null; }, { timeoutMs: 20000 });
const ledgerOf = (b, hid) => path.join(b.home, 'handoffs', 'runs', hid, 'ledger.jsonl');
const guardLine = (extra) => `${JSON.stringify({ kind: 'guard', ts: '2026-10-02T08:00:01Z', decision: 'allow', ...extra })}\n`;
const resume = (b, h, opts) => submitRequest(b.w, { id: randomUUID(), kind: 'resume-run', target_id: h.ticket_id, expected_revision: null, payload: { handoff_id: h.id } }, opts);
const applied = (b, request) => { b.w.tick(); return b.w.state.requests.get(request.id); };

// A run that is running with a recorded session when the worker dies; the restarted worker
// (requests applied, the fake runtime capturing what it was started with) finds it interrupted.
async function interruptedRun({ session = 's1', fakeEnv = {}, ledger = '' } = {}) {
  const d = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: session } });
  const t = d.ticket(T1, 'LOCAL-a-00000001');
  d.request(RID(1), { target_id: T1, expected_revision: t.revision, payload: analyse });
  d.w.tick();
  const hid = d.w.state.requests.get(RID(1)).result.handoff_id;
  await until(() => { d.w.tick(); const h = d.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === session; });
  await d.w.stop({ flush: false, abandonRuns: true });
  if (ledger) { fs.mkdirSync(path.dirname(ledgerOf(d, hid)), { recursive: true }); fs.appendFileSync(ledgerOf(d, hid), ledger); }
  const capture = path.join(d.home, 'capture.json');
  const e = await restartWorker(d, { spawnEnv: { FAKE_CLAUDE_CAPTURE: capture, ...fakeEnv }, withServer: true });
  return { e, hid, capture };
}

test('a worker restart leaves a run whose init was recorded failed/interrupted, its session id kept; run detail offers Resume as new run', async () => {
  const { e, hid } = await interruptedRun();
  try {
    const h = e.w.state.handoffs.get(hid);
    assert.equal(h.state, 'failed');
    assert.equal(h.error.code, 'interrupted');
    assert.equal(h.session_id, 's1', 'the recorded session id is kept for the resume');
    const snap = e.w.liveSnapshot();
    const html = renderRunDetail(snap.handoffs.find((x) => x.id === hid), snap, { now: e.iso() });
    assert.match(html, /data-action="resume-run" data-ticket="[^"]+" data-handoff="[^"]+">Resume as new run<\/button>/);
    assert.doesNotMatch(html, /Retry as new run/, 'a resumable run offers the resume, not a fresh retry');
  } finally { await e.w.stop(); }
});

test('resume queues a NEW run with retry_of that the worker starts with --resume s1; the original then offers neither action', async () => {
  const { e, hid, capture } = await interruptedRun();
  try {
    const orig = e.w.state.handoffs.get(hid);
    const req = applied(e, resume(e, orig).request);
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const nid = req.result.handoff_id;
    assert.notEqual(nid, hid, 'a new run, not the old one restarted');
    const n = e.w.state.handoffs.get(nid);
    assert.equal(n.retry_of, hid);
    assert.equal(n.resume_session_id, 's1');
    assert.deepEqual([n.mode, n.access, n.recipe.name, n.permissions], [orig.mode, orig.access, orig.recipe.name, orig.permissions], 'the same run, with nothing widened');
    const done = await settle(e, nid);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    const turns = fs.readFileSync(`${capture}.resume`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const args = turns[0].args;
    assert.equal(args[args.indexOf('--resume') + 1], 's1');
    assert.match(turns[0].prompt, /interrupted/i);
    assert.match(turns[0].prompt, /check .*before repeating/i, 'the resumed agent is told not to repeat a write blindly');
    assert.equal(fs.existsSync(capture), false, 'no fresh session was started for it');
    // The original is superseded by its resume: neither Resume nor Retry is offered on it again.
    const snap = e.w.liveSnapshot();
    const html = renderRunDetail(snap.handoffs.find((x) => x.id === hid), snap, { now: e.iso() });
    assert.doesNotMatch(html, /Resume as new run|Retry as new run/);
    assert.match(html, /Retried as a new run/);
    assert.throws(() => resume(e, orig), (err) => err.code === 'run-superseded', 'resumed once, then superseded');
    // Nothing of the resume leaves the owner's machine (spec §9).
    const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
    assert.doesNotMatch(JSON.stringify(sanitizeSnapshot(e.w.liveSnapshot(), { exportedAt: e.iso() })), /resume_session_id|"session_id"/);
  } finally { await e.w.stop(); }
});

test('resume is refused for runs that cannot be resumed, and for actors other than the owner and the CLI', async () => {
  const { e, hid } = await interruptedRun();
  try {
    const orig = e.w.state.handoffs.get(hid);
    // A page or a schedule never resumes a run (spec §4.2 privileged requests).
    for (const actor of ['artifact:team', 'schedule:nightly']) {
      const r = applied(e, resume(e, orig, { actor }).request);
      assert.equal(r.state, 'failed', actor);
      assert.equal(r.error.code, 'resume-refused', actor);
    }
    // Through ingress: any actor but the CLI is refused, and the CLI is accepted.
    const viaIngress = (actor) => {
      const id = randomUUID();
      writeIngress(e.mk('request', { id, kind: 'resume-run', target_id: orig.ticket_id, expected_revision: null, payload: { handoff_id: hid }, created_at: e.iso(), not_before: e.iso(), actor_id: actor, body_hash: 'x' }, { source_identity: `request:${id}` }), e.env);
      e.w.tick();
      e.w.tick();
      return e.w.state.requests.get(id);
    };
    assert.equal(viaIngress('page-edit').error.code, 'resume-refused');
    assert.equal([...e.w.state.handoffs.values()].length, 1, 'nothing was queued');
    const cli = viaIngress('cli');
    assert.equal(cli.state, 'applied', JSON.stringify(cli.error));
    assert.equal(e.w.state.handoffs.get(cli.result.handoff_id).retry_of, hid);
  } finally { await e.w.stop(); }
  // Not interrupted, or interrupted before any session id was recorded: Retry, never Resume.
  assert.equal(resumeProblem({ state: 'done', session_id: 's1', error: null }).code, 'run-not-resumable');
  assert.equal(resumeProblem({ state: 'failed', session_id: 's1', error: { code: 'agent-exit' } }).code, 'run-not-resumable');
  assert.equal(resumeProblem({ state: 'failed', session_id: null, error: { code: 'interrupted' } }).code, 'no-session');
  assert.equal(resumeProblem({ state: 'failed', session_id: '--dangerous', error: { code: 'interrupted' } }).code, 'no-session', 'a session id that reads like an option is never passed on');
  assert.equal(resumeProblem({ state: 'failed', session_id: 's1', error: { code: 'interrupted' } }), null);
  const h = { id: 'run-9', ticket_id: TID(1), request_id: 'r9', mode: 'analyse', recipe: { name: 'analyse', source: 'builtin' }, permissions: NONE, access: 'standard', state: 'failed', error: { code: 'interrupted', message: 'worker restarted' }, requested_at: '2026-10-02T09:00:00Z', finished_at: '2026-10-02T09:05:00Z', session_id: null };
  const html = renderRunDetail(h, normalizeSnapshot({ ...uiSnapshot(), handoffs: [h] }), { now: '2026-10-02T12:00:00Z' });
  assert.match(html, /Retry as new run/);
  assert.doesNotMatch(html, /Resume as new run/);
});

test('a scoped run interrupted after a ledger write shows the write as an uncertain effect: kubectl apply on stg may have run', async () => {
  const ledger = [
    guardLine({ tool_name: 'Bash', input_summary: 'kubectl apply -f deploy.yaml --context stg', class: 'write', scope: 'k8s.write', target: 'stg' }),
    // Refused, a local commit and a read are not effects.
    guardLine({ tool_name: 'Bash', input_summary: 'kubectl delete pod x --context prod', class: 'write', scope: 'k8s.write', target: 'prod', decision: 'deny', critical: true }),
    guardLine({ tool_name: 'Bash', input_summary: 'git commit -m x', class: 'write', scope: 'git.commit' }),
    guardLine({ tool_name: 'Bash', input_summary: 'kubectl get pods --context stg', class: 'read' }),
    guardLine({ tool_name: 'mcp__atlassian__editJiraIssue', input_summary: '{"issueIdOrKey":"ABC-1"}', class: 'write', scope: 'jira.write', target: 'ABC-1' }),
  ].join('');
  const { e, hid } = await interruptedRun({ ledger });
  try {
    const h = e.w.state.handoffs.get(hid);
    assert.equal(h.error.code, 'interrupted');
    assert.deepEqual(h.uncertain_effects, ['kubectl apply on stg may have run', 'mcp__atlassian__editJiraIssue on ABC-1 may have run']);
    // The partial ledger is kept for the owner and the resume.
    assert.match(fs.readFileSync(ledgerOf(e, hid), 'utf8'), /kubectl apply/);
    const snap = e.w.liveSnapshot();
    const html = renderRunDetail(snap.handoffs.find((x) => x.id === hid), snap, { now: e.iso() });
    assert.match(html, /class="run-uncertain"[\s\S]*kubectl apply on stg may have run/);
  } finally { await e.w.stop(); }
});

test('interruptedEffects: allowed writes only, one line each, never more than the ledger holds', () => {
  const l = (x) => ({ kind: 'guard', decision: 'allow', ...x });
  assert.deepEqual(interruptedEffects([
    l({ tool_name: 'Bash', input_summary: 'kubectl --context stg apply -f x.yaml', class: 'write', scope: 'k8s.write', target: 'stg' }),
    l({ tool_name: 'Bash', input_summary: 'kubectl --context stg apply -f x.yaml', class: 'write', scope: 'k8s.write', target: 'stg' }),
    l({ tool_name: 'Bash', input_summary: 'curl -X POST https://hooks.example.com/x', class: 'external.write', scope: 'http.write', target: 'hooks.example.com' }),
    l({ tool_name: 'Bash', input_summary: 'cd x && helm upgrade api ./chart', class: 'write', scope: 'k8s.write' }),
    l({ tool_name: 'Bash', input_summary: 'git push origin feat', class: 'write', scope: 'git.push', target: 'feat' }),
    l({ tool_name: 'Edit', input_summary: 'src/a.js', class: 'local' }),
    { kind: 'tool_result', tool: 'Bash', input_summary: 'kubectl apply -f y.yaml', is_error: false },
    null, 'junk',
  ]), [
    'kubectl apply on stg may have run',
    'curl on hooks.example.com may have run',
    'a k8s.write call may have run',
    'git push on feat may have run',
  ]);
  assert.deepEqual(interruptedEffects([]), []);
  assert.equal(interruptedEffects(Array.from({ length: 80 }, (_, i) => l({ tool_name: `mcp__x__write${i}`, class: 'write', scope: 'mcp.write' }))).length, 50, 'capped');
});

test('a graceful stop mid-run marks the run interrupted with the same uncertain effects', async () => {
  const b = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: 's2' } });
  const t = b.ticket(T2, 'LOCAL-b-00000002');
  b.request(RID(2), { target_id: T2, expected_revision: t.revision, payload: analyse });
  b.w.tick();
  const hid = b.w.state.requests.get(RID(2)).result.handoff_id;
  await until(() => { b.w.tick(); const h = b.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === 's2'; });
  fs.mkdirSync(path.dirname(ledgerOf(b, hid)), { recursive: true });
  fs.appendFileSync(ledgerOf(b, hid), guardLine({ tool_name: 'Bash', input_summary: 'kubectl apply -f deploy.yaml --context stg', class: 'write', scope: 'k8s.write', target: 'stg' }));
  await b.w.stop();
  const h = b.w.state.handoffs.get(hid);
  assert.equal(h.error.code, 'interrupted');
  assert.equal(h.session_id, 's2');
  assert.deepEqual(h.uncertain_effects, ['kubectl apply on stg may have run']);
});

// Critical changes (ADR 0028): a resumed approved run keeps exactly its pin and scope, or is refused.
const PINNED = 'argocd app sync pay-stg --prune';
const CHANGE = { title: 'Sync payments to staging', scope: 'argo.sync', target: 'pay-stg', action: PINNED, why: 'w', evidence: 'e', verify: 'v', rollback: 'r', risk: 'medium' };

test('resuming an approved critical-change run keeps its pin, scope, fingerprints and provenance; a changed scope is refused with scope-changed', async () => {
  const d = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: 'sc1' } });
  d.ticket(T1, 'PMO-7');
  d.request(RID(3), { target_id: T1, expected_revision: d.w.state.tickets.get(T1).revision, payload: { mode: 'analyse', note: 'look', permissions: NONE } });
  d.w.tick();
  const parent = d.w.state.requests.get(RID(3)).result.handoff_id;
  recordResult(d.w, parent, parseAgentResult({ text: `x\n\`\`\`json\n${JSON.stringify({ summary: 's', critical_changes: [CHANGE] })}\n\`\`\``, is_error: false, session_id: 'p1' }), { state: 'done' });
  const p = d.w.state.runProposals.get(deterministicId(`${parent}:critical:0`));
  const req = applied(d, submitRequest(d.w, { id: randomUUID(), kind: 'approve-run', target_id: p.ticket_id, expected_revision: null, payload: { proposal_id: p.id } }).request);
  assert.equal(req.state, 'applied', JSON.stringify(req.error));
  const hid = req.result.handoff_id;
  await until(() => { d.w.tick(); const h = d.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === 'sc1'; }, { timeoutMs: 15000 });
  await d.w.stop({ flush: false, abandonRuns: true });
  const e = await restartWorker(d, { spawnEnv: { FAKE_CLAUDE_SESSION: 'sc1' }, withServer: true });
  try {
    const orig = e.w.state.handoffs.get(hid);
    assert.equal(orig.error.code, 'interrupted');
    // The scope changed in config.toml after the change was approved: the resume is refused and
    // nothing is queued. Put back, the resume goes through.
    const before = e.config.scopes;
    e.config.scopes = { 'argo.sync': { bash: ['argocd app *'] } };
    const refused = applied(e, resume(e, orig).request);
    assert.equal(refused.state, 'failed');
    assert.equal(refused.error.code, 'scope-changed');
    assert.equal([...e.w.state.handoffs.values()].filter((x) => x.retry_of === hid).length, 0);
    if (before === undefined) delete e.config.scopes; else e.config.scopes = before;
    const r = applied(e, resume(e, orig).request);
    assert.equal(r.state, 'applied', JSON.stringify(r.error));
    const n = e.w.state.handoffs.get(r.result.handoff_id);
    assert.equal(n.access, 'autonomous');
    assert.deepEqual(n.scopes, orig.scopes);
    assert.deepEqual(n.action_pins, [{ scope: 'argo.sync:pay-stg', pin: PINNED }]);
    assert.deepEqual(n.scope_fingerprints, orig.scope_fingerprints);
    assert.equal(n.origin_proposal_id, p.id);
    assert.deepEqual(n.proposal, orig.proposal, 'still a proposed run: its learnings stay quarantined');
    assert.equal(n.batch_id, null);
    const done = await settle(e, n.id);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
  } finally { await e.w.stop(); }
});

test('resumeFields copies what the original run was granted, and refuses a scope grant without its pin', () => {
  const base = { id: 'h1', mode: 'analyse', note: 'n', permissions: NONE, access: 'autonomous', branch: null, recipe: { name: 'critical-change', source: 'builtin', hash: 'abc' }, legacy: false, outputs: ['summary'], scopes: ['argo.sync:pay-stg'], max_turns: 9, max_budget_usd: 2, batch_id: 'b1', session_id: 's1' };
  const critical = { ...base, action_pins: [{ scope: 'argo.sync:pay-stg', pin: PINNED }], scope_fingerprints: { 'argo.sync:pay-stg': 'f'.repeat(64) }, origin_proposal_id: 'p1', proposal_id: 'p1', proposal: { id: 'p1', origin: 'run', from_handoff_id: 'h0', recipe: 'critical-change' } };
  const f = resumeFields(critical);
  assert.deepEqual(f.action_pins, critical.action_pins);
  assert.deepEqual(f.scope_fingerprints, critical.scope_fingerprints);
  assert.deepEqual([f.access, f.scopes, f.max_turns, f.max_budget_usd, f.origin_proposal_id, f.proposal_id], ['autonomous', ['argo.sync:pay-stg'], 9, 2, 'p1', 'p1']);
  assert.equal('batch_id' in f, false, 'a resume is the owner\'s own run, outside the batch and its budget');
  for (const broken of [
    { ...critical, action_pins: [] },
    { ...critical, action_pins: [{ scope: 'argo.sync:other', pin: PINNED }] },
    { ...critical, action_pins: [{ scope: 'argo.sync:pay-stg', pin: '' }] },
    { ...critical, scope_fingerprints: null },
    { ...critical, scope_fingerprints: { 'argo.sync:other': 'x' } },
    { ...critical, proposal: { ...critical.proposal, origin: 'page' }, action_pins: [{ scope: 'argo.sync:pay-stg', pin: PINNED }], origin_proposal_id: null },
  ]) assert.throws(() => resumeFields(broken), (err) => err.code === 'resume-refused', JSON.stringify(broken.action_pins));
  // A run-origin proposal whose pins are gone entirely is never resumed as a bare scope grant.
  assert.throws(() => resumeFields({ ...critical, action_pins: undefined }), (err) => err.code === 'resume-refused');
  // An ordinary scoped run keeps its scopes and the fingerprints its grant was frozen with (no pin
  // to keep); without recorded fingerprints it is not resumed at all.
  const scoped = resumeFields({ ...base, recipe: { name: 'analyse', source: 'builtin', hash: 'x' }, scope_fingerprints: { 'argo.sync:pay-stg': 'f1' } });
  assert.deepEqual([scoped.scopes, scoped.scope_fingerprints, scoped.action_pins], [['argo.sync:pay-stg'], { 'argo.sync:pay-stg': 'f1' }, undefined]);
  assert.throws(() => resumeFields({ ...base, recipe: { name: 'analyse', source: 'builtin', hash: 'x' } }), (err) => err.code === 'resume-refused');
  // An unscoped run copies no scope fields.
  assert.equal('scope_fingerprints' in resumeFields({ ...base, scopes: undefined }), false);
});

test('quill agent resume is refused inside an agent run (cli-in-run) and writes nothing', async () => {
  const { makeHome, cli } = await import('../cli/helpers.js');
  const { isReadInRun } = await import('../../src/cli/in-run.js');
  assert.equal(isReadInRun('agent', 'resume'), false);
  const fx = makeHome();
  const ingress = path.join(fx.home, 'ingress');
  const before = fs.existsSync(ingress) ? fs.readdirSync(ingress).length : 0;
  const r = await cli(['agent', 'resume', 'abcd1234'], { ...fx.env, QUILL_HANDOFF_ID: 'x' });
  assert.equal(r.code, 2);
  assert.match(r.err, /cli-in-run/);
  assert.equal(fs.existsSync(ingress) ? fs.readdirSync(ingress).length : 0, before, 'no request was written');
});

test('a scoped autonomous run records the fingerprints its grant was frozen with; its resume keeps them and is refused after a scope edit', async () => {
  const d = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: 'sa1' } });
  const t = d.ticket(T2, 'LOCAL-b-00000002');
  d.request(RID(4), { target_id: T2, expected_revision: t.revision, payload: { ...analyse, access: 'autonomous', scopes: ['argo.sync:pay-stg'] } });
  d.w.tick();
  const r0 = d.w.state.requests.get(RID(4));
  assert.equal(r0.state, 'applied', JSON.stringify(r0.error));
  const hid = r0.result.handoff_id;
  const running = await until(() => { d.w.tick(); const h = d.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === 'sa1' ? h : null; }, { timeoutMs: 15000 });
  assert.deepEqual(Object.keys(running.scope_fingerprints), ['argo.sync:pay-stg']);
  assert.match(running.scope_fingerprints['argo.sync:pay-stg'], /\S/);
  assert.equal(running.action_pins, undefined, 'an ordinary scoped run has no pin');
  await d.w.stop({ flush: false, abandonRuns: true });
  const e = await restartWorker(d, { withServer: true });
  try {
    const orig = e.w.state.handoffs.get(hid);
    e.config.scopes = { 'argo.sync': { bash: ['argocd app *'] } };
    const refused = applied(e, resume(e, orig).request);
    assert.equal(refused.error.code, 'scope-changed');
    delete e.config.scopes;
    const r = applied(e, resume(e, orig).request);
    assert.equal(r.state, 'applied', JSON.stringify(r.error));
    const n = e.w.state.handoffs.get(r.result.handoff_id);
    assert.deepEqual([n.access, n.scopes, n.scope_fingerprints, n.action_pins], ['autonomous', ['argo.sync:pay-stg'], orig.scope_fingerprints, undefined]);
    // The scope changes after the resume was queued: dispatch refuses it with scope-changed.
    e.config.scopes = { 'argo.sync': { bash: ['argocd app *'] } };
    const failed = await settle(e, n.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error.code, 'scope-changed');
    assert.match(failed.error.message, /resumes/);
  } finally { await e.w.stop(); }
});
