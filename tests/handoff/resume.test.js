// Interrupted runs (spec §5.4, Task 19): a run cut off by a worker restart keeps its session id and
// partial ledger, is failed/interrupted, and can be resumed as a NEW run (`retry_of` + `--resume`)
// that never widens what the original run was granted. Writes its ledger shows it was allowed to
// make become uncertain effects: they may have run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { submitRequest } from '../../src/server/requests.js';
import { recordResult } from '../../src/handoff/results.js';
import { parseAgentResult } from '../../src/handoff/runner.js';
import { interruptedEffects, resumeFields, resumeProblem, carrySession, claudeConfigRoot, projectDirName, SESSION_MISSING } from '../../src/handoff/resume.js';
import { sanitizeSnapshot } from '../../src/export/sanitize.js';
import { renderHandoffNote } from '../../src/worker/notes.js';
import { deterministicId } from '../../src/lib/ids.js';
import { writeIngress } from '../../src/core/ingress.js';
import { renderRunDetail } from '../../ui/views/run-detail.js';
import { normalizeSnapshot } from '../../ui/components.js';
import { snapshot as uiSnapshot, TID } from '../ui/fixtures.js';
import { bootWorker, restartWorker, until, T1, T2 } from './helpers.js';

// Claude Code session ids are UUIDs; nothing else is ever resumed.
const S1 = '5e551011-0000-4000-8000-000000000001';
const S2 = '5e551011-0000-4000-8000-000000000002';
const SC1 = '5e551011-0000-4000-8000-0000000000c1';
const SA1 = '5e551011-0000-4000-8000-0000000000a1';
// Each test's own Claude Code config root: the fake runtime keeps session transcripts there by
// working directory, as Claude Code does, and refuses a --resume it cannot find (ruling R54).
const configRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-cc-'));
const RID = (n) => `19191919-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };
const analyse = { mode: 'analyse', note: 'look', permissions: NONE };
const TERMINAL = ['done', 'failed', 'cancelled', 'timed-out'];
const settle = (b, hid) => until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return x && TERMINAL.includes(x.state) ? x : null; }, { timeoutMs: 20000 });
const ledgerOf = (b, hid) => path.join(b.home, 'handoffs', 'runs', hid, 'ledger.jsonl');
const guardLine = (extra) => `${JSON.stringify({ kind: 'guard', ts: '2026-10-02T08:00:01Z', decision: 'allow', ...extra })}\n`;
const resume = (b, h, opts) => submitRequest(b.w, { id: randomUUID(), kind: 'resume-run', target_id: h.ticket_id, expected_revision: null, payload: { handoff_id: h.id } }, opts);
const applied = (b, request) => { b.w.tick(); return b.w.state.requests.get(request.id); };
// A resume-run request arriving through ingress (as `quill agent resume` sends it), as `actor`.
function viaIngress(b, h, actor) {
  const id = randomUUID();
  writeIngress(b.mk('request', { id, kind: 'resume-run', target_id: h.ticket_id, expected_revision: null, payload: { handoff_id: h.id }, created_at: b.iso(), not_before: b.iso(), actor_id: actor, body_hash: 'x' }, { source_identity: `request:${id}` }), b.env);
  b.w.tick();
  b.w.tick();
  return b.w.state.requests.get(id);
}

// A run that is running with a recorded session when the worker dies; the restarted worker
// (requests applied, the fake runtime capturing what it was started with) finds it interrupted.
async function interruptedRun({ session = S1, fakeEnv = {}, ledger = '' } = {}) {
  const config = configRoot();
  const d = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: session, CLAUDE_CONFIG_DIR: config } });
  const t = d.ticket(T1, 'LOCAL-a-00000001');
  d.request(RID(1), { target_id: T1, expected_revision: t.revision, payload: analyse });
  d.w.tick();
  const hid = d.w.state.requests.get(RID(1)).result.handoff_id;
  await until(() => { d.w.tick(); const h = d.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === session; });
  await d.w.stop({ flush: false, abandonRuns: true });
  if (ledger) { fs.mkdirSync(path.dirname(ledgerOf(d, hid)), { recursive: true }); fs.appendFileSync(ledgerOf(d, hid), ledger); }
  const capture = path.join(d.home, 'capture.json');
  const e = await restartWorker(d, { spawnEnv: { FAKE_CLAUDE_CAPTURE: capture, CLAUDE_CONFIG_DIR: config, ...fakeEnv }, withServer: true });
  return { e, hid, capture, config };
}

test('a worker restart leaves a run whose init was recorded failed/interrupted, its session id kept; run detail offers Resume as new run', async () => {
  const { e, hid } = await interruptedRun();
  try {
    const h = e.w.state.handoffs.get(hid);
    assert.equal(h.state, 'failed');
    assert.equal(h.error.code, 'interrupted');
    assert.equal(h.session_id, S1, 'the recorded session id is kept for the resume');
    const snap = e.w.liveSnapshot();
    const html = renderRunDetail(snap.handoffs.find((x) => x.id === hid), snap, { now: e.iso() });
    assert.match(html, /data-action="resume-run" data-ticket="[^"]+" data-handoff="[^"]+">Resume as new run<\/button>/);
    assert.doesNotMatch(html, /Retry as new run/, 'a resumable run offers the resume, not a fresh retry');
  } finally { await e.w.stop(); }
});

test('resume queues a NEW run with retry_of that the worker starts with --resume <session>, its transcript copied to the new working directory; the original then offers neither action', async () => {
  const { e, hid, capture, config } = await interruptedRun();
  try {
    const orig = e.w.state.handoffs.get(hid);
    const req = applied(e, resume(e, orig).request);
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const nid = req.result.handoff_id;
    assert.notEqual(nid, hid, 'a new run, not the old one restarted');
    const n = e.w.state.handoffs.get(nid);
    assert.equal(n.retry_of, hid);
    assert.equal(n.resume_session_id, S1);
    assert.deepEqual([n.mode, n.access, n.recipe.name, n.permissions], [orig.mode, orig.access, orig.recipe.name, orig.permissions], 'the same run, with nothing widened');
    const done = await settle(e, nid);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    const turns = fs.readFileSync(`${capture}.resume`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const args = turns[0].args;
    assert.equal(args[args.indexOf('--resume') + 1], S1);
    // Copied, never moved: the interrupted run's transcript stays where it was.
    // The fake, like Claude Code, names the folder from the cwd it sees: the worker's spelling on
    // Windows, the real path on macOS (/private/var for /var).
    const projects = path.join(config, 'projects');
    const kept = (id) => [e.home, fs.realpathSync.native(e.home)].some((home) => fs.existsSync(path.join(projects, projectDirName(path.join(home, 'handoffs', 'sandbox', id)), `${S1}.jsonl`)));
    assert.ok(kept(hid), 'the original transcript is still there');
    assert.ok(kept(nid), 'the resumed run found it under its own working directory');
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
    // Through ingress: any actor but the CLI is refused, and the CLI may resume an unscoped run.
    assert.equal(viaIngress(e, orig, 'page-edit').error.code, 'resume-refused');
    assert.equal([...e.w.state.handoffs.values()].length, 1, 'nothing was queued');
    const cli = viaIngress(e, orig, 'cli');
    assert.equal(cli.state, 'applied', JSON.stringify(cli.error));
    assert.equal(e.w.state.handoffs.get(cli.result.handoff_id).retry_of, hid);
  } finally { await e.w.stop(); }
  // Not interrupted, or interrupted before any session id was recorded: Retry, never Resume.
  assert.equal(resumeProblem({ state: 'done', session_id: S1, error: null }).code, 'run-not-resumable');
  assert.equal(resumeProblem({ state: 'failed', session_id: S1, error: { code: 'agent-exit' } }).code, 'run-not-resumable');
  assert.equal(resumeProblem({ state: 'failed', session_id: null, error: { code: 'interrupted' } }).code, 'no-session');
  assert.equal(resumeProblem({ state: 'failed', session_id: '--dangerous', error: { code: 'interrupted' } }).code, 'no-session', 'a session id that reads like an option is never passed on');
  for (const bad of ['s1', 'sess:1.x', '../5e551011-0000-4000-8000-000000000001']) assert.equal(resumeProblem({ state: 'failed', session_id: bad, error: { code: 'interrupted' } }).code, 'no-session', `${bad}: only a UUID names a session`);
  assert.equal(resumeProblem({ state: 'failed', session_id: S1, error: { code: 'interrupted' } }), null);
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
    // Owner-only (ruling R55): the writes live in possible_writes, never in uncertain_effects.
    assert.deepEqual(h.possible_writes, ['kubectl apply on stg may have run', 'mcp__atlassian__editJiraIssue on ABC-1 may have run']);
    assert.deepEqual(h.uncertain_effects, []);
    // The partial ledger is kept for the owner and the resume.
    assert.match(fs.readFileSync(ledgerOf(e, hid), 'utf8'), /kubectl apply/);
    const snap = e.w.liveSnapshot();
    const html = renderRunDetail(snap.handoffs.find((x) => x.id === hid), snap, { now: e.iso() });
    assert.match(html, /class="run-uncertain"[\s\S]*kubectl apply on stg may have run/);
    // An export, the mirror (the same sanitizer) and the vault note carry only a count.
    const exported = sanitizeSnapshot(snap, { exportedAt: e.iso(), includeCheckpoints: true, includeLinks: true });
    const out = exported.handoffs.find((x) => x.id === hid);
    assert.deepEqual(out.uncertain_effects, ['2 production writes may have run']);
    const note = renderHandoffNote(e.w.state.handoffs.get(hid), { state: e.w.state });
    assert.match(note, /- 2 production writes may have run/);
    for (const text of [JSON.stringify(exported), note]) assert.doesNotMatch(text, /kubectl apply|on stg|ABC-1|mcp__|k8s\.write|jira\.write|possible_writes/);
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
  const b = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: S2, CLAUDE_CONFIG_DIR: configRoot() } });
  const t = b.ticket(T2, 'LOCAL-b-00000002');
  b.request(RID(2), { target_id: T2, expected_revision: t.revision, payload: analyse });
  b.w.tick();
  const hid = b.w.state.requests.get(RID(2)).result.handoff_id;
  await until(() => { b.w.tick(); const h = b.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === S2; });
  fs.mkdirSync(path.dirname(ledgerOf(b, hid)), { recursive: true });
  fs.appendFileSync(ledgerOf(b, hid), guardLine({ tool_name: 'Bash', input_summary: 'kubectl apply -f deploy.yaml --context stg', class: 'write', scope: 'k8s.write', target: 'stg' }));
  await b.w.stop();
  const h = b.w.state.handoffs.get(hid);
  assert.equal(h.error.code, 'interrupted');
  assert.equal(h.session_id, S2);
  assert.deepEqual(h.possible_writes, ['kubectl apply on stg may have run']);
  assert.equal((h.uncertain_effects ?? []).some((u) => /kubectl/.test(u)), false);
});

// Critical changes (ADR 0028): a resumed approved run keeps exactly its pin and scope, or is refused.
const PINNED = 'argocd app sync pay-stg --prune';
const CHANGE = { title: 'Sync payments to staging', scope: 'argo.sync', target: 'pay-stg', action: PINNED, why: 'w', evidence: 'e', verify: 'v', rollback: 'r', risk: 'medium' };

test('resuming an approved critical-change run keeps its pin, scope, fingerprints and provenance; a changed scope is refused with scope-changed', async () => {
  const config = configRoot();
  const d = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: SC1, CLAUDE_CONFIG_DIR: config } });
  d.ticket(T1, 'PMO-7');
  d.request(RID(3), { target_id: T1, expected_revision: d.w.state.tickets.get(T1).revision, payload: { mode: 'analyse', note: 'look', permissions: NONE } });
  d.w.tick();
  const parent = d.w.state.requests.get(RID(3)).result.handoff_id;
  recordResult(d.w, parent, parseAgentResult({ text: `x\n\`\`\`json\n${JSON.stringify({ summary: 's', critical_changes: [CHANGE] })}\n\`\`\``, is_error: false, session_id: 'p1' }), { state: 'done' });
  const p = d.w.state.runProposals.get(deterministicId(`${parent}:critical:0`));
  const req = applied(d, submitRequest(d.w, { id: randomUUID(), kind: 'approve-run', target_id: p.ticket_id, expected_revision: null, payload: { proposal_id: p.id } }).request);
  assert.equal(req.state, 'applied', JSON.stringify(req.error));
  const hid = req.result.handoff_id;
  await until(() => { d.w.tick(); const h = d.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === SC1; }, { timeoutMs: 15000 });
  await d.w.stop({ flush: false, abandonRuns: true });
  const e = await restartWorker(d, { spawnEnv: { FAKE_CLAUDE_SESSION: SC1, CLAUDE_CONFIG_DIR: config }, withServer: true });
  try {
    const orig = e.w.state.handoffs.get(hid);
    assert.equal(orig.error.code, 'interrupted');
    // Ruling R56: resuming re-grants the pinned production write, so, like approving it, only the
    // owner on the dashboard may: never the CLI, nor an ingress request claiming the owner.
    for (const actor of ['cli', 'owner']) {
      const r = viaIngress(e, orig, actor);
      assert.equal(r.state, 'failed', actor);
      assert.equal(r.error.code, 'resume-dashboard-only', actor);
    }
    assert.equal(applied(e, resume(e, orig, { actor: 'cli' }).request).error.code, 'resume-dashboard-only', 'a cli actor through the worker is not the dashboard either');
    assert.equal([...e.w.state.handoffs.values()].filter((x) => x.retry_of === hid).length, 0, 'nothing was queued');
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
  const config = configRoot();
  const d = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_SLEEP_MS: '5000', FAKE_CLAUDE_SESSION: SA1, CLAUDE_CONFIG_DIR: config } });
  const t = d.ticket(T2, 'LOCAL-b-00000002');
  d.request(RID(4), { target_id: T2, expected_revision: t.revision, payload: { ...analyse, access: 'autonomous', scopes: ['argo.sync:pay-stg'] } });
  d.w.tick();
  const r0 = d.w.state.requests.get(RID(4));
  assert.equal(r0.state, 'applied', JSON.stringify(r0.error));
  const hid = r0.result.handoff_id;
  const running = await until(() => { d.w.tick(); const h = d.w.state.handoffs.get(hid); return h.state === 'running' && h.session_id === SA1 ? h : null; }, { timeoutMs: 15000 });
  assert.deepEqual(Object.keys(running.scope_fingerprints), ['argo.sync:pay-stg']);
  assert.match(running.scope_fingerprints['argo.sync:pay-stg'], /\S/);
  assert.equal(running.action_pins, undefined, 'an ordinary scoped run has no pin');
  await d.w.stop({ flush: false, abandonRuns: true });
  const e = await restartWorker(d, { spawnEnv: { CLAUDE_CONFIG_DIR: config }, withServer: true });
  try {
    const orig = e.w.state.handoffs.get(hid);
    // Ruling R56: a scoped run is resumed on the owner's dashboard only.
    for (const actor of ['cli', 'owner']) assert.equal(viaIngress(e, orig, actor).error.code, 'resume-dashboard-only', actor);
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

test('a resume whose session transcript is gone fails fast with "session not found - retry as a new run" and spawns nothing', async () => {
  const { e, hid, capture, config } = await interruptedRun();
  try {
    fs.rmSync(path.join(config, 'projects'), { recursive: true, force: true });
    const r = applied(e, resume(e, e.w.state.handoffs.get(hid)).request);
    assert.equal(r.state, 'applied', JSON.stringify(r.error));
    const failed = await settle(e, r.result.handoff_id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error.code, 'resume-session-missing');
    assert.equal(failed.error.message, SESSION_MISSING);
    assert.equal(SESSION_MISSING, 'session not found - retry as a new run');
    assert.equal(fs.existsSync(`${capture}.resume`), false, 'no runtime was started');
    assert.equal(fs.existsSync(capture), false);
  } finally { await e.w.stop(); }
});

test('carrySession copies (never moves) a UUID session into the new working directory\'s project folder, and refuses everything else', () => {
  const root = configRoot();
  const projects = path.join(root, 'projects');
  const oldCwd = path.join(root, 'work', 'handoffs', 'sandbox', 'old-run');
  const newCwd = path.join(root, 'work', 'handoffs', 'sandbox', 'new-run');
  fs.mkdirSync(newCwd, { recursive: true });
  const src = path.join(projects, projectDirName(oldCwd), `${S1}.jsonl`);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '{"type":"user"}\n');
  if (process.platform === 'win32') assert.equal(projectDirName('C:\\Users\\shiva\\.claude\\x_y'), 'C--Users-shiva--claude-x-y', 'every character outside [A-Za-z0-9] becomes -');
  else assert.equal(projectDirName('/Users/shiva/.claude/x_y'), '-Users-shiva--claude-x-y', 'every character outside [A-Za-z0-9] becomes -');
  const dests = carrySession({ configRoot: root, sessionId: S1, fromCwd: oldCwd, toCwd: newCwd });
  // The child names its folder from its cwd as the worker spelled it (Windows keeps 8.3 short names
  // such as RUNNER~1) or as its real path (macOS: /private/var for /var), so both get the copy, in
  // the real projects folder.
  const names = [...new Set([newCwd, fs.realpathSync.native(newCwd)].map(projectDirName))];
  assert.deepEqual(dests, names.map((name) => path.join(fs.realpathSync.native(projects), name, `${S1}.jsonl`)));
  const [dest] = dests;
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"type":"user"}\n');
  assert.ok(fs.existsSync(src), 'the source stays');
  // Again with the same content: nothing to do. A different transcript is never replaced.
  assert.doesNotThrow(() => carrySession({ configRoot: root, sessionId: S1, fromCwd: oldCwd, toCwd: newCwd }));
  fs.writeFileSync(dest, 'other');
  assert.throws(() => carrySession({ configRoot: root, sessionId: S1, fromCwd: oldCwd, toCwd: newCwd }), (err) => err.code === 'resume-session-conflict');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'other');
  // Only a UUID: no option, path or stream name ever reaches a file name.
  for (const bad of ['s1', '../../evil', `..\\${S1}`, `${S1}:x`, `${S1}/../../x`, '']) {
    assert.throws(() => carrySession({ configRoot: root, sessionId: bad, fromCwd: oldCwd, toCwd: newCwd }), (err) => err.code === 'no-session', bad);
  }
  assert.equal(fs.readdirSync(projects).length, 1 + names.length, 'nothing was written outside the old and new project folders');
  // A missing transcript fails with the owner-facing message.
  assert.throws(() => carrySession({ configRoot: root, sessionId: S2, fromCwd: oldCwd, toCwd: newCwd }), (err) => err.code === 'resume-session-missing' && err.message === SESSION_MISSING);
  // A source folder Claude Code shortened (a long path) is found by its one transcript of that id.
  const long = path.join(projects, `${'x'.repeat(200)}-abc123`);
  fs.mkdirSync(long, { recursive: true });
  fs.writeFileSync(path.join(long, `${S2}.jsonl`), 'long');
  const newer = path.join(root, 'work', 'n2');
  fs.mkdirSync(newer, { recursive: true });
  const [d2] = carrySession({ configRoot: root, sessionId: S2, fromCwd: path.join(root, 'y'.repeat(220)), toCwd: newer });
  assert.equal(fs.readFileSync(d2, 'utf8'), 'long');
  // A destination name Claude Code would shorten cannot be predicted: refused, not guessed.
  assert.throws(() => carrySession({ configRoot: root, sessionId: S1, fromCwd: oldCwd, toCwd: path.join(root, 'z'.repeat(220)) }), (err) => err.code === 'resume-session-unreachable');
});

test('carrySession resumes the transcript Claude Code last wrote when the old cwd has two spellings', (t) => {
  // A resumed run's cwd gets the copy under both spellings (as given, real path); its child then
  // appends to only one. Resuming THAT run again must carry the live transcript, not the copy.
  const root = configRoot();
  const projects = path.join(root, 'projects');
  fs.mkdirSync(path.join(root, 'work', 'real-run'), { recursive: true });
  const real = fs.realpathSync.native(path.join(root, 'work', 'real-run'));
  const alias = path.join(root, 'work', 'alias-run');
  if (!linkDir(real, alias)) { t.skip('this account may not create directory links'); return; }
  const newCwd = path.join(root, 'work', 'next-run');
  fs.mkdirSync(newCwd, { recursive: true });
  const write = (cwd, text, mtime) => {
    const f = path.join(projects, projectDirName(cwd), `${S1}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    fs.utimesSync(f, mtime, mtime);
  };
  for (const [stale, live] of [[alias, real], [real, alias]]) {
    fs.rmSync(projects, { recursive: true, force: true });
    write(stale, 'copy\n', new Date('2026-10-01T00:00:00Z'));
    write(live, 'copy\nturns since\n', new Date('2026-10-02T00:00:00Z'));
    const dests = carrySession({ configRoot: root, sessionId: S1, fromCwd: alias, toCwd: newCwd });
    for (const d of dests) assert.equal(fs.readFileSync(d, 'utf8'), 'copy\nturns since\n', `live under ${live === real ? 'the real path' : 'the given spelling'}`);
  }
});

test('claudeConfigRoot: CLAUDE_CONFIG_DIR, else the platform home', () => {
  assert.equal(claudeConfigRoot({ CLAUDE_CONFIG_DIR: path.resolve('/cfg'), HOME: '/h' }), path.resolve('/cfg'));
  assert.equal(claudeConfigRoot({ USERPROFILE: 'C:\\Users\\me', HOME: '/h' }, 'win32'), path.join('C:\\Users\\me', '.claude'));
  assert.equal(claudeConfigRoot({ userprofile: 'C:\\Users\\me' }, 'win32'), path.join('C:\\Users\\me', '.claude'), 'names compare case-insensitively on Windows');
  assert.equal(claudeConfigRoot({ USERPROFILE: '/u', HOME: '/h' }, 'linux'), path.join('/h', '.claude'));
});

// R54: a project folder or transcript that is a link (a symlink, or a junction on Windows, which
// lstat reports as a symbolic link) is never followed, for reading or for writing.
function linkDir(target, at) {
  try { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch (err) { if (err.code === 'EPERM' || err.code === 'ENOSYS') return false; throw err; }
}

test('carrySession never reads through a linked (junctioned) old project folder', (t) => {
  const root = configRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'st-out-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const oldCwd = path.join(root, 'work', 'old');
  const newCwd = path.join(root, 'work', 'new');
  fs.mkdirSync(newCwd, { recursive: true });
  fs.writeFileSync(path.join(outside, `${S1}.jsonl`), 'outside');
  const link = path.join(projects, projectDirName(oldCwd));
  if (!linkDir(outside, link)) { t.skip('this platform cannot create a directory link'); return; }
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'a junction reads as a link to lstat');
  assert.throws(() => carrySession({ configRoot: root, sessionId: S1, fromCwd: oldCwd, toCwd: newCwd }), (err) => err.code === 'resume-session-missing', 'the direct folder is a link');
  assert.throws(() => carrySession({ configRoot: root, sessionId: S1, fromCwd: null, toCwd: newCwd }), (err) => err.code === 'resume-session-missing', 'the search skips linked folders too');
  assert.equal(fs.existsSync(path.join(projects, projectDirName(newCwd))), false, 'nothing was copied');
});

test('carrySession never writes through a linked (junctioned) new project folder', (t) => {
  const root = configRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'st-out-'));
  const projects = path.join(root, 'projects');
  const oldCwd = path.join(root, 'work', 'old');
  const newCwd = path.join(root, 'work', 'new');
  fs.mkdirSync(newCwd, { recursive: true });
  const src = path.join(projects, projectDirName(oldCwd), `${S1}.jsonl`);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, 'transcript');
  if (!linkDir(outside, path.join(projects, projectDirName(newCwd)))) { t.skip('this platform cannot create a directory link'); return; }
  assert.throws(() => carrySession({ configRoot: root, sessionId: S1, fromCwd: oldCwd, toCwd: newCwd }), (err) => err.code === 'resume-session-unreachable');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the projects folder');
  assert.equal(fs.readFileSync(src, 'utf8'), 'transcript');
});

test('carrySession never reads a transcript that is itself a link', (t) => {
  const root = configRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'st-out-'));
  const oldCwd = path.join(root, 'work', 'old');
  const newCwd = path.join(root, 'work', 'new');
  fs.mkdirSync(newCwd, { recursive: true });
  const dir = path.join(root, 'projects', projectDirName(oldCwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.jsonl'), 'outside');
  try { fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(dir, `${S1}.jsonl`), 'file'); } catch (err) { if (err.code === 'EPERM') { t.skip('file symlinks need a privilege this account lacks'); return; } throw err; }
  assert.throws(() => carrySession({ configRoot: root, sessionId: S1, fromCwd: oldCwd, toCwd: newCwd }), (err) => err.code === 'resume-session-missing');
  assert.equal(fs.existsSync(path.join(root, 'projects', projectDirName(newCwd))), false);
});
